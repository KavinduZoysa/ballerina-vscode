// Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com).

// WSO2 LLC. licenses this file to you under the Apache License,
// Version 2.0 (the "License"); you may not use this file except
// in compliance with the License.
// You may obtain a copy of the License at

// http://www.apache.org/licenses/LICENSE-2.0

// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied. See the License for the
// specific language governing permissions and limitations
// under the License.

import * as fs from "fs";
import * as path from "path";
import { AsyncLocalStorage } from "async_hooks";
import { createHash, randomUUID } from "crypto";
import { AI_MIGRATION_DIR } from "./types";

const LOG_FILE_NAME = "debug.log";
const TRACE_FILE_NAME = "trace.jsonl";
/**
 * Written on run_start so the report knows what a trace can tell it. 3: steps are timed from
 * their request start, and HTTP attempts are traced. Earlier traces carry no version.
 */
export const TRACE_VERSION = 3;
const MAX_SUMMARY_LENGTH = 200;
/** Error text in trace events is capped; the full message and stack stay in debug.log. */
const MAX_TRACE_ERROR_LENGTH = 500;

export type StageStatus = "completed" | "failed" | "aborted";
export type RunStatus = "completed" | "partial" | "failed" | "aborted";
/** Setup runs before the stage's first model call; teardown after its last step. */
export type PhaseCategory = "setup" | "teardown";

export interface RunStartInfo {
    /** 1 for a single-package project. */
    packageCount: number;
    loginMethod?: string;
    entryPoint: "wizard" | "ai-chat" | "migration-panel";
}

/** One agent step as reported by the AI SDK's `finish-step` stream part. */
export interface StepUsage {
    /** 0-based `streamText` attempt; it increases when a truncated turn is resumed. */
    attempt: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    /** Input tokens that were neither read from nor written to the cache. */
    noCacheInputTokens?: number;
    finishReason?: string;
    toolNames: string[];
    /** Request start to the step's first model output. */
    ttftMs?: number;
    /** Request start to the step's last model output: the model's share of the step. */
    modelMs?: number;
    /** Request start to `finish-step`, which the SDK holds until the step's tools have returned. */
    stepMs?: number;
}

/** Token counts for the current stage, summed over the steps logged so far. */
export interface StageTotals {
    steps: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
}

/** What the executor adds to the stage's step totals when it writes the stage summary. */
export interface StageUsage {
    status: StageStatus;
    /** Tool-internal LLM usage (subagents and the like), keyed by model. */
    subagentUsage: Record<string, { inputTokens: number; outputTokens: number }>;
    estimatedCostUsd: number;
    finishReason?: string;
    truncationRetries: number;
}

/** The fixed context a stage sends with every step, and the settings it ran with. */
export interface StageContext {
    systemPromptChars: number;
    toolCount: number;
    /** Tool names, descriptions and input schemas, serialized as the model receives them. */
    toolDefinitionsChars: number;
    userMessageChars: number;
    /** Part of `userMessageChars`. */
    codebaseMapChars: number;
    historyMessageCount: number;
    historyChars: number;
    floorTokens: number;
    compactionEnabled: boolean;
    compactTriggerTokens: number;
    effort: string;
    maxOutputTokens: number;
    stepCap: number;
    /** Configured on the stage; recorded as configured whether or not the executor applies them. */
    agentLimits?: { maxSteps?: number; maxOutputTokens?: number };
}

/** A model call made outside the stage's main agent loop. */
export interface SideCall {
    /** What made the call, e.g. `subagent:<type>`, `followups`, `web_search`. */
    source: string;
    model: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    durationMs?: number;
}

export type SideCallSink = (call: SideCall) => void;

/** Links a tool event to its step, with sizes and a hash of the arguments — never their content. */
export interface ToolCallDetails {
    toolCallId?: string;
    stepNumber?: number;
    inputChars?: number;
    outputChars?: number;
    argsHash?: string;
}

/** One HTTP request to the model backend: the request line's path and sizes, never headers or bodies. */
export interface HttpAttempt {
    method?: string;
    /** URL path only: no host, query string or fragment. */
    path?: string;
    /** 1 for the first request; 2 for the retry after a token refresh. */
    attempt: number;
    /** Time spent getting the credentials (or refreshing them) before this request. */
    tokenMs?: number;
    status?: number;
    ok: boolean;
    /** Request start to response headers; the body streams on after this. */
    durationMs: number;
    requestBytes?: number;
    /** The backend's request id, for matching against its logs. */
    requestId?: string;
    /** The error's class name when the request threw. */
    error?: string;
}

export type HttpTraceSink = (attempt: HttpAttempt) => void;

const httpTraceStorage = new AsyncLocalStorage<HttpTraceSink>();

/**
 * Runs `work` with `sink` receiving every traced HTTP attempt made inside it, including by work
 * it starts that outlives it (a fire-and-forget call stays with the stage that started it).
 */
export function runWithHttpTrace<T>(sink: HttpTraceSink, work: () => T): T {
    return httpTraceStorage.run(sink, work);
}

/** The sink of the migration stage this code runs in; undefined outside migration. */
export function currentHttpTraceSink(): HttpTraceSink | undefined {
    return httpTraceStorage.getStore();
}

function requestFields(input: unknown, init: { method?: string; body?: unknown } | undefined): Pick<HttpAttempt, "method" | "path" | "requestBytes"> {
    const request = typeof input === "object" && input !== null && "url" in input ? input as { url: string; method?: string } : undefined;
    let urlPath: string | undefined;
    try {
        urlPath = new URL(request ? request.url : String(input)).pathname;
    } catch {
        urlPath = undefined;
    }
    return {
        method: init?.method ?? request?.method ?? "GET",
        path: urlPath,
        requestBytes: typeof init?.body === "string" ? Buffer.byteLength(init.body) : undefined,
    };
}

/**
 * Runs one HTTP request, reporting it to the current migration stage's sink when there is one.
 * The response, or the error, passes through unchanged.
 */
export async function tracedFetch<R extends { status: number; ok: boolean; headers: { get(name: string): string | null } }>(
    input: unknown,
    init: { method?: string; body?: unknown } | undefined,
    details: { attempt: number; tokenMs?: number },
    doFetch: () => Promise<R>,
): Promise<R> {
    const sink = currentHttpTraceSink();
    if (!sink) {
        return doFetch();
    }
    const startMs = Date.now();
    const report = (fields: Partial<HttpAttempt>) => {
        try {
            sink({ ...requestFields(input, init), ...details, ok: false, durationMs: Date.now() - startMs, ...fields });
        } catch {
            // Tracing must never affect the request.
        }
    };
    try {
        const response = await doFetch();
        let requestId: string | undefined;
        try {
            requestId = response.headers.get("request-id") ?? response.headers.get("x-request-id") ?? undefined;
        } catch {
            requestId = undefined;
        }
        report({ status: response.status, ok: response.ok, requestId });
        return response;
    } catch (error) {
        report({ error: describeToolError(error) });
        throw error;
    }
}

interface TraceScope {
    stage?: string;
    package?: string;
}

function emptyTotals(): StageTotals {
    return { steps: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/** JSON with object keys sorted at every level, so equal values serialize identically. */
export function stableStringify(value: unknown): string {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value) ?? "null";
    }
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(",")}]`;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
        .filter(key => record[key] !== undefined && typeof record[key] !== "function")
        .sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

/**
 * The first 12 hex characters of sha1 over the tool input as stable JSON: repeated identical
 * calls share a hash, and the arguments themselves are never written.
 */
export function argsHash(input: unknown): string | undefined {
    try {
        return createHash("sha1").update(stableStringify(input)).digest("hex").substring(0, 12);
    } catch {
        return undefined;
    }
}

/** Serialized size of a tool input or output: a string's length, otherwise its JSON's. */
export function serializedChars(value: unknown): number | undefined {
    if (value === undefined || value === null) {
        return 0;
    }
    try {
        return (typeof value === "string" ? value : JSON.stringify(value) ?? "").length;
    } catch {
        return undefined;
    }
}

/**
 * Summarizes a tool output for the log without its content. Tool outputs carry file contents
 * (`file_read`, `migration_source_read`, even the edit tools' failure `message`, which embeds a
 * file preview), so only the outcome, the size and a failed tool's short `error` code are kept.
 */
export function summarizeToolOutput(output: unknown): { ok: boolean; summary: string } {
    if (output === undefined || output === null) {
        return { ok: true, summary: "<no result>" };
    }
    const chars = serializedChars(output);
    const size = chars === undefined ? "size unknown" : `${chars} chars`;
    const failed = typeof output === "object" && (output as { success?: unknown }).success === false;
    if (!failed) {
        return { ok: true, summary: `ok, ${size}` };
    }
    const error = (output as { error?: unknown }).error;
    return { ok: false, summary: typeof error === "string" ? `failed, ${size}: ${error}` : `failed, ${size}` };
}

/** Names a tool's thrown error by its class only: the SDK's input-validation errors quote the tool input. */
export function describeToolError(error: unknown): string {
    return error instanceof Error ? error.name : typeof error;
}

const SIDE_CALL_SINK = Symbol("migrationSideCallSink");

/**
 * Lets code that holds only a run's `toolModelUsage` accumulator report side model calls to the
 * migration trace. The sink is a non-enumerable symbol property, invisible to everything that
 * reads the accumulator (cost totals, telemetry, JSON).
 */
export function attachSideCallSink(toolModelUsage: object, sink: SideCallSink): void {
    try {
        Object.defineProperty(toolModelUsage, SIDE_CALL_SINK, { value: sink, enumerable: false, configurable: true });
    } catch {
        // Tracing must never affect the run.
    }
}

/** Reports a side model call through the accumulator's sink; a no-op when nothing is tracing. */
export function reportSideCall(toolModelUsage: object | undefined, call: SideCall): void {
    try {
        const sink = toolModelUsage ? (toolModelUsage as { [SIDE_CALL_SINK]?: SideCallSink })[SIDE_CALL_SINK] : undefined;
        sink?.(call);
    } catch {
        // Tracing must never affect the run.
    }
}

/** The usage fields of an AI SDK `LanguageModelUsage`, as a side call reports them. */
export function sideCallUsage(usage: {
    inputTokens?: number;
    outputTokens?: number;
    inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
} | undefined): Pick<SideCall, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens"> {
    return {
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
        cacheReadTokens: usage?.inputTokenDetails?.cacheReadTokens,
        cacheWriteTokens: usage?.inputTokenDetails?.cacheWriteTokens,
    };
}

/**
 * Lightweight append-only logger that writes migration enhancement run
 * milestones and tool call summaries to `.ballerina-ai-migration/debug.log`,
 * and the same run as structured events to `.ballerina-ai-migration/trace.jsonl`
 * (one JSON object per line; `scripts/migration-trace-report.js` summarizes it).
 *
 * Multiple runs accumulate in the same files — each run begins with a
 * separator header in debug.log, and every trace event carries the run's `runId`.
 * The orchestrator marks stage boundaries with `beginStage` / `endStage`; every
 * event in between is tagged with that stage and package.
 *
 * The trace holds sizes, counts, names, durations and hashes only — never file
 * contents, prompts or tool arguments.
 *
 * All writes are synchronous and immediately flushed for crash-safety.
 * Write failures are silently swallowed so the logger never disrupts the
 * main enhancement flow.
 */
export class MigrationDebugLogger {
    /** Identifies this run's events in trace.jsonl, which accumulates across runs. */
    readonly runId: string = randomUUID();
    private readonly logFilePath: string;
    private readonly traceFilePath: string;
    private readonly modelId: string;
    private readonly runStartMs = Date.now();

    private stage: string | undefined;
    private packageName: string | undefined;
    private stageStartMs = 0;
    private lastStepEndMs = 0;
    private lastFinishReason: string | undefined;
    private lastStepInputTokens: number | undefined;
    private totals: StageTotals = emptyTotals();
    private stageUsageLogged = false;

    constructor(projectRoot: string, modelId: string) {
        const logDir = path.join(projectRoot, AI_MIGRATION_DIR);
        if (!fs.existsSync(logDir)) {
            try {
                fs.mkdirSync(logDir, { recursive: true });
            } catch {
                // If we can't create the dir, writes below will silently fail.
            }
        }
        this.logFilePath = path.join(logDir, LOG_FILE_NAME);
        this.traceFilePath = path.join(logDir, TRACE_FILE_NAME);
        this.modelId = modelId;
        this._write(`\n=== Enhancement Run ${new Date().toISOString()} (model: ${modelId}) ===`);
    }

    /** Record a high-level milestone (stage start/end, run completion, abort). */
    logMilestone(message: string): void {
        this._write(`[${this._ts()}] [MILESTONE] ${message}`);
    }

    /**
     * Record a tool call result.
     * @param toolName     Name of the tool as registered with the agent.
     * @param durationMs   Wall-clock time from tool-call to tool-result.
     * @param resultSummary Short human-readable summary of the result (max 200 chars).
     * @param ok           Whether the tool succeeded; the trace event carries this, not the summary.
     * @param details      Step link, sizes and argument hash for the trace event.
     */
    logToolCall(toolName: string, durationMs: number, resultSummary: string, ok = true, details: ToolCallDetails = {}): void {
        const safe = resultSummary ?? "<no result>";
        const summary = safe.length > MAX_SUMMARY_LENGTH
            ? safe.substring(0, MAX_SUMMARY_LENGTH) + "…"
            : safe;
        const step = details.stepNumber !== undefined ? ` — step ${details.stepNumber}` : "";
        this._write(`[${this._ts()}] [TOOL] ${toolName} — ${durationMs}ms — ${summary}${step}`);
        this._trace("tool", {
            toolName,
            durationMs,
            ok,
            toolCallId: details.toolCallId,
            stepNumber: details.stepNumber,
            inputChars: details.inputChars,
            outputChars: details.outputChars,
            argsHash: details.argsHash,
        });
    }

    /** Record an error with optional stack trace. */
    logError(context: string, error: unknown): void {
        const msg = error instanceof Error
            ? `${error.message}${error.stack ? `\n${error.stack}` : ""}`
            : String(error);
        this._write(`[${this._ts()}] [ERROR] ${context}: ${msg}`);
        const message = error instanceof Error ? error.message : String(error);
        this._trace("error", { context, message: message.substring(0, MAX_TRACE_ERROR_LENGTH) });
    }

    /** Record a timeout event (e.g. LS diagnostics timeout). */
    logTimeout(context: string, timeoutMs: number): void {
        this._write(`[${this._ts()}] [TIMEOUT] ${context} — timed out after ${timeoutMs}ms`);
    }

    /** Record the run's shape once the orchestrator knows how many packages it has. */
    logRunStart(info: RunStartInfo): void {
        this._trace("run_start", {
            traceVersion: TRACE_VERSION,
            model: this.modelId,
            loginMethod: info.loginMethod,
            packageCount: info.packageCount,
            entryPoint: info.entryPoint,
        });
    }

    /** Record how the run ended; `details` carries counts such as packages succeeded and failed. */
    endRun(status: RunStatus, details?: Record<string, number>): void {
        this._trace("run_end", { status, durationMs: Date.now() - this.runStartMs, ...details });
    }

    /**
     * Mark the start of a stage. Every event until `endStage` is tagged with this stage and
     * package, so the executor's events need no knowledge of stages.
     */
    beginStage(stage: string, packageName?: string): void {
        this.stage = stage;
        this.packageName = packageName || undefined;
        this.stageStartMs = Date.now();
        this.lastStepEndMs = this.stageStartMs;
        this.lastFinishReason = undefined;
        this.lastStepInputTokens = undefined;
        this.totals = emptyTotals();
        this.stageUsageLogged = false;
        this._trace("stage_start", {});
    }

    /**
     * Mark the end of the current stage. A stage that logged steps but never reached the
     * executor's summary still gets its step totals written, marked partial.
     */
    endStage(status: StageStatus): void {
        if (this.stage === undefined) {
            return;
        }
        if (this.totals.steps > 0 && !this.stageUsageLogged) {
            this._writeStageUsage({ status, partial: true });
        }
        this._trace("stage_end", { status, durationMs: Date.now() - this.stageStartMs, steps: this.totals.steps });
        this.stage = undefined;
        this.packageName = undefined;
    }

    /** Record the fixed context the stage sends with every step; once, before its first model call. */
    logStageContext(context: StageContext): void {
        const limits = context.agentLimits
            ? `maxSteps ${context.agentLimits.maxSteps ?? "?"} / maxOutputTokens ${context.agentLimits.maxOutputTokens ?? "?"}`
            : "none";
        this._write(
            `[${this._ts()}] [CONTEXT] system ${context.systemPromptChars} chars — ` +
            `tools ${context.toolCount} / ${context.toolDefinitionsChars} chars — ` +
            `user ${context.userMessageChars} chars (codebase map ${context.codebaseMapChars}) — ` +
            `history ${context.historyMessageCount} msgs / ${context.historyChars} chars — floor ~${context.floorTokens} tokens — ` +
            `compaction ${context.compactionEnabled ? `at ${context.compactTriggerTokens}` : "off"} — effort ${context.effort} — ` +
            `max output ${context.maxOutputTokens} — step cap ${context.stepCap} — agentLimits (not applied) ${limits}`
        );
        this._trace("stage_context", { ...context });
    }

    /** Record a timed setup or teardown phase of the current stage. */
    logPhase(name: string, durationMs: number, category: PhaseCategory): void {
        this._write(`[${this._ts()}] [PHASE] ${category} ${name} — ${durationMs}ms`);
        this._trace("phase", { name, durationMs, category });
    }

    /**
     * Called right before each `streamText`: the next step's duration then counts from the model
     * call, not from the stage start, so step 1 excludes setup.
     */
    markModelStart(): void {
        this.lastStepEndMs = Date.now();
    }

    /** The cumulative number the next logged step will get, for linking tool calls to it. */
    nextStepNumber(): number {
        return this.totals.steps + 1;
    }

    /** Input tokens of the last logged step in the current stage. */
    lastStepInput(): number | undefined {
        return this.lastStepInputTokens;
    }

    /** Record one finished agent step and add it to the current stage's totals. */
    logStep(step: StepUsage): void {
        const now = Date.now();
        const durationMs = now - this.lastStepEndMs;
        this.lastStepEndMs = now;
        this.lastFinishReason = step.finishReason;
        this.lastStepInputTokens = step.inputTokens;
        const totals = this.totals;
        totals.steps++;
        totals.inputTokens += step.inputTokens;
        totals.outputTokens += step.outputTokens;
        totals.cacheReadTokens += step.cacheReadTokens;
        totals.cacheWriteTokens += step.cacheWriteTokens;

        const toolNames = step.toolNames ?? [];
        const attemptNote = step.attempt > 0 ? ` (attempt ${step.attempt})` : "";
        const tools = toolNames.length > 0 ? toolNames.join(", ") : "none";
        const latency = step.ttftMs !== undefined || step.modelMs !== undefined
            ? ` — ttft ${step.ttftMs ?? "?"}ms, model ${step.modelMs ?? "?"}ms`
            : "";
        this._write(
            `[${this._ts()}] [USAGE] step ${totals.steps}${attemptNote} — ${durationMs}ms — ` +
            `in ${step.inputTokens} (cache read ${step.cacheReadTokens}, write ${step.cacheWriteTokens}) — ` +
            `out ${step.outputTokens} — finish: ${step.finishReason ?? "unknown"} — tools: ${tools}${latency}`
        );
        this._trace("step", {
            stepNumber: totals.steps,
            attempt: step.attempt,
            durationMs,
            stepMs: step.stepMs,
            ttftMs: step.ttftMs,
            modelMs: step.modelMs,
            inputTokens: step.inputTokens,
            outputTokens: step.outputTokens,
            cacheReadTokens: step.cacheReadTokens,
            cacheWriteTokens: step.cacheWriteTokens,
            noCacheInputTokens: step.noCacheInputTokens,
            finishReason: step.finishReason,
            toolNames,
        });
    }

    /** Record a compaction event: a compaction block, or tool uses the server cleared. */
    logCompaction(fields: {
        kind: "block_start" | "block" | "cleared_tool_uses";
        durationMs?: number;
        clearedToolUses?: number;
        inputTokensBefore?: number;
        inputTokensAfter?: number;
    }): void {
        const parts: string[] = [fields.kind];
        if (fields.durationMs !== undefined) { parts.push(`${fields.durationMs}ms`); }
        if (fields.clearedToolUses !== undefined) { parts.push(`${fields.clearedToolUses} tool uses cleared`); }
        parts.push(`input before ${fields.inputTokensBefore ?? "?"}`);
        if (fields.kind !== "block_start") { parts.push(`after ${fields.inputTokensAfter ?? "?"}`); }
        this._write(`[${this._ts()}] [COMPACTION] ${parts.join(" — ")}`);
        this._trace("compaction", { ...fields });
    }

    /**
     * Record a model call made outside the main agent loop. `scope` pins it to the stage that
     * made it, for calls that finish after that stage ended.
     */
    logSideCall(call: SideCall, scope?: TraceScope): void {
        const where = scope ? scope : { stage: this.stage, package: this.packageName };
        this._write(
            `[${this._ts()}] [SIDE_CALL] ${call.source} — ${call.model} — ` +
            `in ${call.inputTokens ?? "?"} (cache read ${call.cacheReadTokens ?? "?"}, write ${call.cacheWriteTokens ?? "?"}) — ` +
            `out ${call.outputTokens ?? "?"} — ${call.durationMs ?? "?"}ms — stage: ${where.stage ?? "(none)"}`
        );
        this._trace("side_call", { ...call }, where);
    }

    /** A sink that reports side calls against the current stage, even if they finish after it. */
    sideCallSink(): SideCallSink {
        const scope = { stage: this.stage, package: this.packageName };
        return call => this.logSideCall(call, scope);
    }

    /** Record one HTTP attempt; `scope` pins it to the stage that made it, as for side calls. */
    logHttp(attempt: HttpAttempt, scope?: TraceScope): void {
        const where = scope ? scope : { stage: this.stage, package: this.packageName };
        const outcome = attempt.error ? `threw ${attempt.error}` : `status ${attempt.status ?? "?"}`;
        const token = attempt.tokenMs !== undefined ? ` — token ${attempt.tokenMs}ms` : "";
        this._write(
            `[${this._ts()}] [HTTP] ${attempt.method ?? "?"} ${attempt.path ?? "?"} — attempt ${attempt.attempt} — ` +
            `${outcome} — ${attempt.durationMs}ms to headers${token} — ${attempt.requestBytes ?? "?"} bytes` +
            `${attempt.requestId ? ` — request ${attempt.requestId}` : ""} — stage: ${where.stage ?? "(none)"}`
        );
        this._trace("http", { ...attempt }, where);
    }

    /** A sink for `runWithHttpTrace` that reports HTTP attempts against the current stage. */
    httpSink(): HttpTraceSink {
        const scope = { stage: this.stage, package: this.packageName };
        return attempt => this.logHttp(attempt, scope);
    }

    /** The current stage's totals so far, for the executor's cost estimate. */
    stageTotals(): StageTotals {
        return { ...this.totals };
    }

    /**
     * Record the stage's usage summary: the step totals plus what only the executor knows.
     * Written once per stage; a later call is ignored.
     */
    logStageUsage(usage: StageUsage): void {
        if (this.stageUsageLogged) {
            return;
        }
        this._writeStageUsage(usage);
    }

    private _writeStageUsage(usage: Partial<StageUsage> & { status: StageStatus; partial?: boolean }): void {
        this.stageUsageLogged = true;
        const totals = this.totals;
        // The SDK reports no usage for the step in flight when a stage aborts or fails.
        const partial = usage.partial || usage.status !== "completed";
        const finishReason = usage.finishReason ?? this.lastFinishReason;
        const cacheHitRatio = totals.inputTokens > 0
            ? Math.round(totals.cacheReadTokens / totals.inputTokens * 10_000) / 10_000
            : 0;
        const subagents = Object.entries(usage.subagentUsage ?? {})
            .map(([model, u]) => `${model} in ${u.inputTokens} / out ${u.outputTokens}`)
            .join("; ") || "none";
        const cost = usage.estimatedCostUsd !== undefined ? `$${usage.estimatedCostUsd.toFixed(4)}` : "n/a";
        const where = this.packageName ? `${this.stage} [${this.packageName}]` : `${this.stage ?? "(no stage)"}`;
        this._write(
            `[${this._ts()}] [STAGE_USAGE] ${where} — ${usage.status} — ${totals.steps} steps — ` +
            `in ${totals.inputTokens} (cache read ${totals.cacheReadTokens} = ${(cacheHitRatio * 100).toFixed(1)}%, ` +
            `write ${totals.cacheWriteTokens}) — out ${totals.outputTokens} — subagents: ${subagents} — est. ${cost} — ` +
            `finish: ${finishReason ?? "unknown"} — truncation retries ${usage.truncationRetries ?? 0}` +
            (partial ? " — partial (excludes the step in flight)" : "")
        );
        this._trace("stage_usage", {
            status: usage.status,
            steps: totals.steps,
            inputTokens: totals.inputTokens,
            outputTokens: totals.outputTokens,
            cacheReadTokens: totals.cacheReadTokens,
            cacheWriteTokens: totals.cacheWriteTokens,
            cacheHitRatio,
            subagentUsage: usage.subagentUsage,
            estimatedCostUsd: usage.estimatedCostUsd,
            finishReason,
            truncationRetries: usage.truncationRetries,
            partial,
        });
    }

    private _ts(): string {
        return new Date().toISOString();
    }

    private _write(line: string): void {
        try {
            fs.appendFileSync(this.logFilePath, line + "\n", "utf8");
        } catch {
            // Non-critical — swallow write errors silently.
        }
    }

    private _trace(type: string, fields: Record<string, unknown>, scope?: TraceScope): void {
        try {
            const event = {
                ts: this._ts(),
                runId: this.runId,
                type,
                stage: scope ? scope.stage : this.stage,
                package: scope ? scope.package : this.packageName,
                ...fields,
            };
            fs.appendFileSync(this.traceFilePath, JSON.stringify(event) + "\n", "utf8");
        } catch {
            // Non-critical — swallow write errors silently.
        }
    }
}

/** The fields of the AI SDK stream parts the tracer reads; any other part passes through. */
interface StreamPartLike {
    type: string;
    id?: string;
    toolCallId?: string;
    toolName?: string;
    input?: unknown;
    output?: unknown;
    error?: unknown;
    finishReason?: string;
    providerMetadata?: unknown;
    usage?: {
        inputTokens?: number;
        outputTokens?: number;
        inputTokenDetails?: { noCacheTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
    };
}

interface PendingToolCall {
    startMs: number;
    stepNumber: number;
    inputChars?: number;
    argsHash?: string;
}

/** Stream parts that are the model's own output, for time-to-first-token and model time. */
const MODEL_OUTPUT_PARTS = new Set([
    "text-start", "text-delta", "text-end",
    "reasoning-start", "reasoning-delta", "reasoning-end",
    "tool-input-start", "tool-input-delta", "tool-input-end",
    "tool-call",
]);

/**
 * Turns one executor run's `fullStream` parts into trace events: per-step latency (time to first
 * token, model time), tool calls linked to their step with sizes and an argument hash, and
 * compaction. The executor feeds it every part with `observe`; every method swallows its own
 * errors, so tracing can never break the stream loop.
 *
 * Steps are logged from the consumer side of the stream (`finish-step`), not `onStepFinish`, so
 * a step is always logged after its own tool events and before the next step's.
 *
 * Steps are timed from their request start (`markRequestStart`, from `prepareStep`), not from
 * `start-step`: the SDK emits `start-step` with the response's first chunk, so timing from it
 * would leave out the wait for the model to start answering.
 */
export class StreamTracer {
    private attempt = 0;
    private stepNumber = 0;
    /**
     * Request starts not yet matched to a `start-step`, oldest first. The SDK can start the next
     * request before the stream reader has seen the previous step finish.
     */
    private readonly requestStarts: number[] = [];
    private stepStartMs: number | undefined;
    private firstOutputMs: number | undefined;
    private lastOutputMs: number | undefined;
    private stepToolNames: string[] = [];
    private readonly pendingTools = new Map<string, PendingToolCall>();
    private compactionStart: { startMs: number; inputTokensBefore?: number } | undefined;
    private compactionAwaitingAfter: { durationMs: number; inputTokensBefore?: number } | undefined;

    /**
     * @param logger           The run's logger.
     * @param clearedToolUses  Reads how many tool uses the server cleared from a step's provider metadata.
     */
    constructor(
        private readonly logger: MigrationDebugLogger,
        private readonly clearedToolUses: (providerMetadata: unknown) => number | undefined = () => undefined,
    ) { }

    /** Call right before each `streamText`; marks the model start so step 1 excludes setup. */
    beginAttempt(attempt: number): void {
        try {
            this.attempt = attempt;
            // A previous attempt's unmatched request starts belong to steps that never streamed.
            this.requestStarts.length = 0;
            this.logger.markModelStart();
        } catch {
            // Tracing must never affect the run.
        }
    }

    /** Call from `prepareStep`, which the SDK runs right before sending each step's request. */
    markRequestStart(): void {
        try {
            this.requestStarts.push(Date.now());
        } catch {
            // Tracing must never affect the run.
        }
    }

    /** Feed every `fullStream` part, before the loop handles it. */
    observe(part: StreamPartLike): void {
        try {
            const now = Date.now();
            if (MODEL_OUTPUT_PARTS.has(part.type)) {
                this.firstOutputMs ??= now;
                this.lastOutputMs = now;
            }
            switch (part.type) {
                case "start-step":
                    this.stepNumber = this.logger.nextStepNumber();
                    // Arrives with the response's first chunk; the step began when its request went out.
                    this.stepStartMs = this.requestStarts.shift() ?? now;
                    this.firstOutputMs = undefined;
                    this.lastOutputMs = undefined;
                    this.stepToolNames = [];
                    break;
                case "tool-call":
                    this.stepToolNames.push(part.toolName ?? "unknown");
                    this.pendingTools.set(part.toolCallId ?? "", {
                        startMs: now,
                        stepNumber: this.stepNumber,
                        inputChars: serializedChars(part.input),
                        argsHash: argsHash(part.input),
                    });
                    break;
                case "tool-result": {
                    const { ok, summary } = summarizeToolOutput(part.output);
                    this.finishTool(part, now, ok, summary, serializedChars(part.output));
                    break;
                }
                case "tool-error":
                    this.finishTool(part, now, false, `failed (threw ${describeToolError(part.error)})`, undefined);
                    break;
                case "finish-step":
                    this.finishStep(part, now);
                    break;
            }
        } catch {
            // Tracing must never affect the run.
        }
    }

    /** A compaction block started streaming. */
    compactionStarted(): void {
        try {
            const inputTokensBefore = this.logger.lastStepInput();
            this.compactionStart = { startMs: Date.now(), inputTokensBefore };
            this.logger.logCompaction({ kind: "block_start", inputTokensBefore });
        } catch {
            // Tracing must never affect the run.
        }
    }

    /**
     * The compaction block ended. Its event waits for the next finished step, whose input tokens
     * show what the compaction left.
     */
    compactionEnded(): void {
        try {
            if (!this.compactionStart) {
                return;
            }
            this.compactionAwaitingAfter = {
                durationMs: Date.now() - this.compactionStart.startMs,
                inputTokensBefore: this.compactionStart.inputTokensBefore,
            };
            this.compactionStart = undefined;
        } catch {
            // Tracing must never affect the run.
        }
    }

    /** Writes a compaction still waiting for a following step; call when the run stops streaming. */
    finish(): void {
        try {
            if (this.compactionAwaitingAfter) {
                this.logger.logCompaction({ kind: "block", ...this.compactionAwaitingAfter });
                this.compactionAwaitingAfter = undefined;
            }
        } catch {
            // Tracing must never affect the run.
        }
    }

    private finishTool(part: StreamPartLike, now: number, ok: boolean, summary: string, outputChars: number | undefined): void {
        const toolCallId = part.toolCallId ?? "";
        const pending = this.pendingTools.get(toolCallId);
        if (!pending) {
            return;
        }
        this.pendingTools.delete(toolCallId);
        this.logger.logToolCall(part.toolName ?? "unknown", now - pending.startMs, summary, ok, {
            toolCallId,
            stepNumber: pending.stepNumber,
            inputChars: pending.inputChars,
            outputChars,
            argsHash: pending.argsHash,
        });
    }

    private finishStep(part: StreamPartLike, now: number): void {
        const usage = part.usage ?? {};
        const inputTokens = usage.inputTokens || 0;
        const cacheReadTokens = usage.inputTokenDetails?.cacheReadTokens || 0;
        const cacheWriteTokens = usage.inputTokenDetails?.cacheWriteTokens || 0;
        const inputTokensBefore = this.logger.lastStepInput();
        const start = this.stepStartMs;
        this.logger.logStep({
            attempt: this.attempt,
            inputTokens,
            outputTokens: usage.outputTokens || 0,
            cacheReadTokens,
            cacheWriteTokens,
            noCacheInputTokens: usage.inputTokenDetails?.noCacheTokens
                ?? Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens),
            finishReason: part.finishReason,
            toolNames: this.stepToolNames,
            ttftMs: start !== undefined && this.firstOutputMs !== undefined ? this.firstOutputMs - start : undefined,
            modelMs: start !== undefined && this.lastOutputMs !== undefined ? this.lastOutputMs - start : undefined,
            stepMs: start !== undefined ? now - start : undefined,
        });

        let cleared: number | undefined;
        try {
            cleared = this.clearedToolUses(part.providerMetadata);
        } catch {
            cleared = undefined;
        }
        if (cleared) {
            this.logger.logCompaction({ kind: "cleared_tool_uses", clearedToolUses: cleared, inputTokensBefore, inputTokensAfter: inputTokens });
        }
        if (this.compactionAwaitingAfter) {
            this.logger.logCompaction({ kind: "block", ...this.compactionAwaitingAfter, inputTokensAfter: inputTokens });
            this.compactionAwaitingAfter = undefined;
        }
        this.stepStartMs = undefined;
        this.stepToolNames = [];
    }
}
