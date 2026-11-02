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
 * `scripts/migration-trace-report.js` turns a migration trace.jsonl into per-stage numbers.
 *
 * `buildTrace` is in the first trace format — no phases, stage context, per-step latency, tool
 * sizes or side calls — so it also pins that older traces still parse and report. Its latest run
 * is a two-package workspace covering parallel tool calls (tool time counts them once), a stage
 * without a usage summary (tokens come from its steps), a stage that hit the executor's 50-step
 * cap in one attempt, one that took more than 50 steps only across attempts, and a torn line.
 *
 * `buildNewTrace` is in the current format: two runs of one stage, the second at a lower effort,
 * whose first run trips every flag — cache miss, long gap, repeated call, large output, truncation.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const report = require("../../scripts/migration-trace-report");

const T0 = Date.parse("2026-10-29T10:00:00.000Z");

function event(runId: string, atMs: number, type: string, fields: Record<string, unknown> = {}): string {
    return JSON.stringify({ ts: new Date(T0 + atMs).toISOString(), runId, type, ...fields });
}

/** Events of one stage, tagged the way MigrationDebugLogger tags them. */
function inStage(runId: string, stage: string, pkg?: string) {
    return (atMs: number, type: string, fields: Record<string, unknown> = {}) =>
        event(runId, atMs, type, { stage, package: pkg, ...fields });
}

function steps(at: ReturnType<typeof inStage>, fromMs: number, count: number, attempt: number): string[] {
    return Array.from({ length: count }, (_, i) => at(fromMs + i * 10, "step", {
        stepNumber: i + 1, attempt, durationMs: 10, inputTokens: 100, outputTokens: 10,
        cacheReadTokens: 50, cacheWriteTokens: 50, finishReason: "tool-calls", toolNames: [],
    }));
}

function buildTrace(): string {
    const old = inStage("run-old", "Stage 1 — Source Inventory & Gap Analysis");
    const ordersInventory = inStage("run-new", "Stage 1 — Source Inventory & Gap Analysis", "orders");
    const ordersFidelity = inStage("run-new", "Stage 2 — Source-First Fidelity Implementation", "orders");
    const billingInventory = inStage("run-new", "Stage 1 — Source Inventory & Gap Analysis", "billing");
    const workspace = inStage("run-new", "Cross-Package Workspace Validation");

    return [
        event("run-old", 0, "run_start", { model: "claude-sonnet-5", packageCount: 1, entryPoint: "migration-panel" }),
        old(10, "stage_start"),
        old(1_010, "stage_end", { status: "completed", durationMs: 1_000, steps: 0 }),
        event("run-old", 1_020, "run_end", { status: "completed", durationMs: 1_020 }),

        event("run-new", 60_000, "run_start", { model: "claude-sonnet-5", loginMethod: "biIntel", packageCount: 2, entryPoint: "wizard" }),

        // Two parallel calls overlap from 1.5s to 3s; the tools cover 3,150 ms of this 10 s stage.
        ordersInventory(60_000, "stage_start"),
        ordersInventory(63_000, "tool", { toolName: "getCompilationErrors", durationMs: 2_000, ok: true }),
        ordersInventory(63_500, "tool", { toolName: "file_read", durationMs: 2_000, ok: true }),
        ordersInventory(64_000, "tool", { toolName: "migration_source_read", durationMs: 100, ok: true }),
        ordersInventory(65_000, "tool", { toolName: "runTests", durationMs: 50, ok: false }),
        ordersInventory(69_000, "tool", { toolName: "file_read", durationMs: 500, ok: true }),
        ordersInventory(64_100, "step", { stepNumber: 1, attempt: 0, durationMs: 4_100, inputTokens: 1_000, outputTokens: 50, cacheReadTokens: 600, cacheWriteTokens: 400 }),
        ordersInventory(69_500, "step", { stepNumber: 2, attempt: 0, durationMs: 5_400, inputTokens: 3_000, outputTokens: 150, cacheReadTokens: 2_400, cacheWriteTokens: 600 }),
        ordersInventory(69_900, "stage_usage", {
            status: "completed", steps: 2, inputTokens: 4_000, outputTokens: 200, cacheReadTokens: 3_000,
            cacheWriteTokens: 1_000, cacheHitRatio: 0.75, subagentUsage: {}, estimatedCostUsd: 0.02,
            finishReason: "stop", truncationRetries: 0, partial: false,
        }),
        ordersInventory(70_000, "stage_end", { status: "completed", durationMs: 10_000, steps: 2 }),
        "{\"ts\":\"2026-10-29T10:01:10.000Z\",\"runId\":\"run-ne",

        ordersFidelity(70_100, "stage_start"),
        ...steps(ordersFidelity, 70_110, 50, 0),
        ordersFidelity(75_200, "stage_usage", {
            status: "completed", steps: 50, inputTokens: 5_000, outputTokens: 500, cacheReadTokens: 2_500,
            cacheWriteTokens: 2_500, cacheHitRatio: 0.5, subagentUsage: {}, estimatedCostUsd: 0.01,
            finishReason: "tool-calls", truncationRetries: 0, partial: false,
        }),
        ordersFidelity(75_300, "stage_end", { status: "completed", durationMs: 5_200, steps: 50 }),

        // Aborted with no usage summary: its tokens come from the three steps.
        billingInventory(76_000, "stage_start"),
        ...steps(billingInventory, 76_010, 3, 0),
        billingInventory(80_000, "stage_end", { status: "aborted", durationMs: 4_000, steps: 3 }),

        // 55 steps, but no single attempt reached the cap.
        workspace(81_000, "stage_start"),
        ...steps(workspace, 81_010, 30, 0),
        ...steps(workspace, 81_400, 25, 1),
        workspace(89_900, "stage_usage", {
            status: "completed", steps: 55, inputTokens: 5_500, outputTokens: 550, cacheReadTokens: 2_750,
            cacheWriteTokens: 2_750, cacheHitRatio: 0.5, subagentUsage: {}, estimatedCostUsd: 0.03,
            finishReason: "stop", truncationRetries: 1, partial: false,
        }),
        workspace(90_000, "stage_end", { status: "completed", durationMs: 9_000, steps: 55 }),

        event("run-new", 90_500, "run_end", { status: "partial", durationMs: 30_500, packagesSucceeded: 1, packagesFailed: 1 }),
    ].join("\n") + "\n";
}

function latestRunRows() {
    const { runs } = report.parseTrace(buildTrace());
    return report.summarizeRun(runs[runs.length - 1]).stages;
}

describe("parseTrace", () => {
    it("groups events by run in the order runs appear and skips a torn line", () => {
        const { runs, malformed } = report.parseTrace(buildTrace());

        expect(runs.map((run: { runId: string }) => run.runId)).toEqual(["run-old", "run-new"]);
        expect(malformed).toBe(1);
    });
});

describe("summarizeRun", () => {
    it("reports the run header from run_start and run_end", () => {
        const { runs } = report.parseTrace(buildTrace());

        expect(report.summarizeRun(runs[1])).toMatchObject({
            model: "claude-sonnet-5", loginMethod: "biIntel", entryPoint: "wizard", packageCount: 2,
            status: "partial", durationMs: 30_500, packagesSucceeded: 1, packagesFailed: 1,
        });
    });

    it("counts overlapping tool calls once, and gives the rest of the stage to the model", () => {
        const [inventory] = latestRunRows();

        expect(inventory).toMatchObject({ wallMs: 10_000, toolMs: 3_150, modelMs: 6_850, steps: 2 });
    });

    it("takes a stage's tokens and cost from its usage summary", () => {
        const [inventory] = latestRunRows();

        expect(inventory).toMatchObject({
            inputTokens: 4_000, outputTokens: 200, cacheReadTokens: 3_000, cacheWriteTokens: 1_000,
            cacheHitPct: 75, estimatedCostUsd: 0.02, partial: false, tokensFromSteps: false,
        });
    });

    it("adds up the steps of a stage without a usage summary, and marks it partial", () => {
        const billing = latestRunRows()[2];

        expect(billing).toMatchObject({
            package: "billing", status: "aborted", inputTokens: 300, outputTokens: 30,
            cacheReadTokens: 150, cacheWriteTokens: 150, estimatedCostUsd: undefined,
            partial: true, tokensFromSteps: true,
        });
    });

    it("flags a stage that reached 50 steps in one attempt, not one that passed 50 across attempts", () => {
        const rows = latestRunRows();

        expect(rows.map((row: { stage: string; hitStepCap: boolean }) => [row.stage, row.hitStepCap])).toEqual([
            ["Stage 1 — Source Inventory & Gap Analysis", false],
            ["Stage 2 — Source-First Fidelity Implementation", true],
            ["Stage 1 — Source Inventory & Gap Analysis", false],
            ["Cross-Package Workspace Validation", false],
        ]);
    });

    it("ranks a stage's three slowest tool types by total time", () => {
        const [inventory] = latestRunRows();

        expect(inventory.slowestTools).toEqual([
            { toolName: "file_read", calls: 2, totalMs: 2_500 },
            { toolName: "getCompilationErrors", calls: 1, totalMs: 2_000 },
            { toolName: "migration_source_read", calls: 1, totalMs: 100 },
        ]);
    });
});

describe("unionMs", () => {
    it("counts time covered by several intervals once", () => {
        expect(report.unionMs([[0, 10], [5, 15], [20, 30], [22, 25]])).toBe(25);
        expect(report.unionMs([])).toBe(0);
    });
});

describe("older traces", () => {
    it("still report, with the columns they lack left empty and the model time approximated", () => {
        const [inventory] = latestRunRows();

        expect(inventory).toMatchObject({
            modelMeasured: false, setupMs: undefined, teardownMs: undefined, otherMs: undefined,
            fixedContextTokens: undefined, fixedTimesSteps: undefined, sideCalls: [],
        });
    });

    it("group a multi-package run by package and note the cap, partial totals and slowest tools", () => {
        const { runs } = report.parseTrace(buildTrace());
        const text: string = report.formatTable([report.summarizeRun(runs[1])]);

        expect(text.indexOf("Package orders")).toBeLessThan(text.indexOf("Package billing"));
        expect(text.indexOf("Package billing")).toBeLessThan(text.indexOf("Workspace\n"));
        expect(text).toContain("slowest tools: file_read 2× 2.5s, getCompilationErrors 1× 2.0s, migration_source_read 1× 100ms");
        expect(text).toContain("! reached 50 steps in one attempt");
        expect(text).toContain("* no stage_usage event: tokens summed from step events");
        expect(text).toContain("* no per-step model time in this trace");
        expect(text).toMatch(/Total\s+28\.2s\s+—\s+≈25\.\ds\s+3\.1s/);
    });

    it("write one CSV row per stage, the new columns empty", () => {
        const { runs } = report.parseTrace(buildTrace());
        const lines: string[] = report.formatCsv([report.summarizeRun(runs[1])]).trim().split("\n");

        expect(lines[0]).toBe(
            "run_id,package,stage,status,wall_ms,tool_ms,model_ms,steps,input_tokens,output_tokens," +
            "cache_read_tokens,cache_write_tokens,cache_hit_pct,estimated_cost_usd,partial,hit_step_cap,slowest_tools," +
            "setup_ms,teardown_ms,other_ms,model_ms_measured,fixed_context_tokens,fixed_x_steps," +
            "side_calls,side_call_input_tokens,side_call_output_tokens,flags"
        );
        expect(lines).toHaveLength(5);
        expect(lines[1]).toBe(
            "run-new,orders,Stage 1 — Source Inventory & Gap Analysis,completed,10000,3150,6850,2,4000,200,3000,1000,75.0," +
            "0.020000,false,false,file_read:2:2500;getCompilationErrors:1:2000;migration_source_read:1:100,,,,false,,,0,0,0,"
        );
        expect(lines[2]).toMatch(/,step_cap$/);
    });
});

const NEW_STAGE = "Stage 1 — Source Inventory & Gap Analysis";
/** Six minutes: longer than the prompt cache lives. */
const GAP = 6 * 60_000;

/** Two runs of the same single-package stage in the current trace format; run B ran at effort "high". */
function buildNewTrace(): string {
    const a = inStage("run-v2a", NEW_STAGE);
    const b = inStage("run-v2b", NEW_STAGE);
    const context = (effort: string) => ({
        systemPromptChars: 40_000, toolCount: 22, toolDefinitionsChars: 36_000, userMessageChars: 4_000,
        codebaseMapChars: 1_000, historyMessageCount: 0, historyChars: 0, floorTokens: 11_000,
        compactionEnabled: true, compactTriggerTokens: 500_000, effort, maxOutputTokens: 64_000,
        stepCap: 50, agentLimits: { maxSteps: 50, maxOutputTokens: 8_192 },
    });
    const step = (at: ReturnType<typeof inStage>, ms: number, fields: Record<string, unknown>) => at(ms, "step", {
        attempt: 0, cacheReadTokens: 0, cacheWriteTokens: 0, finishReason: "tool-calls", toolNames: [], ...fields,
    });
    // The same file read three times: identical arguments, so the same argsHash.
    const read = (at: ReturnType<typeof inStage>, ms: number, stepNumber: number, durationMs: number, outputChars: number) => at(ms, "tool", {
        toolName: "file_read", durationMs, ok: true, toolCallId: `call-${stepNumber}`, stepNumber,
        inputChars: 30, outputChars, argsHash: "aaaaaaaaaaaa",
    });

    return [
        event("run-v2a", 0, "run_start", { model: "claude-sonnet-5", loginMethod: "biIntel", packageCount: 1, entryPoint: "wizard" }),
        a(0, "stage_start"),
        a(200, "phase", { name: "codebase_map", durationMs: 200, category: "setup" }),
        a(300, "phase", { name: "temp_project", durationMs: 50, category: "setup" }),
        a(600, "phase", { name: "project_source", durationMs: 250, category: "setup" }),
        a(700, "stage_context", context("xhigh")),
        read(a, 3_000, 1, 400, 25_000),
        step(a, 3_000, { stepNumber: 1, durationMs: 2_000, stepMs: 2_000, ttftMs: 500, modelMs: 1_500, inputTokens: 20_000, cacheWriteTokens: 20_000, outputTokens: 100, toolNames: ["file_read"] }),
        read(a, 5_000, 2, 300, 1_000),
        step(a, 5_000, { stepNumber: 2, durationMs: 2_000, stepMs: 2_000, ttftMs: 300, modelMs: 1_600, inputTokens: 46_000, cacheReadTokens: 20_000, cacheWriteTokens: 26_000, outputTokens: 200, toolNames: ["file_read"] }),
        // Step 3's request goes out six minutes after step 2's, and finds the cache expired.
        read(a, GAP + 6_000, 3, 200, 900),
        step(a, GAP + 6_000, { stepNumber: 3, durationMs: GAP + 1_000, stepMs: 1_000, ttftMs: 400, modelMs: 700, inputTokens: 47_000, cacheWriteTokens: 47_000, outputTokens: 150, toolNames: ["file_read"] }),
        step(a, GAP + 8_000, { stepNumber: 4, durationMs: 2_000, stepMs: 1_500, ttftMs: 900, modelMs: 1_200, inputTokens: 48_000, cacheReadTokens: 47_000, cacheWriteTokens: 1_000, outputTokens: 3_000, finishReason: "length" }),
        a(GAP + 8_800, "phase", { name: "final_diagnostics", durationMs: 800, category: "teardown" }),
        a(GAP + 9_100, "phase", { name: "semantic_diff", durationMs: 300, category: "teardown" }),
        a(GAP + 9_200, "stage_usage", {
            status: "completed", steps: 4, inputTokens: 161_000, outputTokens: 3_450, cacheReadTokens: 67_000,
            cacheWriteTokens: 94_000, cacheHitRatio: 0.4161, subagentUsage: {}, estimatedCostUsd: 0.5,
            finishReason: "length", truncationRetries: 0, partial: false,
        }),
        a(GAP + 9_300, "phase", { name: "cleanup", durationMs: 100, category: "teardown" }),
        a(GAP + 10_000, "stage_end", { status: "completed", durationMs: GAP + 10_000, steps: 4 }),
        // Follow-up suggestions finish after the stage ended; their stage tag still places them.
        a(GAP + 10_500, "side_call", { source: "followups", model: "claude-haiku-4-5-20251001", inputTokens: 1_200, outputTokens: 80, durationMs: 900 }),
        event("run-v2a", GAP + 11_000, "run_end", { status: "completed", durationMs: GAP + 11_000 }),

        event("run-v2b", GAP + 20_000, "run_start", { model: "claude-sonnet-5", loginMethod: "biIntel", packageCount: 1, entryPoint: "wizard" }),
        b(GAP + 20_000, "stage_start"),
        b(GAP + 20_100, "stage_context", context("high")),
        step(b, GAP + 22_000, { stepNumber: 1, durationMs: 1_900, stepMs: 1_800, ttftMs: 300, modelMs: 1_500, inputTokens: 20_000, cacheWriteTokens: 20_000, outputTokens: 100 }),
        step(b, GAP + 24_000, { stepNumber: 2, durationMs: 2_000, stepMs: 2_000, ttftMs: 300, modelMs: 1_900, inputTokens: 30_000, cacheReadTokens: 20_000, cacheWriteTokens: 10_000, outputTokens: 2_000, finishReason: "stop" }),
        b(GAP + 24_500, "stage_usage", {
            status: "completed", steps: 2, inputTokens: 50_000, outputTokens: 2_100, cacheReadTokens: 20_000,
            cacheWriteTokens: 30_000, cacheHitRatio: 0.4, subagentUsage: {}, estimatedCostUsd: 0.2,
            finishReason: "stop", truncationRetries: 0, partial: false,
        }),
        b(GAP + 30_000, "stage_end", { status: "completed", durationMs: 10_000, steps: 2 }),
        event("run-v2b", GAP + 30_100, "run_end", { status: "completed", durationMs: 10_100 }),
    ].join("\n") + "\n";
}

function newRuns() {
    const { runs } = report.parseTrace(buildNewTrace());
    return runs.map((run: unknown) => report.summarizeRun(run));
}

describe("current traces", () => {
    it("split a stage's time into setup, model, tools, teardown and what is left over", () => {
        const [stage] = newRuns()[0].stages;

        // 370 s wall: 0.5 s setup, 5 s model (summed per step), 0.9 s tools, 1.2 s teardown.
        expect(stage).toMatchObject({
            wallMs: GAP + 10_000, setupMs: 500, modelMs: 5_000, modelMeasured: true, toolMs: 900, teardownMs: 1_200,
            otherMs: GAP + 10_000 - 500 - 5_000 - 900 - 1_200,
        });
    });

    it("estimate the context every step re-sends, times the steps", () => {
        const [stage] = newRuns()[0].stages;

        // (40,000 system + 36,000 tools + 4,000 user + 0 history) chars ÷ 4.
        expect(stage).toMatchObject({ fixedContextTokens: 20_000, fixedTimesSteps: 80_000 });
    });

    it("flag cache misses, long gaps, repeated calls, large outputs and truncation", () => {
        const [stage] = newRuns()[0].stages;

        expect(stage).toMatchObject({
            hitStepCap: false,
            cacheMissSteps: [3],
            longGaps: [{ stepNumber: 3, gapMs: GAP + 2_000 }],
            repeatedCalls: [{ toolName: "file_read", argsHash: "aaaaaaaaaaaa", count: 3 }],
            largeOutputs: [{ toolName: "file_read", stepNumber: 1, outputChars: 25_000 }],
            truncatedSteps: [4],
        });
    });

    it("place a side call by its stage tag, even one written after the stage ended", () => {
        const [stage] = newRuns()[0].stages;

        expect(stage.sideCalls).toEqual([expect.objectContaining({ source: "followups", calls: 1, inputTokens: 1_200, outputTokens: 80 })]);
    });

    it("show the new columns, the flags and the context breakdown in the table", () => {
        const text: string = report.formatTable([newRuns()[0]]);

        expect(text).toMatch(/Stage\s+Status\s+Wall\s+Setup\s+Model\s+Tools\s+Teardown\s+Other\s+Steps/);
        expect(text).toMatch(/completed\s+6m 10s\s+500ms\s+5\.0s\s+900ms\s+1\.2s\s+6m 02s\s+4/);
        expect(text).toMatch(/Fixed×steps\s+Side calls\s+Est\. cost/);
        expect(text).toMatch(/80,000\s+1\s+\$0\.5000/);
        expect(text).toContain("fixed context ≈20,000 tokens × 4 steps — system 10.0k, tools 9.0k (22), user 1.0k");
        expect(text).toContain("side calls: followups 1× — in 1,200");
        expect(text).toContain("! cache miss at step 3");
        expect(text).toContain("! long gap before step 3: 6m 02s since the previous model call");
        expect(text).toContain("! repeated tool call: file_read 3× with identical arguments (args aaaaaaaaaaaa)");
        expect(text).toContain("! large tool output: file_read 25,000 chars at step 1");
        expect(text).toContain("! output truncated (finish reason \"length\") at step 4");
    });

    it("write the new values and flag codes to CSV", () => {
        const lines: string[] = report.formatCsv([newRuns()[0]]).trim().split("\n");

        expect(lines[1]).toMatch(
            /,500,1200,362400,true,20000,80000,1,1200,80,cache_miss:3;long_gap:3;repeated:file_read×3;large_output:1;truncated:4$/
        );
    });
});

describe("--steps", () => {
    it("lists the steps that grew the input most, with the previous step's tool output sizes", () => {
        const text: string = report.formatSteps([newRuns()[0]]);

        expect(text).toMatch(/Largest input growth[^\n]*\n\s+2: \+26,000 → 46,000 · file_read 25,000 chars/);
        expect(text).toMatch(/Most output tokens[^\n]*\n\s+4: 3,000 · none/);
        expect(text).toMatch(/Slowest time to first token[^\n]*\n\s+4: 900ms · 48,000 · 97\.9%/);
    });

    it("says so when an older trace has no time to first token", () => {
        const { runs } = report.parseTrace(buildTrace());

        expect(report.formatSteps([report.summarizeRun(runs[1])])).toContain("Slowest time to first token: no ttftMs in this trace");
    });
});

describe("--compare", () => {
    it("pairs the stages of two runs and shows what changed in their settings", () => {
        const [a, b] = newRuns();
        const [pair] = report.compareRuns(a, b);
        const text: string = report.formatCompare(a, b);

        expect(pair.settings).toBe("effort xhigh → high");
        expect(text).toMatch(/6m 10s\s+10\.0s\s+-6m 00s\s+4\s+2\s+161,000\s+50,000\s+-111,000/);
        expect(text).toContain("-$0.3000");
        expect(text).toContain(`${NEW_STAGE}: effort xhigh → high`);
    });

    it("says a stage is unchanged when its settings match", () => {
        const [a] = newRuns();

        expect(report.compareRuns(a, a)[0].settings).toBe("same (effort xhigh, step cap 50)");
    });

    it("writes the pairs to CSV", () => {
        const [a, b] = newRuns();
        const lines: string[] = report.formatCompareCsv(a, b).trim().split("\n");

        expect(lines).toHaveLength(2);
        expect(lines[1]).toBe(`,${NEW_STAGE},run-v2a,run-v2b,${GAP + 10_000},10000,4,2,161000,50000,3450,2100,0.5,0.2,effort xhigh → high`);
    });
});

describe("main", () => {
    let projectRoot: string;
    let out: string;
    let err: string;
    const outStream = { write: (text: string) => { out += text; return true; } };
    const errStream = { write: (text: string) => { err += text; return true; } };

    beforeEach(() => {
        projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "migration-trace-report-"));
        fs.mkdirSync(path.join(projectRoot, ".ballerina-ai-migration"));
        fs.writeFileSync(path.join(projectRoot, ".ballerina-ai-migration", "trace.jsonl"), buildTrace());
        out = "";
        err = "";
    });

    afterEach(() => {
        fs.rmSync(projectRoot, { recursive: true, force: true });
    });

    it("reports the latest run of a project's trace by default", () => {
        expect(report.main([projectRoot, "--csv"], outStream, errStream)).toBe(0);

        expect(out).toContain("run-new,");
        expect(out).not.toContain("run-old,");
        expect(err).toBe("Skipped 1 malformed line(s).\n");
    });

    it("reports every run with --all", () => {
        const tracePath = path.join(projectRoot, ".ballerina-ai-migration", "trace.jsonl");

        expect(report.main([tracePath, "--all"], outStream, errStream)).toBe(0);
        expect(out).toContain("Run run-old");
        expect(out).toContain("Run run-new");
    });

    it("rejects an unknown flag with the usage line", () => {
        expect(report.main([projectRoot, "--json"], outStream, errStream)).toBe(2);
        expect(err).toMatch(/^Usage: /);
    });

    it("adds the step lists with --steps", () => {
        expect(report.main([projectRoot, "--steps"], outStream, errStream)).toBe(0);

        expect(out).toContain("Steps of run run-new");
        expect(out).toContain("Largest input growth");
    });

    describe("--compare", () => {
        let tracePath: string;

        beforeEach(() => {
            tracePath = path.join(projectRoot, "new-trace.jsonl");
            fs.writeFileSync(tracePath, buildNewTrace());
        });

        it("compares two runs picked by id prefix", () => {
            expect(report.main([tracePath, "--compare", "run-v2a", "run-v2b"], outStream, errStream)).toBe(0);

            expect(out).toContain("A: run run-v2a");
            expect(out).toContain("effort xhigh → high");
        });

        it("refuses a prefix that matches several runs", () => {
            expect(report.main([tracePath, "--compare", "run-v2", "run-v2b"], outStream, errStream)).toBe(1);
            expect(err).toBe("run-v2 matches 2 runs; use a longer prefix.\n");
        });

        it("needs two run ids", () => {
            expect(report.main([tracePath, "--compare", "run-v2a"], outStream, errStream)).toBe(2);
            expect(err).toContain("--compare needs two run ids.");
        });
    });
});
