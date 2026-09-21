#!/usr/bin/env node
// Every e2e-playwright-tests/*/*.spec.ts file wraps its tests in exactly one
// test.describe.serial(...) block, so its tests share state (the tree, the open webview,
// the on-disk project) across steps. Playwright's own `retries` config already reruns a
// whole serial block from the top on failure — but run-e2e-group's CI re-run step used
// `--last-failed`, which replays only the individually-failed test(s), skipping the
// earlier steps that built the state they depend on.
//
// This script reads the most recent Playwright JSON report for a matrix group and prints
// a '|'-joined, regex-escaped list of the serial block titles that had a failing test, so
// the caller can --grep for (this matrix group) AND (one of those titles) instead, and
// replay each failing block in full. Prints nothing (and exits 0) if no report could be
// read or no failure was found, so the caller can fall back to rerunning the whole group.

const fs = require('fs');
const path = require('path');

// Mirrors aggregate-e2e-results.js's naturalFileOrder: plain string sort would put
// 'e2e-results-rerun-10.json' before 'e2e-results-rerun-2.json'.
function naturalFileOrder(a, b) {
  return path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true });
}

function findLatestReport(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^e2e-results.*\.json$/.test(f))
    .map((f) => path.join(dir, f))
    .sort(naturalFileOrder);
  return files.length ? files[files.length - 1] : null;
}

function specFailed(spec) {
  return (spec.tests || []).some((test) => {
    const results = test.results || [];
    const last = results[results.length - 1];
    return last && last.status !== 'passed' && last.status !== 'skipped';
  });
}

// A suite whose own specs include a failing test is the nearest serial block ancestor of
// that failure (every spec sits directly inside its file's single serial block in this
// suite), regardless of how many describe levels sit above it.
function collectFailingSuiteTitles(suite, out) {
  if ((suite.specs || []).some(specFailed)) out.add(suite.title);
  for (const child of suite.suites || []) collectFailingSuiteTitles(child, out);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error('Usage: extract-failed-serial-groups.js <e2e-reports-dir>');
    process.exit(2);
  }

  const reportFile = findLatestReport(dir);
  if (!reportFile) {
    console.error(`No e2e-results*.json found under ${dir}; caller should fall back to the whole group.`);
    return;
  }

  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  } catch (err) {
    console.error(`Failed to parse ${reportFile}: ${err.message}; caller should fall back to the whole group.`);
    return;
  }

  const titles = new Set();
  for (const suite of report.suites || []) collectFailingSuiteTitles(suite, titles);

  if (titles.size === 0) {
    console.error(`No failing test found in ${reportFile}; caller should fall back to the whole group.`);
    return;
  }

  process.stdout.write([...titles].map(escapeRegExp).join('|'));
}

main();
