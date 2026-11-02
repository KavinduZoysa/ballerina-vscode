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
import { randomUUID } from "crypto";
import { AI_MIGRATION_DIR } from "./types";

const LOG_FILE_NAME = "debug.log";
const TRACE_FILE_NAME = "trace.jsonl";
const MAX_SUMMARY_LENGTH = 200;
/** Error text in trace events is capped; the full message and stack stay in debug.log. */
const MAX_TRACE_ERROR_LENGTH = 500;

export type StageStatus = "completed" | "failed" | "aborted";
export type RunStatus = "completed" | "partial" | "failed" | "aborted";

export interface RunStartInfo {
    /** 1 for a single-package project. */
    packageCount: number;
    loginMethod?: string;
    entryPoint: "wizard" | "ai-chat" | "migration-panel";
}

/** One agent step as reported by the AI SDK's `onStepFinish`. */
export interface StepUsage {
    /** 0-based `streamText` attempt; it increases when a truncated turn is resumed. */
    attempt: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    finishReason?: string;
    toolNames: string[];
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

function emptyTotals(): StageTotals {
    return { steps: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
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
    let size: string;
    try {
        size = `${(typeof output === "string" ? output : JSON.stringify(output) ?? "").length} chars`;
    } catch {
        size = "size unknown";
    }
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
     * @param ok           Whether the tool succeeded; the trace event carries only this, not the summary.
     */
    logToolCall(toolName: string, durationMs: number, resultSummary: string, ok = true): void {
        const safe = resultSummary ?? "<no result>";
        const summary = safe.length > MAX_SUMMARY_LENGTH
            ? safe.substring(0, MAX_SUMMARY_LENGTH) + "…"
            : safe;
        this._write(`[${this._ts()}] [TOOL] ${toolName} — ${durationMs}ms — ${summary}`);
        this._trace("tool", { toolName, durationMs, ok });
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

    /** Record one finished agent step and add it to the current stage's totals. */
    logStep(step: StepUsage): void {
        const now = Date.now();
        const durationMs = now - this.lastStepEndMs;
        this.lastStepEndMs = now;
        this.lastFinishReason = step.finishReason;
        const totals = this.totals;
        totals.steps++;
        totals.inputTokens += step.inputTokens;
        totals.outputTokens += step.outputTokens;
        totals.cacheReadTokens += step.cacheReadTokens;
        totals.cacheWriteTokens += step.cacheWriteTokens;

        const toolNames = step.toolNames ?? [];
        const attemptNote = step.attempt > 0 ? ` (attempt ${step.attempt})` : "";
        const tools = toolNames.length > 0 ? toolNames.join(", ") : "none";
        this._write(
            `[${this._ts()}] [USAGE] step ${totals.steps}${attemptNote} — ${durationMs}ms — ` +
            `in ${step.inputTokens} (cache read ${step.cacheReadTokens}, write ${step.cacheWriteTokens}) — ` +
            `out ${step.outputTokens} — finish: ${step.finishReason ?? "unknown"} — tools: ${tools}`
        );
        this._trace("step", {
            stepNumber: totals.steps,
            attempt: step.attempt,
            durationMs,
            inputTokens: step.inputTokens,
            outputTokens: step.outputTokens,
            cacheReadTokens: step.cacheReadTokens,
            cacheWriteTokens: step.cacheWriteTokens,
            finishReason: step.finishReason,
            toolNames,
        });
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

    private _trace(type: string, fields: Record<string, unknown>): void {
        try {
            const event = {
                ts: this._ts(),
                runId: this.runId,
                type,
                stage: this.stage,
                package: this.packageName,
                ...fields,
            };
            fs.appendFileSync(this.traceFilePath, JSON.stringify(event) + "\n", "utf8");
        } catch {
            // Non-critical — swallow write errors silently.
        }
    }
}
