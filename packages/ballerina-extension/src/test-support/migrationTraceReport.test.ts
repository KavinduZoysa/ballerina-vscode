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
 * `scripts/migration-trace-report.js` turns a migration trace.jsonl into per-stage numbers. The
 * fake trace below has two runs; the latest is a two-package workspace whose stages cover the
 * cases the report must get right: parallel tool calls (tool time counts them once), a stage
 * without a usage summary (tokens come from its steps), a stage that hit the executor's 50-step
 * cap in one attempt, one that took more than 50 steps only across attempts, and a torn line.
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

describe("output", () => {
    it("groups a multi-package run by package and notes the cap, partial totals and slowest tools", () => {
        const { runs } = report.parseTrace(buildTrace());
        const text: string = report.formatTable([report.summarizeRun(runs[1])]);

        expect(text.indexOf("Package orders")).toBeLessThan(text.indexOf("Package billing"));
        expect(text.indexOf("Package billing")).toBeLessThan(text.indexOf("Workspace\n"));
        expect(text).toContain("slowest tools: file_read 2× 2.5s, getCompilationErrors 1× 2.0s, migration_source_read 1× 100ms");
        expect(text).toContain("! reached 50 steps in one attempt");
        expect(text).toContain("* no stage_usage event: tokens summed from step events");
        expect(text).toMatch(/Total\s+28\.2s\s+3\.1s/);
    });

    it("writes one CSV row per stage", () => {
        const { runs } = report.parseTrace(buildTrace());
        const lines: string[] = report.formatCsv([report.summarizeRun(runs[1])]).trim().split("\n");

        expect(lines[0]).toBe(
            "run_id,package,stage,status,wall_ms,tool_ms,model_ms,steps,input_tokens,output_tokens," +
            "cache_read_tokens,cache_write_tokens,cache_hit_pct,estimated_cost_usd,partial,hit_step_cap,slowest_tools"
        );
        expect(lines).toHaveLength(5);
        expect(lines[1]).toBe(
            "run-new,orders,Stage 1 — Source Inventory & Gap Analysis,completed,10000,3150,6850,2,4000,200,3000,1000,75.0," +
            "0.020000,false,false,file_read:2:2500;getCompilationErrors:1:2000;migration_source_read:1:100"
        );
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
});
