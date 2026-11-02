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

// Migration AI Enhancement trace report.
//
// Summarizes `.ballerina-ai-migration/trace.jsonl` (written by MigrationDebugLogger in
// src/features/ai/migration/debug-logger.ts) as one row per stage: wall-clock time, how much of
// it went to tools, steps, tokens and estimated cost, plus each stage's slowest tool types.
//
//   node scripts/migration-trace-report.js <trace.jsonl | migrated project dir> [--all] [--csv]
//
//   --all  every run in the file (default: the latest run)
//   --csv  CSV instead of a table
//
// Dependency-free, so it runs on a trace copied off another machine.

"use strict";

const fs = require("fs");
const path = require("path");

/** Every `streamText` attempt stops at this many steps (`stopWhen: [stepCountIs(50)]` in AgentExecutor). */
const STEP_CAP = 50;
const TRACE_RELATIVE_PATH = path.join(".ballerina-ai-migration", "trace.jsonl");
const USAGE = "Usage: node scripts/migration-trace-report.js <trace.jsonl | project dir> [--all] [--csv]";

/**
 * Parses trace.jsonl text into runs, in the order each run first appears. Lines that are not a
 * JSON event with a runId and a type (a write cut short by a crash) are counted and skipped.
 */
function parseTrace(text) {
    const byRun = new Map();
    let malformed = 0;
    for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) {
            continue;
        }
        let event;
        try {
            event = JSON.parse(line);
        } catch {
            malformed++;
            continue;
        }
        if (!event || typeof event.runId !== "string" || typeof event.type !== "string") {
            malformed++;
            continue;
        }
        if (!byRun.has(event.runId)) {
            byRun.set(event.runId, []);
        }
        byRun.get(event.runId).push(event);
    }
    return { runs: [...byRun].map(([runId, events]) => ({ runId, events })), malformed };
}

/** Milliseconds covered by at least one `[start, end]` interval, so parallel tool calls count once. */
function unionMs(intervals) {
    const sorted = intervals.filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0]);
    let total = 0;
    let spanStart = 0;
    let spanEnd = -Infinity;
    for (const [start, end] of sorted) {
        if (start > spanEnd) {
            if (spanEnd > spanStart) {
                total += spanEnd - spanStart;
            }
            spanStart = start;
            spanEnd = end;
        } else if (end > spanEnd) {
            spanEnd = end;
        }
    }
    if (spanEnd > spanStart) {
        total += spanEnd - spanStart;
    }
    return total;
}

/** Tool types ranked by the total time spent in them, slowest first. */
function slowestTools(tools, limit) {
    const byName = new Map();
    for (const tool of tools) {
        const entry = byName.get(tool.toolName) || { toolName: tool.toolName, calls: 0, totalMs: 0 };
        entry.calls++;
        entry.totalMs += tool.durationMs || 0;
        byName.set(tool.toolName, entry);
    }
    return [...byName.values()].sort((a, b) => b.totalMs - a.totalMs).slice(0, limit);
}

function stageRow(stage) {
    const { start, end, steps, tools, usage } = stage;
    const startMs = Date.parse(start.ts);
    const seenMs = [...steps, ...tools, ...(usage ? [usage] : [])].map(event => Date.parse(event.ts));
    // A stage cut off by a crash has no stage_end; its last event bounds it.
    const wallMs = end ? end.durationMs : Math.max(startMs, ...seenMs) - startMs;
    const toolMs = unionMs(tools.map(tool => {
        const endMs = Date.parse(tool.ts);
        return [endMs - (tool.durationMs || 0), endMs];
    }));
    // stage_usage is the sum of the stage's steps; without it, add the steps up here.
    const sum = field => steps.reduce((acc, step) => acc + (step[field] || 0), 0);
    const tokens = usage
        ? usage
        : {
            inputTokens: sum("inputTokens"),
            outputTokens: sum("outputTokens"),
            cacheReadTokens: sum("cacheReadTokens"),
            cacheWriteTokens: sum("cacheWriteTokens"),
        };
    const stepsPerAttempt = new Map();
    for (const step of steps) {
        const attempt = step.attempt || 0;
        stepsPerAttempt.set(attempt, (stepsPerAttempt.get(attempt) || 0) + 1);
    }
    return {
        package: start.package || "",
        stage: start.stage || "(unnamed stage)",
        status: end ? end.status : "incomplete",
        wallMs,
        toolMs,
        modelMs: Math.max(0, wallMs - toolMs),
        steps: steps.length,
        inputTokens: tokens.inputTokens || 0,
        outputTokens: tokens.outputTokens || 0,
        cacheReadTokens: tokens.cacheReadTokens || 0,
        cacheWriteTokens: tokens.cacheWriteTokens || 0,
        cacheHitPct: tokens.inputTokens > 0 ? tokens.cacheReadTokens / tokens.inputTokens * 100 : 0,
        estimatedCostUsd: usage ? usage.estimatedCostUsd : undefined,
        /** Tokens exclude the step in flight when the stage stopped. */
        partial: usage ? !!usage.partial : steps.length > 0 && (!end || end.status !== "completed"),
        tokensFromSteps: !usage,
        hitStepCap: Math.max(0, ...stepsPerAttempt.values()) >= STEP_CAP,
        slowestTools: slowestTools(tools, 3),
    };
}

/** Groups a run's events by stage (stages run one at a time) and summarizes each. */
function summarizeRun(run) {
    const runStart = run.events.find(event => event.type === "run_start");
    const runEnd = run.events.filter(event => event.type === "run_end").pop();
    const stages = [];
    let current;
    for (const event of run.events) {
        if (event.type === "stage_start") {
            current = { start: event, end: undefined, steps: [], tools: [], usage: undefined };
            stages.push(current);
        } else if (current) {
            if (event.type === "step") {
                current.steps.push(event);
            } else if (event.type === "tool") {
                current.tools.push(event);
            } else if (event.type === "stage_usage") {
                current.usage = event;
            } else if (event.type === "stage_end") {
                current.end = event;
                current = undefined;
            }
        }
    }
    return {
        runId: run.runId,
        startedAt: (runStart || run.events[0]).ts,
        model: runStart ? runStart.model : undefined,
        loginMethod: runStart ? runStart.loginMethod : undefined,
        entryPoint: runStart ? runStart.entryPoint : undefined,
        packageCount: runStart ? runStart.packageCount : undefined,
        status: runEnd ? runEnd.status : "incomplete",
        durationMs: runEnd ? runEnd.durationMs : undefined,
        packagesSucceeded: runEnd ? runEnd.packagesSucceeded : undefined,
        packagesFailed: runEnd ? runEnd.packagesFailed : undefined,
        stages: stages.map(stageRow),
    };
}

function formatDuration(ms) {
    if (ms === undefined || ms === null || Number.isNaN(ms)) {
        return "—";
    }
    if (ms < 1000) {
        return `${Math.round(ms)}ms`;
    }
    if (ms < 60_000) {
        return `${(ms / 1000).toFixed(1)}s`;
    }
    const seconds = Math.round(ms / 1000);
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m ${String(s).padStart(2, "0")}s`;
}

const formatInt = n => Number(n || 0).toLocaleString("en-US");
const formatCost = cost => (cost === undefined ? "—" : `$${cost.toFixed(4)}`);

const COLUMNS = [
    { title: "Stage", left: true, value: row => row.stage },
    { title: "Status", left: true, value: row => row.status },
    { title: "Wall", value: row => formatDuration(row.wallMs) },
    { title: "Tools", value: row => formatDuration(row.toolMs) },
    { title: "≈Model", value: row => formatDuration(row.modelMs) },
    { title: "Steps", value: row => String(row.steps) },
    { title: "Input", value: row => formatInt(row.inputTokens) },
    { title: "Output", value: row => formatInt(row.outputTokens) },
    { title: "Cache read", value: row => formatInt(row.cacheReadTokens) },
    { title: "Cache write", value: row => formatInt(row.cacheWriteTokens) },
    { title: "Hit %", value: row => row.cacheHitPct.toFixed(1) },
    { title: "Est. cost", value: row => formatCost(row.estimatedCostUsd) },
];

function totalsRow(rows) {
    const sum = field => rows.reduce((acc, row) => acc + (row[field] || 0), 0);
    const costs = rows.map(row => row.estimatedCostUsd).filter(cost => cost !== undefined);
    const inputTokens = sum("inputTokens");
    return {
        stage: "Total",
        status: "",
        wallMs: sum("wallMs"),
        toolMs: sum("toolMs"),
        modelMs: sum("modelMs"),
        steps: sum("steps"),
        inputTokens,
        outputTokens: sum("outputTokens"),
        cacheReadTokens: sum("cacheReadTokens"),
        cacheWriteTokens: sum("cacheWriteTokens"),
        cacheHitPct: inputTokens > 0 ? sum("cacheReadTokens") / inputTokens * 100 : 0,
        estimatedCostUsd: costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : undefined,
    };
}

function noteLines(row) {
    const notes = [];
    if (row.slowestTools.length > 0) {
        const tools = row.slowestTools
            .map(tool => `${tool.toolName} ${tool.calls}× ${formatDuration(tool.totalMs)}`)
            .join(", ");
        notes.push(`slowest tools: ${tools}`);
    }
    if (row.hitStepCap) {
        notes.push(`! reached ${STEP_CAP} steps in one attempt: stopped by AgentExecutor's stepCountIs(${STEP_CAP}), not this stage's agentLimits`);
    }
    if (row.tokensFromSteps && row.steps > 0) {
        notes.push("* no stage_usage event: tokens summed from step events, no cost estimate");
    }
    if (row.partial) {
        notes.push("* tokens exclude the step in flight when the stage stopped");
    }
    return notes;
}

function runHeader(summary) {
    const packages = summary.packagesSucceeded !== undefined
        ? ` (${summary.packagesSucceeded} succeeded, ${summary.packagesFailed} failed)`
        : "";
    return [
        `Run ${summary.runId}  started ${summary.startedAt}`,
        `Model ${summary.model || "?"} · login ${summary.loginMethod || "?"} · entry ${summary.entryPoint || "?"} · ` +
        `${summary.packageCount ?? "?"} package(s) · ${summary.status}${packages} · ${formatDuration(summary.durationMs)}`,
    ];
}

/** Renders runs as text tables; multi-package runs are grouped by package. */
function formatTable(summaries) {
    const out = [];
    for (const summary of summaries) {
        out.push(...runHeader(summary), "");
        const rows = summary.stages;
        if (rows.length === 0) {
            out.push("No stages recorded.", "");
            continue;
        }
        const total = totalsRow(rows);
        const cells = [...rows, total].map(row => COLUMNS.map(col => col.value(row)));
        const widths = COLUMNS.map((col, i) => Math.max(col.title.length, ...cells.map(row => row[i].length)));
        const render = values => values
            .map((value, i) => (COLUMNS[i].left ? value.padEnd(widths[i]) : value.padStart(widths[i])))
            .join("  ")
            .trimEnd();
        const indent = "  ";
        out.push(indent + render(COLUMNS.map(col => col.title)));
        out.push(indent + widths.map(width => "-".repeat(width)).join("  "));

        const grouped = (summary.packageCount || 0) > 1 || rows.some(row => row.package);
        let currentGroup;
        rows.forEach((row, i) => {
            const group = row.package ? `Package ${row.package}` : "Workspace";
            if (grouped && group !== currentGroup) {
                currentGroup = group;
                out.push(group);
            }
            out.push(indent + render(cells[i]));
            for (const note of noteLines(row)) {
                out.push(`${indent}    ${note}`);
            }
        });
        out.push(indent + widths.map(width => "-".repeat(width)).join("  "));
        out.push(indent + render(cells[cells.length - 1]), "");
    }
    return out.join("\n");
}

const CSV_HEADER = [
    "run_id", "package", "stage", "status", "wall_ms", "tool_ms", "model_ms", "steps",
    "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "cache_hit_pct",
    "estimated_cost_usd", "partial", "hit_step_cap", "slowest_tools",
];

function csvField(value) {
    const text = value === undefined || value === null ? "" : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Renders runs as CSV, one row per stage; `slowest_tools` is `name:calls:totalMs` joined by `;`. */
function formatCsv(summaries) {
    const lines = [CSV_HEADER.join(",")];
    for (const summary of summaries) {
        for (const row of summary.stages) {
            lines.push([
                summary.runId, row.package, row.stage, row.status,
                Math.round(row.wallMs), Math.round(row.toolMs), Math.round(row.modelMs), row.steps,
                row.inputTokens, row.outputTokens, row.cacheReadTokens, row.cacheWriteTokens,
                row.cacheHitPct.toFixed(1),
                row.estimatedCostUsd === undefined ? "" : row.estimatedCostUsd.toFixed(6),
                row.partial, row.hitStepCap,
                row.slowestTools.map(tool => `${tool.toolName}:${tool.calls}:${tool.totalMs}`).join(";"),
            ].map(csvField).join(","));
        }
    }
    return lines.join("\n") + "\n";
}

/** Returns the process exit code; `out`/`err` are injectable for tests. */
function main(argv, out = process.stdout, err = process.stderr) {
    const flags = argv.filter(arg => arg.startsWith("--"));
    const positional = argv.filter(arg => !arg.startsWith("--"));
    if (positional.length !== 1 || flags.some(flag => flag !== "--all" && flag !== "--csv")) {
        err.write(`${USAGE}\n`);
        return 2;
    }
    let file = positional[0];
    try {
        if (fs.statSync(file).isDirectory()) {
            file = path.join(file, TRACE_RELATIVE_PATH);
        }
    } catch {
        // A missing path is reported by the read below.
    }
    let text;
    try {
        text = fs.readFileSync(file, "utf8");
    } catch (error) {
        err.write(`Cannot read ${file}: ${error.message}\n`);
        return 1;
    }
    const { runs, malformed } = parseTrace(text);
    if (runs.length === 0) {
        err.write(`No runs found in ${file}.\n`);
        return 1;
    }
    const selected = flags.includes("--all") ? runs : [runs[runs.length - 1]];
    const summaries = selected.map(summarizeRun);
    out.write(flags.includes("--csv") ? formatCsv(summaries) : formatTable(summaries));
    if (malformed > 0) {
        err.write(`Skipped ${malformed} malformed line(s).\n`);
    }
    return 0;
}

if (require.main === module) {
    process.exitCode = main(process.argv.slice(2));
}

module.exports = { STEP_CAP, parseTrace, unionMs, summarizeRun, formatTable, formatCsv, main };
