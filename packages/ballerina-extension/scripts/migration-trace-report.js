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
// src/features/ai/migration/debug-logger.ts) per stage: where the time went (setup, model, tools,
// teardown), what the tokens cost, and which steps and tool calls look wasteful.
//
//   node scripts/migration-trace-report.js <trace.jsonl | migrated project dir> [options]
//
//   --all                       every run in the file (default: the latest run)
//   --csv                       CSV instead of tables (one row per stage, or per compared stage)
//   --steps                     per stage, the top steps by input growth, output tokens and time to first token
//   --compare <runIdA> <runIdB> two runs' stage totals side by side, with their stage settings
//                               (run ids or unique prefixes of them)
//
// Traces written before a field existed still report; columns that need it show "—".
// Dependency-free, so it runs on a trace copied off another machine.

"use strict";

const fs = require("fs");
const path = require("path");

/** The executor's step cap per `streamText` attempt, for traces without a stage_context event. */
const STEP_CAP = 50;
/** From this trace version on, steps are timed from their request start and HTTP attempts are traced. */
const REQUEST_TIMING_VERSION = 3;
const TRACE_RELATIVE_PATH = path.join(".ballerina-ai-migration", "trace.jsonl");
const USAGE = "Usage: node scripts/migration-trace-report.js <trace.jsonl | project dir> " +
    "[--all] [--csv] [--steps] [--compare <runIdA> <runIdB>]";

// Flag thresholds.
const CACHE_MISS_RATIO = 0.5;
const LONG_GAP_MS = 5 * 60 * 1000;
const REPEATED_CALLS = 3;
const LARGE_OUTPUT_CHARS = 20_000;
const SLOW_REQUEST_MS = 2 * 60 * 1000;
const TOP_STEPS = 10;
/** Rough characters per token, for sizes the trace records in characters. */
const CHARS_PER_TOKEN = 4;

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

const sumOf = (items, field) => items.reduce((acc, item) => acc + (item[field] || 0), 0);
const stepNo = (step, index) => step.stepNumber ?? index + 1;

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

/** Side calls grouped by source. */
function sideCallTotals(sideCalls) {
    const bySource = new Map();
    for (const call of sideCalls) {
        const entry = bySource.get(call.source) || {
            source: call.source, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, durationMs: 0,
        };
        entry.calls++;
        entry.inputTokens += call.inputTokens || 0;
        entry.outputTokens += call.outputTokens || 0;
        entry.cacheReadTokens += call.cacheReadTokens || 0;
        entry.cacheWriteTokens += call.cacheWriteTokens || 0;
        entry.durationMs += call.durationMs || 0;
        bySource.set(call.source, entry);
    }
    return [...bySource.values()];
}

/** A stage's HTTP attempts: how many, the slowest, and the ones that failed or were slow. */
function httpSummary(attempts) {
    const slowest = attempts.reduce((max, attempt) => (!max || (attempt.durationMs || 0) > (max.durationMs || 0) ? attempt : max), undefined);
    return {
        requests: attempts.length,
        authRetries: attempts.filter(attempt => attempt.attempt > 1).length,
        tokenMs: sumOf(attempts, "tokenMs"),
        slowest,
        slow: attempts.filter(attempt => (attempt.durationMs || 0) > SLOW_REQUEST_MS),
        failed: attempts.filter(attempt => attempt.error || (attempt.status !== undefined && attempt.status >= 400)),
    };
}

/** When the step's model request started; only traces with `stepMs` know it. */
function stepStartMs(step) {
    return step.stepMs !== undefined ? Date.parse(step.ts) - step.stepMs : undefined;
}

/**
 * Time between the previous step's model request and this one's — the cache's idle time. Older
 * traces without `stepMs` fall back to how long the previous step took, which is nearly the same.
 */
function gapBefore(previous, step) {
    const previousStart = stepStartMs(previous);
    const start = stepStartMs(step);
    return previousStart !== undefined && start !== undefined ? start - previousStart : (previous.durationMs || 0);
}

function stageFlags(steps, tools, stepCap) {
    const stepsPerAttempt = new Map();
    for (const step of steps) {
        const attempt = step.attempt || 0;
        stepsPerAttempt.set(attempt, (stepsPerAttempt.get(attempt) || 0) + 1);
    }
    const cacheMissSteps = steps
        .map((step, i) => ({ step, number: stepNo(step, i) }))
        .filter(({ step, number }) => number > 2 && step.inputTokens > 0
            && (step.cacheReadTokens || 0) < CACHE_MISS_RATIO * step.inputTokens)
        .map(({ number }) => number);
    const longGaps = [];
    for (let i = 1; i < steps.length; i++) {
        const gapMs = gapBefore(steps[i - 1], steps[i]);
        if (gapMs > LONG_GAP_MS) {
            longGaps.push({ stepNumber: stepNo(steps[i], i), gapMs });
        }
    }
    const byCall = new Map();
    for (const tool of tools) {
        if (!tool.argsHash) {
            continue;
        }
        const key = `${tool.toolName}\u0000${tool.argsHash}`;
        const entry = byCall.get(key) || { toolName: tool.toolName, argsHash: tool.argsHash, count: 0 };
        entry.count++;
        byCall.set(key, entry);
    }
    return {
        hitStepCap: Math.max(0, ...stepsPerAttempt.values()) >= stepCap,
        cacheMissSteps,
        longGaps,
        repeatedCalls: [...byCall.values()].filter(entry => entry.count >= REPEATED_CALLS),
        largeOutputs: tools
            .filter(tool => (tool.outputChars || 0) > LARGE_OUTPUT_CHARS)
            .map(tool => ({ toolName: tool.toolName, stepNumber: tool.stepNumber, outputChars: tool.outputChars })),
        truncatedSteps: steps.map((step, i) => ({ step, number: stepNo(step, i) }))
            .filter(({ step }) => step.finishReason === "length")
            .map(({ number }) => number),
    };
}

/** Estimated tokens of the context every step re-sends, from the stage_context sizes. */
function fixedContextTokens(context) {
    if (!context) {
        return undefined;
    }
    const chars = (context.systemPromptChars || 0) + (context.toolDefinitionsChars || 0)
        + (context.userMessageChars || 0) + (context.historyChars || 0);
    return Math.round(chars / CHARS_PER_TOKEN);
}

function stageRow(stage, traceVersion) {
    const { start, end, steps, tools, usage, context, phases, sideCalls, http } = stage;
    const startMs = Date.parse(start.ts);
    const seenMs = [...steps, ...tools, ...phases, ...(usage ? [usage] : [])].map(event => Date.parse(event.ts));
    // A stage cut off by a crash has no stage_end; its last event bounds it.
    const wallMs = end ? end.durationMs : Math.max(startMs, ...seenMs) - startMs;
    const toolMs = unionMs(tools.map(tool => {
        const endMs = Date.parse(tool.ts);
        return [endMs - (tool.durationMs || 0), endMs];
    }));
    const phaseMs = category => (phases.length > 0 ? sumOf(phases.filter(p => p.category === category), "durationMs") : undefined);
    const setupMs = phaseMs("setup");
    const teardownMs = phaseMs("teardown");
    // Older traces have no per-step model time; there the model gets whatever the tools did not use.
    const modelMeasured = steps.some(step => step.modelMs !== undefined);
    // Before version 3, steps were timed from the response's first chunk, not the request.
    const modelFromRequest = modelMeasured && (traceVersion || 0) >= REQUEST_TIMING_VERSION;
    const modelMs = modelMeasured ? sumOf(steps, "modelMs") : Math.max(0, wallMs - toolMs);
    const otherMs = modelMeasured
        ? Math.max(0, wallMs - (setupMs || 0) - modelMs - toolMs - (teardownMs || 0))
        : undefined;
    // stage_usage is the sum of the stage's steps; without it, add the steps up here.
    const tokens = usage
        ? usage
        : {
            inputTokens: sumOf(steps, "inputTokens"),
            outputTokens: sumOf(steps, "outputTokens"),
            cacheReadTokens: sumOf(steps, "cacheReadTokens"),
            cacheWriteTokens: sumOf(steps, "cacheWriteTokens"),
        };
    const fixedTokens = fixedContextTokens(context);
    const flags = stageFlags(steps, tools, context?.stepCap ?? STEP_CAP);
    return {
        package: start.package || "",
        stage: start.stage || "(unnamed stage)",
        status: end ? end.status : "incomplete",
        wallMs,
        setupMs,
        modelMs,
        modelMeasured,
        modelFromRequest,
        toolMs,
        teardownMs,
        otherMs,
        steps: steps.length,
        inputTokens: tokens.inputTokens || 0,
        outputTokens: tokens.outputTokens || 0,
        cacheReadTokens: tokens.cacheReadTokens || 0,
        cacheWriteTokens: tokens.cacheWriteTokens || 0,
        cacheHitPct: tokens.inputTokens > 0 ? tokens.cacheReadTokens / tokens.inputTokens * 100 : 0,
        fixedContextTokens: fixedTokens,
        fixedTimesSteps: fixedTokens !== undefined ? fixedTokens * steps.length : undefined,
        estimatedCostUsd: usage ? usage.estimatedCostUsd : undefined,
        /** Tokens exclude the step in flight when the stage stopped. */
        partial: usage ? !!usage.partial : steps.length > 0 && (!end || end.status !== "completed"),
        tokensFromSteps: !usage,
        ...flags,
        slowestTools: slowestTools(tools, 3),
        sideCalls: sideCallTotals(sideCalls),
        http: httpSummary(http),
        context,
        // Kept for --steps.
        stepEvents: steps,
        toolEvents: tools,
    };
}

/**
 * Groups a run's events by stage (stages run one at a time) and summarizes each. Side calls are
 * placed by their stage tag instead: a fire-and-forget call can finish after its stage ended.
 */
function summarizeRun(run) {
    const runStart = run.events.find(event => event.type === "run_start");
    const runEnd = run.events.filter(event => event.type === "run_end").pop();
    const stages = [];
    const unplacedSideCalls = [];
    const unplacedHttp = [];
    let current;
    const ownerOf = event => [...stages].reverse()
        .find(stage => stage.start.stage === event.stage && (stage.start.package || "") === (event.package || ""));
    for (const event of run.events) {
        if (event.type === "stage_start") {
            current = { start: event, end: undefined, steps: [], tools: [], phases: [], sideCalls: [], http: [], usage: undefined, context: undefined };
            stages.push(current);
        } else if (event.type === "side_call") {
            const owner = ownerOf(event);
            (owner ? owner.sideCalls : unplacedSideCalls).push(event);
        } else if (event.type === "http") {
            const owner = ownerOf(event);
            (owner ? owner.http : unplacedHttp).push(event);
        } else if (current) {
            if (event.type === "step") {
                current.steps.push(event);
            } else if (event.type === "tool") {
                current.tools.push(event);
            } else if (event.type === "phase") {
                current.phases.push(event);
            } else if (event.type === "stage_context") {
                current.context = event;
            } else if (event.type === "stage_usage") {
                current.usage = event;
            } else if (event.type === "stage_end") {
                current.end = event;
                current = undefined;
            }
        }
    }
    const traceVersion = runStart ? runStart.traceVersion : undefined;
    return {
        runId: run.runId,
        traceVersion,
        startedAt: (runStart || run.events[0]).ts,
        model: runStart ? runStart.model : undefined,
        loginMethod: runStart ? runStart.loginMethod : undefined,
        entryPoint: runStart ? runStart.entryPoint : undefined,
        packageCount: runStart ? runStart.packageCount : undefined,
        status: runEnd ? runEnd.status : "incomplete",
        durationMs: runEnd ? runEnd.durationMs : undefined,
        packagesSucceeded: runEnd ? runEnd.packagesSucceeded : undefined,
        packagesFailed: runEnd ? runEnd.packagesFailed : undefined,
        stages: stages.map(stage => stageRow(stage, traceVersion)),
        unplacedSideCalls: sideCallTotals(unplacedSideCalls),
        unplacedHttp: httpSummary(unplacedHttp),
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

const formatInt = n => (n === undefined ? "—" : Number(n || 0).toLocaleString("en-US"));
const formatCost = cost => (cost === undefined ? "—" : `$${cost.toFixed(4)}`);
const formatK = n => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

const TIME_COLUMNS = [
    { title: "Stage", left: true, value: row => row.stage },
    { title: "Status", left: true, value: row => row.status },
    { title: "Wall", value: row => formatDuration(row.wallMs) },
    { title: "Setup", value: row => formatDuration(row.setupMs) },
    { title: "Model", value: row => (row.modelMeasured ? "" : "≈") + formatDuration(row.modelMs) },
    { title: "Tools", value: row => formatDuration(row.toolMs) },
    { title: "Teardown", value: row => formatDuration(row.teardownMs) },
    { title: "Other", value: row => formatDuration(row.otherMs) },
    { title: "Steps", value: row => String(row.steps) },
];

const TOKEN_COLUMNS = [
    { title: "Stage", left: true, value: row => row.stage },
    { title: "Input", value: row => formatInt(row.inputTokens) },
    { title: "Output", value: row => formatInt(row.outputTokens) },
    { title: "Cache read", value: row => formatInt(row.cacheReadTokens) },
    { title: "Cache write", value: row => formatInt(row.cacheWriteTokens) },
    { title: "Hit %", value: row => row.cacheHitPct.toFixed(1) },
    { title: "Fixed×steps", value: row => formatInt(row.fixedTimesSteps) },
    { title: "Side calls", value: row => String(row.sideCalls.reduce((n, call) => n + call.calls, 0)) },
    { title: "Est. cost", value: row => formatCost(row.estimatedCostUsd) },
];

function totalsRow(rows) {
    const sum = field => rows.reduce((acc, row) => acc + (row[field] || 0), 0);
    const known = field => rows.some(row => row[field] !== undefined);
    const costs = rows.map(row => row.estimatedCostUsd).filter(cost => cost !== undefined);
    const inputTokens = sum("inputTokens");
    return {
        stage: "Total",
        status: "",
        wallMs: sum("wallMs"),
        setupMs: known("setupMs") ? sum("setupMs") : undefined,
        modelMs: sum("modelMs"),
        modelMeasured: rows.every(row => row.modelMeasured),
        toolMs: sum("toolMs"),
        teardownMs: known("teardownMs") ? sum("teardownMs") : undefined,
        otherMs: known("otherMs") ? sum("otherMs") : undefined,
        steps: sum("steps"),
        inputTokens,
        outputTokens: sum("outputTokens"),
        cacheReadTokens: sum("cacheReadTokens"),
        cacheWriteTokens: sum("cacheWriteTokens"),
        cacheHitPct: inputTokens > 0 ? sum("cacheReadTokens") / inputTokens * 100 : 0,
        fixedTimesSteps: known("fixedTimesSteps") ? sum("fixedTimesSteps") : undefined,
        sideCalls: rows.flatMap(row => row.sideCalls),
        estimatedCostUsd: costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : undefined,
    };
}

/** Renders rows under `columns`, grouped by package when the run has several. */
function renderTable(columns, rows, grouped) {
    const total = totalsRow(rows);
    const cells = [...rows, total].map(row => columns.map(col => col.value(row)));
    const widths = columns.map((col, i) => Math.max(col.title.length, ...cells.map(row => row[i].length)));
    const render = values => values
        .map((value, i) => (columns[i].left ? value.padEnd(widths[i]) : value.padStart(widths[i])))
        .join("  ")
        .trimEnd();
    const rule = "  " + widths.map(width => "-".repeat(width)).join("  ");
    const out = ["  " + render(columns.map(col => col.title)), rule];
    let currentGroup;
    rows.forEach((row, i) => {
        const group = row.package ? `Package ${row.package}` : "Workspace";
        if (grouped && group !== currentGroup) {
            currentGroup = group;
            out.push(group);
        }
        out.push("  " + render(cells[i]));
    });
    out.push(rule, "  " + render(cells[cells.length - 1]));
    return out;
}

function contextLine(context, steps) {
    const tokens = chars => formatK(Math.round((chars || 0) / CHARS_PER_TOKEN));
    const limits = context.agentLimits
        ? ` · stage maxSteps ${context.agentLimits.maxSteps ?? "?"} (not applied)`
        : "";
    return `fixed context ≈${formatInt(fixedContextTokens(context))} tokens × ${steps} steps — ` +
        `system ${tokens(context.systemPromptChars)}, tools ${tokens(context.toolDefinitionsChars)} (${context.toolCount ?? "?"}), ` +
        `user ${tokens(context.userMessageChars)} (codebase map ${tokens(context.codebaseMapChars)}), ` +
        `history ${tokens(context.historyChars)} · effort ${context.effort} · step cap ${context.stepCap}${limits}`;
}

function noteLines(row) {
    const notes = [];
    if (row.context) {
        notes.push(contextLine(row.context, row.steps));
    }
    if (row.slowestTools.length > 0) {
        const tools = row.slowestTools
            .map(tool => `${tool.toolName} ${tool.calls}× ${formatDuration(tool.totalMs)}`)
            .join(", ");
        notes.push(`slowest tools: ${tools}`);
    }
    for (const call of row.sideCalls) {
        notes.push(`side calls: ${call.source} ${call.calls}× — in ${formatInt(call.inputTokens)} ` +
            `(cache read ${formatInt(call.cacheReadTokens)}), out ${formatInt(call.outputTokens)}, ${formatDuration(call.durationMs)}`);
    }
    if (row.http.requests > 0) {
        const retries = row.http.authRetries > 0 ? `, ${row.http.authRetries} after a token refresh` : "";
        notes.push(`http: ${row.http.requests} requests${retries} · slowest ${formatDuration(row.http.slowest.durationMs)} to headers · ` +
            `token lookups ${formatDuration(row.http.tokenMs)}`);
    }
    const cap = row.context?.stepCap ?? STEP_CAP;
    if (row.hitStepCap) {
        notes.push(`! reached ${cap} steps in one attempt: stopped by AgentExecutor's stepCountIs(${cap}), not this stage's agentLimits`);
    }
    if (row.cacheMissSteps.length > 0) {
        notes.push(`! cache miss at step ${row.cacheMissSteps.join(", ")}: cache read under ${CACHE_MISS_RATIO * 100}% of input`);
    }
    for (const gap of row.longGaps) {
        notes.push(`! long gap before step ${gap.stepNumber}: ${formatDuration(gap.gapMs)} since the previous model call, ` +
            "past the 5-minute cache lifetime");
    }
    for (const call of row.repeatedCalls) {
        notes.push(`! repeated tool call: ${call.toolName} ${call.count}× with identical arguments (args ${call.argsHash})`);
    }
    for (const output of row.largeOutputs) {
        notes.push(`! large tool output: ${output.toolName} ${formatInt(output.outputChars)} chars at step ${output.stepNumber ?? "?"}`);
    }
    if (row.truncatedSteps.length > 0) {
        notes.push(`! output truncated (finish reason "length") at step ${row.truncatedSteps.join(", ")}`);
    }
    for (const attempt of row.http.slow) {
        notes.push(`! slow request: ${requestLabel(attempt)} took ${formatDuration(attempt.durationMs)} to response headers ` +
            `(${attempt.error ? `threw ${attempt.error}` : `status ${attempt.status}`}${attempt.requestId ? `, request ${attempt.requestId}` : ""})`);
    }
    for (const attempt of row.http.failed) {
        notes.push(`! failed request: ${requestLabel(attempt)} ${attempt.error ? `threw ${attempt.error}` : `status ${attempt.status}`} ` +
            `after ${formatDuration(attempt.durationMs)}${attempt.requestId ? ` (request ${attempt.requestId})` : ""}`);
    }
    if (row.tokensFromSteps && row.steps > 0) {
        notes.push("* no stage_usage event: tokens summed from step events, no cost estimate");
    }
    if (row.partial) {
        notes.push("* tokens exclude the step in flight when the stage stopped");
    }
    if (!row.modelMeasured && row.steps > 0) {
        notes.push("* no per-step model time in this trace: ≈Model is wall time minus tool time");
    } else if (row.modelMeasured && !row.modelFromRequest) {
        notes.push("* model time leaves out each response's wait for its first chunk (trace from before version 3); that wait is in Other");
    }
    return notes;
}

const requestLabel = attempt => `${attempt.method ?? "?"} ${attempt.path ?? "?"}${attempt.attempt > 1 ? ` (attempt ${attempt.attempt})` : ""}`;

function runHeader(summary) {
    const packages = summary.packagesSucceeded !== undefined
        ? ` (${summary.packagesSucceeded} succeeded, ${summary.packagesFailed} failed)`
        : "";
    return [
        `Run ${summary.runId}  started ${summary.startedAt}`,
        `Model ${summary.model || "?"} · login ${summary.loginMethod || "?"} · entry ${summary.entryPoint || "?"} · ` +
        `trace v${summary.traceVersion ?? "1–2"} · ` +
        `${summary.packageCount ?? "?"} package(s) · ${summary.status}${packages} · ${formatDuration(summary.durationMs)}`,
    ];
}

const stageLabel = row => (row.package ? `${row.stage} [${row.package}]` : row.stage);

/** Renders runs as a time table, a token table and per-stage notes; multi-package runs are grouped. */
function formatTable(summaries) {
    const out = [];
    for (const summary of summaries) {
        out.push(...runHeader(summary), "");
        const rows = summary.stages;
        if (rows.length === 0) {
            out.push("No stages recorded.", "");
            continue;
        }
        const grouped = (summary.packageCount || 0) > 1 || rows.some(row => row.package);
        out.push("Time", ...renderTable(TIME_COLUMNS, rows, grouped), "");
        out.push("Tokens", ...renderTable(TOKEN_COLUMNS, rows, grouped), "");
        const notes = rows.map(row => ({ row, lines: noteLines(row) })).filter(entry => entry.lines.length > 0);
        if (notes.length > 0 || summary.unplacedSideCalls.length > 0 || summary.unplacedHttp.requests > 0) {
            out.push("Notes");
            for (const { row, lines } of notes) {
                out.push(`  ${stageLabel(row)}`, ...lines.map(line => `      ${line}`));
            }
            if (summary.unplacedHttp.requests > 0) {
                out.push(`  (no stage) http: ${summary.unplacedHttp.requests} requests`);
            }
            for (const call of summary.unplacedSideCalls) {
                out.push(`  (no stage) side calls: ${call.source} ${call.calls}× — in ${formatInt(call.inputTokens)}, out ${formatInt(call.outputTokens)}`);
            }
            out.push("");
        }
    }
    return out.join("\n");
}

/** Tool calls of step `stepNumber`, with their output sizes when the trace has them. */
function toolsOfStep(row, stepNumber) {
    const tools = row.toolEvents.filter(tool => tool.stepNumber === stepNumber);
    if (tools.length > 0) {
        return tools.map(tool => `${tool.toolName} ${tool.outputChars !== undefined ? `${formatInt(tool.outputChars)} chars` : "(size ?)"}`).join(", ");
    }
    const step = row.stepEvents.find((s, i) => stepNo(s, i) === stepNumber);
    return step && step.toolNames && step.toolNames.length > 0 ? step.toolNames.join(", ") : "none";
}

/** Per stage: the steps that grew the input most, wrote the most, and waited longest for a first token. */
function formatSteps(summaries) {
    const out = [];
    for (const summary of summaries) {
        out.push(`Steps of run ${summary.runId}`, "");
        for (const row of summary.stages) {
            const steps = row.stepEvents.map((step, i) => ({ step, number: stepNo(step, i), previous: row.stepEvents[i - 1] }));
            out.push(stageLabel(row));
            const growth = steps
                .filter(entry => entry.previous)
                .map(entry => ({ ...entry, growth: entry.step.inputTokens - entry.previous.inputTokens }))
                .sort((a, b) => b.growth - a.growth)
                .slice(0, TOP_STEPS);
            out.push("  Largest input growth (step: +growth → input · previous step's tools)");
            for (const entry of growth) {
                out.push(`    ${String(entry.number).padStart(3)}: +${formatInt(entry.growth)} → ${formatInt(entry.step.inputTokens)} · ` +
                    toolsOfStep(row, entry.number - 1));
            }
            out.push("  Most output tokens (step: output · tools called)");
            for (const entry of [...steps].sort((a, b) => b.step.outputTokens - a.step.outputTokens).slice(0, TOP_STEPS)) {
                const tools = entry.step.toolNames && entry.step.toolNames.length > 0 ? entry.step.toolNames.join(", ") : "none";
                out.push(`    ${String(entry.number).padStart(3)}: ${formatInt(entry.step.outputTokens)} · ${tools}`);
            }
            const timed = steps.filter(entry => entry.step.ttftMs !== undefined);
            if (timed.length === 0) {
                out.push("  Slowest time to first token: no ttftMs in this trace");
            } else {
                out.push("  Slowest time to first token (step: ttft · input · cache hit)");
                for (const entry of timed.sort((a, b) => b.step.ttftMs - a.step.ttftMs).slice(0, TOP_STEPS)) {
                    const hit = entry.step.inputTokens > 0 ? (entry.step.cacheReadTokens || 0) / entry.step.inputTokens * 100 : 0;
                    out.push(`    ${String(entry.number).padStart(3)}: ${formatDuration(entry.step.ttftMs)} · ` +
                        `${formatInt(entry.step.inputTokens)} · ${hit.toFixed(1)}%`);
                }
            }
            out.push("");
        }
    }
    return out.join("\n");
}

/** The stage settings that change what a run costs, as compared side by side. */
function stageSettings(context) {
    if (!context) {
        return undefined;
    }
    return {
        effort: context.effort,
        stepCap: context.stepCap,
        maxOutputTokens: context.maxOutputTokens,
        compaction: context.compactionEnabled ? context.compactTriggerTokens : "off",
        "agentLimits.maxSteps": context.agentLimits ? context.agentLimits.maxSteps : undefined,
        "agentLimits.maxOutputTokens": context.agentLimits ? context.agentLimits.maxOutputTokens : undefined,
        fixedContextTokens: fixedContextTokens(context),
    };
}

function settingsDiff(a, b) {
    if (!a && !b) {
        return "no stage_context in either run";
    }
    if (!a || !b) {
        return `stage_context only in run ${a ? "A" : "B"}`;
    }
    const changed = Object.keys(a).filter(key => a[key] !== b[key]).map(key => `${key} ${a[key] ?? "—"} → ${b[key] ?? "—"}`);
    return changed.length > 0 ? changed.join("; ") : `same (effort ${a.effort}, step cap ${a.stepCap})`;
}

/** Pairs two runs' stages by package and stage name, keeping run A's order. */
function compareRuns(a, b) {
    const key = row => `${row.package}\u0000${row.stage}`;
    const byKeyB = new Map(b.stages.map(row => [key(row), row]));
    const pairs = a.stages.map(row => ({ a: row, b: byKeyB.get(key(row)) }));
    const keysA = new Set(a.stages.map(key));
    pairs.push(...b.stages.filter(row => !keysA.has(key(row))).map(row => ({ a: undefined, b: row })));
    return pairs.map(pair => {
        const row = pair.a || pair.b;
        return {
            package: row.package,
            stage: row.stage,
            a: pair.a,
            b: pair.b,
            settings: settingsDiff(stageSettings(pair.a && pair.a.context), stageSettings(pair.b && pair.b.context)),
        };
    });
}

function signed(value, format) {
    if (value === undefined || Number.isNaN(value)) {
        return "—";
    }
    return `${value > 0 ? "+" : value < 0 ? "-" : ""}${format(Math.abs(value))}`;
}

const diff = (pair, field) => (pair.a && pair.b && pair.a[field] !== undefined && pair.b[field] !== undefined
    ? pair.b[field] - pair.a[field]
    : undefined);
const side = (row, field, format) => (row ? format(row[field]) : "—");

function formatCompare(a, b) {
    const pairs = compareRuns(a, b);
    const columns = [
        { title: "Stage", left: true, value: p => stageLabel(p) },
        { title: "Wall A", value: p => side(p.a, "wallMs", formatDuration) },
        { title: "Wall B", value: p => side(p.b, "wallMs", formatDuration) },
        { title: "ΔWall", value: p => signed(diff(p, "wallMs"), formatDuration) },
        { title: "Steps A", value: p => side(p.a, "steps", String) },
        { title: "Steps B", value: p => side(p.b, "steps", String) },
        { title: "Input A", value: p => side(p.a, "inputTokens", formatInt) },
        { title: "Input B", value: p => side(p.b, "inputTokens", formatInt) },
        { title: "ΔInput", value: p => signed(diff(p, "inputTokens"), formatInt) },
        { title: "Output A", value: p => side(p.a, "outputTokens", formatInt) },
        { title: "Output B", value: p => side(p.b, "outputTokens", formatInt) },
        { title: "Cost A", value: p => side(p.a, "estimatedCostUsd", formatCost) },
        { title: "Cost B", value: p => side(p.b, "estimatedCostUsd", formatCost) },
        { title: "ΔCost", value: p => signed(diff(p, "estimatedCostUsd"), cost => `$${cost.toFixed(4)}`) },
    ];
    const cells = pairs.map(p => columns.map(col => col.value(p)));
    const widths = columns.map((col, i) => Math.max(col.title.length, ...cells.map(row => row[i].length)));
    const render = values => values
        .map((value, i) => (columns[i].left ? value.padEnd(widths[i]) : value.padStart(widths[i])))
        .join("  ")
        .trimEnd();
    const out = [
        `A: run ${a.runId}  started ${a.startedAt} · ${a.status} · ${formatDuration(a.durationMs)}`,
        `B: run ${b.runId}  started ${b.startedAt} · ${b.status} · ${formatDuration(b.durationMs)}`,
        "",
        "  " + render(columns.map(col => col.title)),
        "  " + widths.map(width => "-".repeat(width)).join("  "),
        ...cells.map(row => "  " + render(row)),
        "",
        "Stage settings (A → B)",
        ...pairs.map(p => `  ${stageLabel(p)}: ${p.settings}`),
        "",
    ];
    return out.join("\n");
}

function csvField(value) {
    const text = value === undefined || value === null ? "" : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const roundOrBlank = value => (value === undefined ? "" : Math.round(value));

function flagCodes(row) {
    const codes = [];
    if (row.hitStepCap) { codes.push("step_cap"); }
    if (row.cacheMissSteps.length > 0) { codes.push(`cache_miss:${row.cacheMissSteps.join(" ")}`); }
    if (row.longGaps.length > 0) { codes.push(`long_gap:${row.longGaps.map(gap => gap.stepNumber).join(" ")}`); }
    if (row.repeatedCalls.length > 0) { codes.push(`repeated:${row.repeatedCalls.map(call => `${call.toolName}×${call.count}`).join(" ")}`); }
    if (row.largeOutputs.length > 0) { codes.push(`large_output:${row.largeOutputs.length}`); }
    if (row.truncatedSteps.length > 0) { codes.push(`truncated:${row.truncatedSteps.join(" ")}`); }
    if (row.http.slow.length > 0) { codes.push(`slow_request:${row.http.slow.length}`); }
    if (row.http.failed.length > 0) { codes.push(`failed_request:${row.http.failed.length}`); }
    return codes.join(";");
}

const CSV_HEADER = [
    "run_id", "package", "stage", "status", "wall_ms", "tool_ms", "model_ms", "steps",
    "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "cache_hit_pct",
    "estimated_cost_usd", "partial", "hit_step_cap", "slowest_tools",
    "setup_ms", "teardown_ms", "other_ms", "model_ms_measured", "fixed_context_tokens", "fixed_x_steps",
    "side_calls", "side_call_input_tokens", "side_call_output_tokens", "flags",
    "model_from_request", "http_requests", "http_failed", "http_slowest_ms",
];

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
                roundOrBlank(row.setupMs), roundOrBlank(row.teardownMs), roundOrBlank(row.otherMs), row.modelMeasured,
                row.fixedContextTokens ?? "", row.fixedTimesSteps ?? "",
                row.sideCalls.reduce((n, call) => n + call.calls, 0),
                row.sideCalls.reduce((n, call) => n + call.inputTokens, 0),
                row.sideCalls.reduce((n, call) => n + call.outputTokens, 0),
                flagCodes(row),
                row.modelFromRequest, row.http.requests, row.http.failed.length,
                row.http.slowest ? row.http.slowest.durationMs : "",
            ].map(csvField).join(","));
        }
    }
    return lines.join("\n") + "\n";
}

/** Renders a comparison as CSV, one row per paired stage. */
function formatCompareCsv(a, b) {
    const header = [
        "package", "stage", "a_run_id", "b_run_id", "a_wall_ms", "b_wall_ms", "a_steps", "b_steps",
        "a_input_tokens", "b_input_tokens", "a_output_tokens", "b_output_tokens",
        "a_estimated_cost_usd", "b_estimated_cost_usd", "settings_diff",
    ];
    const value = (row, field) => (row && row[field] !== undefined ? row[field] : "");
    const lines = [header.join(",")];
    for (const pair of compareRuns(a, b)) {
        lines.push([
            pair.package, pair.stage, a.runId, b.runId,
            roundOrBlank(pair.a && pair.a.wallMs), roundOrBlank(pair.b && pair.b.wallMs),
            value(pair.a, "steps"), value(pair.b, "steps"),
            value(pair.a, "inputTokens"), value(pair.b, "inputTokens"),
            value(pair.a, "outputTokens"), value(pair.b, "outputTokens"),
            value(pair.a, "estimatedCostUsd"), value(pair.b, "estimatedCostUsd"),
            pair.settings,
        ].map(csvField).join(","));
    }
    return lines.join("\n") + "\n";
}

/** A run by full id or by a prefix that matches exactly one run. */
function findRun(runs, id) {
    const exact = runs.find(run => run.runId === id);
    if (exact) {
        return { run: exact };
    }
    const matches = runs.filter(run => run.runId.startsWith(id));
    if (matches.length === 1) {
        return { run: matches[0] };
    }
    return { error: matches.length === 0 ? `No run matches ${id}.` : `${id} matches ${matches.length} runs; use a longer prefix.` };
}

function parseArgs(argv) {
    const options = { positional: [], all: false, csv: false, steps: false, compare: undefined, error: undefined };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--all") {
            options.all = true;
        } else if (arg === "--csv") {
            options.csv = true;
        } else if (arg === "--steps") {
            options.steps = true;
        } else if (arg === "--compare") {
            const ids = argv.slice(i + 1, i + 3);
            if (ids.length < 2 || ids.some(id => id.startsWith("--"))) {
                options.error = "--compare needs two run ids.";
            }
            options.compare = ids;
            i += 2;
        } else if (arg.startsWith("--")) {
            options.error = `Unknown option ${arg}.`;
        } else {
            options.positional.push(arg);
        }
    }
    if (!options.error && options.positional.length !== 1) {
        options.error = "Give one trace file or migrated project directory.";
    }
    return options;
}

/** Returns the process exit code; `out`/`err` are injectable for tests. */
function main(argv, out = process.stdout, err = process.stderr) {
    const options = parseArgs(argv);
    if (options.error) {
        err.write(`${USAGE}\n${options.error}\n`);
        return 2;
    }
    let file = options.positional[0];
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
    if (options.compare) {
        const [a, b] = options.compare.map(id => findRun(runs, id));
        const problem = [a, b].find(found => found.error);
        if (problem) {
            err.write(`${problem.error}\n`);
            return 1;
        }
        const [summaryA, summaryB] = [summarizeRun(a.run), summarizeRun(b.run)];
        out.write(options.csv ? formatCompareCsv(summaryA, summaryB) : formatCompare(summaryA, summaryB));
    } else {
        const summaries = (options.all ? runs : [runs[runs.length - 1]]).map(summarizeRun);
        if (options.csv) {
            out.write(formatCsv(summaries));
            if (options.steps) {
                err.write("--steps is text only; left out of the CSV.\n");
            }
        } else {
            out.write(formatTable(summaries));
            if (options.steps) {
                out.write("\n" + formatSteps(summaries));
            }
        }
    }
    if (malformed > 0) {
        err.write(`Skipped ${malformed} malformed line(s).\n`);
    }
    return 0;
}

if (require.main === module) {
    process.exitCode = main(process.argv.slice(2));
}

module.exports = {
    STEP_CAP, parseTrace, unionMs, summarizeRun, formatTable, formatCsv, formatSteps,
    compareRuns, formatCompare, formatCompareCsv, main,
};
