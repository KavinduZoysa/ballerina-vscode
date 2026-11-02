/**
 * Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com) All Rights Reserved.
 *
 * WSO2 LLC. licenses this file to you under the Apache License,
 * Version 2.0 (the "License"); you may not use this file except
 * in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * `MigrationDebugLogger` writes one migration run twice: debug.log for people, trace.jsonl for
 * `scripts/migration-trace-report.js`. These tests pin what the report relies on — every event
 * carries the run id and the stage the orchestrator set, a stage's usage summary is the sum of
 * its steps, tool calls link to the step that made them, step 1's time excludes setup, side calls
 * stay with the stage that made them — and what the logger must never do: write tool arguments
 * or content, or throw.
 *
 * `StreamTracer` is fed AI SDK `fullStream` parts the way AgentExecutor feeds them.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
    argsHash,
    attachSideCallSink,
    describeToolError,
    MigrationDebugLogger,
    reportSideCall,
    stableStringify,
    StageContext,
    StageUsage,
    StepUsage,
    StreamTracer,
    summarizeToolOutput,
} from "../features/ai/migration/debug-logger";

interface TraceEvent {
    ts: string;
    runId: string;
    type: string;
    stage?: string;
    package?: string;
    [field: string]: unknown;
}

const MIGRATION_DIR = ".ballerina-ai-migration";
const COMPLETED: StageUsage = { status: "completed", subagentUsage: {}, estimatedCostUsd: 0.01, truncationRetries: 0 };

let projectRoot: string;

beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "migration-trace-"));
});

afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(projectRoot, { recursive: true, force: true });
});

function readTrace(): TraceEvent[] {
    return fs.readFileSync(path.join(projectRoot, MIGRATION_DIR, "trace.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map(line => JSON.parse(line) as TraceEvent);
}

function readLog(): string {
    return fs.readFileSync(path.join(projectRoot, MIGRATION_DIR, "debug.log"), "utf8");
}

function step(overrides: Partial<StepUsage> = {}): StepUsage {
    return {
        attempt: 0,
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadTokens: 800,
        cacheWriteTokens: 200,
        finishReason: "tool-calls",
        toolNames: ["file_read"],
        ...overrides,
    };
}

describe("trace.jsonl", () => {
    it("tags every event with the run, and the executor's events with the stage the orchestrator set", () => {
        const logger = new MigrationDebugLogger(projectRoot, "claude-sonnet-5");
        logger.logRunStart({ packageCount: 2, loginMethod: "biIntel", entryPoint: "wizard" });
        logger.beginStage("Stage 1 — Source Inventory & Gap Analysis", "orders");
        logger.logToolCall("migration_source_list", 40, "ok, 120 chars");
        logger.logStep(step());
        logger.logStageUsage(COMPLETED);
        logger.endStage("completed");
        logger.endRun("completed");

        const events = readTrace();
        expect(events.map(e => e.type)).toEqual([
            "run_start", "stage_start", "tool", "step", "stage_usage", "stage_end", "run_end",
        ]);
        for (const event of events) {
            expect(event.runId).toBe(logger.runId);
            expect(new Date(event.ts).toISOString()).toBe(event.ts);
        }
        for (const event of events.filter(e => !e.type.startsWith("run_"))) {
            expect(event.stage).toBe("Stage 1 — Source Inventory & Gap Analysis");
            expect(event.package).toBe("orders");
        }
        expect(events[0]).toMatchObject({ model: "claude-sonnet-5", loginMethod: "biIntel", packageCount: 2, entryPoint: "wizard" });
        expect(events[events.length - 1]).not.toHaveProperty("stage");
    });

    it("gives each run its own id in the shared file", () => {
        new MigrationDebugLogger(projectRoot, "m").logRunStart({ packageCount: 1, entryPoint: "wizard" });
        new MigrationDebugLogger(projectRoot, "m").logRunStart({ packageCount: 1, entryPoint: "wizard" });

        expect(new Set(readTrace().map(e => e.runId)).size).toBe(2);
    });

    it("carries only the tool's name, duration and outcome — never its result summary", () => {
        const logger = new MigrationDebugLogger(projectRoot, "m");
        logger.logToolCall("file_read", 12, "ok, 5320 chars", true);
        logger.logToolCall("file_edit", 30, "failed, 90 chars: Error: No match found", false);

        const tools = readTrace().filter(e => e.type === "tool");
        expect(tools.map(e => Object.keys(e).sort())).toEqual([
            ["durationMs", "ok", "runId", "toolName", "ts", "type"],
            ["durationMs", "ok", "runId", "toolName", "ts", "type"],
        ]);
        expect(tools.map(e => e.ok)).toEqual([true, false]);
    });

    it("sums a stage's steps into its usage summary, and starts over for the next stage", () => {
        const logger = new MigrationDebugLogger(projectRoot, "m");
        logger.beginStage("Stage 1");
        logger.logStep(step({ inputTokens: 1000, outputTokens: 50, cacheReadTokens: 600, cacheWriteTokens: 400 }));
        logger.logStep(step({ inputTokens: 3000, outputTokens: 150, cacheReadTokens: 2400, cacheWriteTokens: 600, finishReason: "stop", toolNames: [] }));
        expect(logger.stageTotals()).toEqual({ steps: 2, inputTokens: 4000, outputTokens: 200, cacheReadTokens: 3000, cacheWriteTokens: 1000 });
        logger.logStageUsage(COMPLETED);
        logger.endStage("completed");
        logger.beginStage("Stage 2");
        logger.logStep(step({ inputTokens: 500, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 500 }));
        logger.logStageUsage(COMPLETED);
        logger.endStage("completed");

        const summaries = readTrace().filter(e => e.type === "stage_usage");
        expect(summaries[0]).toMatchObject({
            stage: "Stage 1", steps: 2, inputTokens: 4000, outputTokens: 200, cacheReadTokens: 3000,
            cacheWriteTokens: 1000, cacheHitRatio: 0.75, finishReason: "stop", partial: false,
        });
        expect(summaries[1]).toMatchObject({ stage: "Stage 2", steps: 1, inputTokens: 500, cacheHitRatio: 0 });
    });

    it("numbers steps on across a resumed turn and records which attempt each came from", () => {
        const logger = new MigrationDebugLogger(projectRoot, "m");
        logger.beginStage("Stage 2");
        logger.logStep(step({ attempt: 0 }));
        logger.logStep(step({ attempt: 0, finishReason: "length" }));
        logger.logStep(step({ attempt: 1 }));

        const steps = readTrace().filter(e => e.type === "step");
        expect(steps.map(e => [e.stepNumber, e.attempt])).toEqual([[1, 0], [2, 0], [3, 1]]);
    });

    it("times each step from the end of the previous one, the first from the stage start", () => {
        let now = 1_000;
        jest.spyOn(Date, "now").mockImplementation(() => now);
        const logger = new MigrationDebugLogger(projectRoot, "m");
        logger.beginStage("Stage 1");
        now = 1_500;
        logger.logStep(step());
        now = 2_300;
        logger.logStep(step());
        now = 2_400;
        logger.endStage("completed");

        const events = readTrace();
        expect(events.filter(e => e.type === "step").map(e => e.durationMs)).toEqual([500, 800]);
        expect(events.find(e => e.type === "stage_end")).toMatchObject({ status: "completed", durationMs: 1_400, steps: 2 });
    });

    it("writes a stage's usage summary once", () => {
        const logger = new MigrationDebugLogger(projectRoot, "m");
        logger.beginStage("Stage 1");
        logger.logStep(step());
        logger.logStageUsage({ ...COMPLETED, status: "failed" });
        logger.logStageUsage(COMPLETED);
        logger.endStage("failed");

        const summaries = readTrace().filter(e => e.type === "stage_usage");
        expect(summaries).toHaveLength(1);
        expect(summaries[0]).toMatchObject({ status: "failed" });
    });

    it("marks an aborted or failed summary partial: the SDK never reports the step in flight", () => {
        const logger = new MigrationDebugLogger(projectRoot, "m");
        logger.beginStage("Stage 1");
        logger.logStep(step());
        logger.logStageUsage({ ...COMPLETED, status: "aborted" });
        logger.endStage("aborted");

        expect(readTrace().find(e => e.type === "stage_usage")).toMatchObject({ status: "aborted", partial: true });
    });

    it("still writes the step totals, marked partial, for a stage the executor never summarized", () => {
        const logger = new MigrationDebugLogger(projectRoot, "m");
        logger.beginStage("Stage 1", "orders");
        logger.logStep(step({ inputTokens: 700 }));
        logger.logStep(step({ inputTokens: 300 }));
        logger.endStage("aborted");

        const events = readTrace();
        expect(events.map(e => e.type)).toEqual(["stage_start", "step", "step", "stage_usage", "stage_end"]);
        expect(events[3]).toMatchObject({ status: "aborted", steps: 2, inputTokens: 1000, partial: true, package: "orders" });
        expect(events[3]).not.toHaveProperty("estimatedCostUsd");
    });

    it("writes no usage summary for a stage that never reached a step", () => {
        const logger = new MigrationDebugLogger(projectRoot, "m");
        logger.beginStage("Stage 1");
        logger.endStage("failed");

        expect(readTrace().map(e => e.type)).toEqual(["stage_start", "stage_end"]);
    });
});

describe("debug.log", () => {
    it("keeps its existing lines and adds a [USAGE] line per step and a [STAGE_USAGE] line per stage", () => {
        const logger = new MigrationDebugLogger(projectRoot, "claude-sonnet-5");
        logger.logMilestone("Stage 1 — started (maxSteps: 50)");
        logger.beginStage("Stage 1", "orders");
        logger.logToolCall("file_read", 12, "ok, 5 chars");
        logger.logStep(step());
        logger.logStageUsage(COMPLETED);
        logger.endStage("completed");

        const log = readLog();
        expect(log).toMatch(/=== Enhancement Run \S+ \(model: claude-sonnet-5\) ===/);
        expect(log).toMatch(/\[MILESTONE\] Stage 1 — started \(maxSteps: 50\)/);
        expect(log).toMatch(/\[TOOL\] file_read — 12ms — ok, 5 chars/);
        expect(log).toMatch(
            /\[USAGE\] step 1 — \d+ms — in 1000 \(cache read 800, write 200\) — out 100 — finish: tool-calls — tools: file_read/
        );
        expect(log).toMatch(
            /\[STAGE_USAGE\] Stage 1 \[orders\] — completed — 1 steps — in 1000 \(cache read 800 = 80\.0%, write 200\) — out 100 — subagents: none — est\. \$0\.0100 — finish: tool-calls — truncation retries 0\n/
        );
    });
});

describe("never disrupts the run", () => {
    it("swallows every write when the log directory cannot be created", () => {
        const blocked = path.join(projectRoot, "blocked");
        fs.writeFileSync(blocked, "a file where the project directory should be");

        expect(() => {
            const logger = new MigrationDebugLogger(blocked, "m");
            logger.logRunStart({ packageCount: 1, entryPoint: "migration-panel" });
            logger.beginStage("Stage 1");
            logger.logToolCall("file_read", 1, "ok, 1 chars");
            logger.logStep(step());
            logger.logStageUsage(COMPLETED);
            logger.logError("Stage 1", new Error("boom"));
            logger.endStage("completed");
            logger.endRun("completed");
        }).not.toThrow();
        expect(fs.existsSync(path.join(blocked, MIGRATION_DIR))).toBe(false);
    });
});

describe("tool summaries", () => {
    const fileText = "configurable string apiKey = \"sk-secret\";";

    it("keep the outcome and size of a tool output, never its text", () => {
        expect(summarizeToolOutput(fileText)).toEqual({ ok: true, summary: `ok, ${fileText.length} chars` });
        expect(summarizeToolOutput({ success: true, message: fileText }).summary).not.toContain("sk-secret");
    });

    it("report a failed tool by its error code, not its message, which can preview the file", () => {
        const output = {
            success: false,
            message: `String to replace was not found in 'main.bal'.\n File Preview: \n${fileText}`,
            error: "Error: No match found",
        };

        const { ok, summary } = summarizeToolOutput(output);
        expect(ok).toBe(false);
        expect(summary).toContain("Error: No match found");
        expect(summary).not.toContain("sk-secret");
    });

    it("say so when a tool returned nothing", () => {
        expect(summarizeToolOutput(undefined)).toEqual({ ok: true, summary: "<no result>" });
    });

    it("name a thrown tool error by its class: input-validation errors quote the tool input", () => {
        expect(describeToolError(new TypeError(`Invalid input for tool file_write: ${fileText}`))).toBe("TypeError");
    });
});

describe("argsHash", () => {
    it("gives the same 12-hex hash for the same input, whatever its key order", () => {
        const input = { path: "main.bal", range: { start: 1, end: 9 }, flags: ["a", "b"] };
        const reordered = { flags: ["a", "b"], range: { end: 9, start: 1 }, path: "main.bal" };

        expect(argsHash(input)).toMatch(/^[0-9a-f]{12}$/);
        expect(argsHash(reordered)).toBe(argsHash(input));
        expect(stableStringify(reordered)).toBe('{"flags":["a","b"],"path":"main.bal","range":{"end":9,"start":1}}');
    });

    it("tells different inputs apart, array order included", () => {
        expect(argsHash({ path: "a.bal" })).not.toBe(argsHash({ path: "b.bal" }));
        expect(argsHash({ ids: [1, 2] })).not.toBe(argsHash({ ids: [2, 1] }));
    });

    it("ignores keys whose value is undefined, as JSON does", () => {
        expect(argsHash({ path: "a.bal", replaceAll: undefined })).toBe(argsHash({ path: "a.bal" }));
    });
});

describe("StreamTracer", () => {
    const fileInput = { file_path: "secret.bal", content: "configurable string apiKey = \"sk-secret\";" };
    let now: number;

    beforeEach(() => {
        now = 1_000;
        jest.spyOn(Date, "now").mockImplementation(() => now);
    });

    /** One step with one tool call, at the clock times given. */
    function runStep(tracer: StreamTracer, times: { start: number; firstToken: number; toolCall: number; toolResult: number; finish: number },
        usage: { inputTokens: number; outputTokens: number; inputTokenDetails?: Record<string, number> }, id = "call-1") {
        now = times.start;
        tracer.observe({ type: "start-step" });
        now = times.firstToken;
        tracer.observe({ type: "text-delta" });
        now = times.toolCall;
        tracer.observe({ type: "tool-call", toolCallId: id, toolName: "file_write", input: fileInput });
        now = times.toolResult;
        tracer.observe({ type: "tool-result", toolCallId: id, toolName: "file_write", input: fileInput, output: "x".repeat(1_234) });
        now = times.finish;
        tracer.observe({ type: "finish-step", finishReason: "tool-calls", usage });
    }

    it("times step 1 from the model call, not the stage start, so setup is left out", () => {
        const logger = new MigrationDebugLogger(projectRoot, "m");
        logger.beginStage("Stage 1");
        now = 4_000;
        logger.logPhase("project_source", 3_000, "setup");
        const tracer = new StreamTracer(logger);
        now = 5_000;
        tracer.beginAttempt(0);
        runStep(tracer, { start: 5_000, firstToken: 5_300, toolCall: 6_000, toolResult: 7_000, finish: 7_010 },
            { inputTokens: 1_000, outputTokens: 50, inputTokenDetails: { cacheReadTokens: 600, cacheWriteTokens: 300, noCacheTokens: 100 } });

        const step = readTrace().find(e => e.type === "step");
        expect(step).toMatchObject({
            stepNumber: 1, durationMs: 2_010, stepMs: 2_010, ttftMs: 300, modelMs: 1_000,
            inputTokens: 1_000, noCacheInputTokens: 100, toolNames: ["file_write"],
        });
        expect(readTrace().find(e => e.type === "phase")).toMatchObject({ name: "project_source", durationMs: 3_000, category: "setup" });
    });

    it("links each tool call to its step, with sizes and an argument hash", () => {
        const logger = new MigrationDebugLogger(projectRoot, "m");
        logger.beginStage("Stage 1");
        const tracer = new StreamTracer(logger);
        tracer.beginAttempt(0);
        runStep(tracer, { start: 1_000, firstToken: 1_100, toolCall: 1_200, toolResult: 1_500, finish: 1_500 }, { inputTokens: 10, outputTokens: 1 }, "call-1");
        runStep(tracer, { start: 1_600, firstToken: 1_700, toolCall: 1_800, toolResult: 2_300, finish: 2_300 }, { inputTokens: 20, outputTokens: 1 }, "call-2");

        const tools = readTrace().filter(e => e.type === "tool");
        expect(tools.map(e => [e.toolCallId, e.stepNumber, e.durationMs])).toEqual([["call-1", 1, 300], ["call-2", 2, 500]]);
        expect(tools[0]).toMatchObject({
            ok: true,
            inputChars: JSON.stringify(fileInput).length,
            outputChars: 1_234,
            argsHash: argsHash(fileInput),
        });
    });

    it("never writes tool arguments or tool output, to either file", () => {
        const logger = new MigrationDebugLogger(projectRoot, "m");
        logger.beginStage("Stage 1");
        const tracer = new StreamTracer(logger);
        tracer.beginAttempt(0);
        runStep(tracer, { start: 1_000, firstToken: 1_100, toolCall: 1_200, toolResult: 1_500, finish: 1_500 }, { inputTokens: 10, outputTokens: 1 });
        tracer.observe({ type: "tool-call", toolCallId: "call-9", toolName: "file_write", input: fileInput });
        tracer.observe({ type: "tool-error", toolCallId: "call-9", toolName: "file_write", error: new TypeError(`Invalid input: ${fileInput.content}`) });

        const written = fs.readFileSync(path.join(projectRoot, MIGRATION_DIR, "trace.jsonl"), "utf8") + readLog();
        expect(written).not.toContain("sk-secret");
        expect(written).not.toContain("secret.bal");
        expect(written).not.toContain("xxxxxxxx");
        expect(readTrace().filter(e => e.type === "tool").map(e => e.ok)).toEqual([true, false]);
    });

    it("works out the uncached input when the provider does not report it", () => {
        const logger = new MigrationDebugLogger(projectRoot, "m");
        logger.beginStage("Stage 1");
        const tracer = new StreamTracer(logger);
        tracer.observe({ type: "start-step" });
        tracer.observe({ type: "finish-step", usage: { inputTokens: 1_000, outputTokens: 5, inputTokenDetails: { cacheReadTokens: 700, cacheWriteTokens: 200 } } });

        expect(readTrace().find(e => e.type === "step")).toMatchObject({ noCacheInputTokens: 100 });
    });

    it("records a compaction block with the input before it and after it", () => {
        const logger = new MigrationDebugLogger(projectRoot, "m");
        logger.beginStage("Stage 3");
        const tracer = new StreamTracer(logger);
        tracer.observe({ type: "start-step" });
        tracer.observe({ type: "finish-step", usage: { inputTokens: 300_000, outputTokens: 10 } });
        now = 10_000;
        tracer.observe({ type: "start-step" });
        tracer.compactionStarted();
        now = 14_000;
        tracer.compactionEnded();
        tracer.observe({ type: "finish-step", usage: { inputTokens: 40_000, outputTokens: 10 } });

        const compactions = readTrace().filter(e => e.type === "compaction");
        expect(compactions).toEqual([
            expect.objectContaining({ kind: "block_start", inputTokensBefore: 300_000 }),
            expect.objectContaining({ kind: "block", durationMs: 4_000, inputTokensBefore: 300_000, inputTokensAfter: 40_000 }),
        ]);
        expect(readLog()).toMatch(/\[COMPACTION\] block — 4000ms — input before 300000 — after 40000/);
    });

    it("records tool uses the server cleared, and flushes a compaction no step followed", () => {
        const logger = new MigrationDebugLogger(projectRoot, "m");
        logger.beginStage("Stage 3");
        const tracer = new StreamTracer(logger, metadata => (metadata as { cleared?: number } | undefined)?.cleared);
        tracer.observe({ type: "start-step" });
        tracer.observe({ type: "finish-step", usage: { inputTokens: 200_000, outputTokens: 10 } });
        tracer.observe({ type: "start-step" });
        tracer.observe({ type: "finish-step", usage: { inputTokens: 90_000, outputTokens: 10 }, providerMetadata: { cleared: 7 } });
        tracer.compactionStarted();
        tracer.compactionEnded();
        tracer.finish();

        const compactions = readTrace().filter(e => e.type === "compaction");
        expect(compactions[0]).toMatchObject({ kind: "cleared_tool_uses", clearedToolUses: 7, inputTokensBefore: 200_000, inputTokensAfter: 90_000 });
        expect(compactions[compactions.length - 1]).toMatchObject({ kind: "block", inputTokensBefore: 90_000 });
        expect(compactions[compactions.length - 1]).not.toHaveProperty("inputTokensAfter");
    });

    it("never throws, whatever the stream hands it", () => {
        const tracer = new StreamTracer(new MigrationDebugLogger(path.join(projectRoot, "missing", "dir"), "m"), () => {
            throw new Error("detector failed");
        });

        expect(() => {
            tracer.observe(undefined as unknown as { type: string });
            tracer.observe({ type: "tool-result", toolCallId: "never-called" });
            tracer.observe({ type: "finish-step" });
            tracer.compactionEnded();
            tracer.finish();
        }).not.toThrow();
    });
});

describe("stage context and phases", () => {
    const context: StageContext = {
        systemPromptChars: 45_979, toolCount: 22, toolDefinitionsChars: 42_937, userMessageChars: 11_249,
        codebaseMapChars: 1_080, historyMessageCount: 0, historyChars: 2, floorTokens: 14_307,
        compactionEnabled: true, compactTriggerTokens: 500_000, effort: "xhigh", maxOutputTokens: 64_000,
        stepCap: 50, agentLimits: { maxSteps: 200, maxOutputTokens: 16_384 },
    };

    it("writes the stage's fixed context once, tagged with the stage, and a [CONTEXT] line", () => {
        const logger = new MigrationDebugLogger(projectRoot, "m");
        logger.beginStage("Stage 2", "orders");
        logger.logStageContext(context);

        expect(readTrace().find(e => e.type === "stage_context")).toMatchObject({ ...context, stage: "Stage 2", package: "orders" });
        expect(readLog()).toMatch(/\[CONTEXT\] system 45979 chars — tools 22 \/ 42937 chars — .* effort xhigh — .* step cap 50 — agentLimits \(not applied\) maxSteps 200/);
    });

    it("writes each phase with its category and a [PHASE] line", () => {
        const logger = new MigrationDebugLogger(projectRoot, "m");
        logger.beginStage("Stage 2");
        logger.logPhase("final_diagnostics", 820, "teardown");

        expect(readTrace().find(e => e.type === "phase")).toMatchObject({ name: "final_diagnostics", durationMs: 820, category: "teardown" });
        expect(readLog()).toMatch(/\[PHASE\] teardown final_diagnostics — 820ms/);
    });
});

describe("side calls", () => {
    it("stay with the stage that made them, even when they finish after it", () => {
        const logger = new MigrationDebugLogger(projectRoot, "m");
        const toolModelUsage: Record<string, { inputTokens: number; outputTokens: number }> = {};
        logger.beginStage("Stage 3", "orders");
        attachSideCallSink(toolModelUsage, logger.sideCallSink());
        logger.endStage("completed");
        logger.beginStage("Stage 4", "orders");
        reportSideCall(toolModelUsage, { source: "subagent:explore", model: "claude-sonnet-5", inputTokens: 45_077, outputTokens: 2_690, durationMs: 36_400 });

        expect(readTrace().find(e => e.type === "side_call")).toMatchObject({
            stage: "Stage 3", package: "orders", source: "subagent:explore", inputTokens: 45_077, durationMs: 36_400,
        });
        expect(readLog()).toMatch(/\[SIDE_CALL\] subagent:explore — claude-sonnet-5 — in 45077 .* — out 2690 — 36400ms — stage: Stage 3/);
    });

    it("leave the accumulator looking untouched to everything that reads it", () => {
        const toolModelUsage: Record<string, { inputTokens: number; outputTokens: number }> = {};
        attachSideCallSink(toolModelUsage, () => undefined);

        expect(Object.keys(toolModelUsage)).toEqual([]);
        expect(JSON.stringify(toolModelUsage)).toBe("{}");
    });

    it("are a no-op with no sink attached, and never throw", () => {
        const throwing: Record<string, unknown> = {};
        attachSideCallSink(throwing, () => {
            throw new Error("sink failed");
        });

        expect(() => {
            reportSideCall(undefined, { source: "followups", model: "m" });
            reportSideCall({}, { source: "followups", model: "m" });
            reportSideCall(throwing, { source: "followups", model: "m" });
        }).not.toThrow();
    });
});
