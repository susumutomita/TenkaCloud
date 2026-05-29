#!/usr/bin/env bun
/**
 * Coverage ratchet gate (#1424).
 *
 * Reads each workspace's `coverage/lcov.info` (already emitted by the per-workspace
 * `test:coverage` scripts), computes line / branch / function coverage, and fails
 * if any metric drops below the recorded floor in `scripts/coverage-baseline.json`.
 *
 * This is a *ratchet*: floors only move up, when a contributor runs `--update`
 * after genuinely improving coverage. Between updates the gate blocks any
 * regression, so the repo climbs toward 100% and can never silently slide back.
 *
 * Deliberately a standalone gate over lcov rather than a `vitest.config` change:
 * editing the shared test configs to enforce/relax thresholds is exactly the
 * "edit config to mask failures" pattern the repo prohibits. This script only
 * reads output and is wired into CI as its own step.
 *
 * Usage:
 *   bun run scripts/check-coverage.ts            # gate (CI): fail on regression
 *   bun run scripts/check-coverage.ts --update   # ratchet the baseline to current
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = join(REPO_ROOT, "scripts", "coverage-baseline.json");

/**
 * Workspaces that emit coverage. Must stay in sync with the root `test:coverage`
 * script chain in `package.json`. (`apps/cli` has no `test:coverage`; the
 * `@tenkacloud/problem-runtime` package is added once PR #1427 lands.)
 */
const WORKSPACES = [
  "infrastructure",
  "apps/admin-console",
  "apps/application-admin-console",
  "apps/participant-portal",
  "packages/trust-bridge",
  "packages/auth-client",
  "packages/saml-utils",
] as const;

/** Floating-point / line-count dust tolerance, in percentage points. */
const EPSILON = 0.05;

type Metric = "lines" | "branches" | "functions";
type Metrics = Record<Metric, number>;

function pct(hit: number, found: number): number {
  return found === 0 ? 100 : (hit / found) * 100;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function parseLcov(lcovPath: string): Metrics {
  const totals = { LF: 0, LH: 0, BRF: 0, BRH: 0, FNF: 0, FNH: 0 };
  for (const line of readFileSync(lcovPath, "utf8").split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon);
    if (key in totals) totals[key as keyof typeof totals] += Number(line.slice(colon + 1)) || 0;
  }
  return {
    lines: pct(totals.LH, totals.LF),
    branches: pct(totals.BRH, totals.BRF),
    functions: pct(totals.FNH, totals.FNF),
  };
}

function collectCurrent(): Record<string, Metrics> {
  const out: Record<string, Metrics> = {};
  const missing: string[] = [];
  for (const ws of WORKSPACES) {
    const lcov = join(REPO_ROOT, ws, "coverage", "lcov.info");
    if (!existsSync(lcov)) {
      missing.push(ws);
      continue;
    }
    out[ws] = parseLcov(lcov);
  }
  if (missing.length > 0) {
    console.error(
      `[coverage-gate] missing lcov for: ${missing.join(", ")}\n` +
        "Run `make test-coverage` first so every workspace emits coverage/lcov.info.",
    );
    process.exit(2);
  }
  return out;
}

const METRICS: readonly Metric[] = ["lines", "branches", "functions"];
const current = collectCurrent();

if (process.argv.includes("--update")) {
  const rounded: Record<string, Metrics> = {};
  for (const ws of WORKSPACES) {
    const m = current[ws];
    rounded[ws] = {
      lines: round2(m.lines),
      branches: round2(m.branches),
      functions: round2(m.functions),
    };
  }
  writeFileSync(BASELINE_PATH, `${JSON.stringify(rounded, null, 2)}\n`);
  console.log(`[coverage-gate] baseline written: scripts/coverage-baseline.json`);
  process.exit(0);
}

if (!existsSync(BASELINE_PATH)) {
  console.error(
    "[coverage-gate] no baseline found. Seed it with `bun run scripts/check-coverage.ts --update`.",
  );
  process.exit(2);
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Record<string, Metrics>;
let regressed = false;
const lines: string[] = [];

for (const ws of WORKSPACES) {
  const cur = current[ws];
  const floor = baseline[ws] ?? { lines: 0, branches: 0, functions: 0 };
  for (const metric of METRICS) {
    const ok = cur[metric] + EPSILON >= floor[metric];
    if (!ok) regressed = true;
    lines.push(
      `${ok ? "OK  " : "DROP"} ${ws} ${metric}: ${round2(cur[metric])}% (floor ${floor[metric]}%)`,
    );
  }
}

console.log(lines.join("\n"));

if (regressed) {
  console.error(
    "\n[coverage-gate] FAIL — coverage dropped below the baseline floor.\n" +
      "Add tests to cover the new/uncovered code. After a genuine improvement, run\n" +
      "`bun run scripts/check-coverage.ts --update` to ratchet the floor up.",
  );
  process.exit(1);
}

console.log("\n[coverage-gate] OK — no workspace regressed below its coverage floor.");
