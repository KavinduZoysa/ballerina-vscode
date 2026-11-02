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
 * carries the run id and the stage the orchestrator set, and a stage's usage summary is the sum
 * of its steps — and what the logger must never do: write tool content, or throw.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
    describeToolError,
    MigrationDebugLogger,
    StageUsage,
    StepUsage,
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
