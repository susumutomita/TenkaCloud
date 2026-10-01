#!/usr/bin/env bun
/**
 * Run coverage for the 17 entries in COVERAGE_WORKSPACES.
 * --shard selects portal, app-admin or packages; without it, all entries run sequentially.
 * Each failure stops the run after writing its timing summary. Successful runs normalize
 * LCOV source paths using the same workspace registry before returning.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");

export type ShardName = "portal" | "app-admin" | "packages";

export const SHARD_NAMES: readonly ShardName[] = ["portal", "app-admin", "packages"];

export interface CoverageWorkspace {
  readonly dir: string;
  readonly filter: string;
  readonly shard: ShardName;
}

// The root suite and CI shards share this registry. run-coverage.test.ts pins all 17 entries.
// A shard containing one workspace can split its test files with --part.
export const COVERAGE_WORKSPACES: readonly CoverageWorkspace[] = [
  {
    dir: "apps/application-admin-console",
    filter: "@TenkaCloud/application-admin-console",
    shard: "app-admin",
  },
  { dir: "apps/participant-portal", filter: "@TenkaCloud/participant-portal", shard: "portal" },
  { dir: "packages/trust-bridge", filter: "@TenkaCloud/trust-bridge", shard: "packages" },
  { dir: "packages/auth-client", filter: "@tenkacloud/auth-client", shard: "packages" },
  { dir: "packages/saml-utils", filter: "@tenkacloud/saml-utils", shard: "packages" },
  { dir: "packages/problem-cost", filter: "@tenkacloud/problem-cost", shard: "packages" },
  { dir: "packages/problem-runtime", filter: "@tenkacloud/problem-runtime", shard: "packages" },
  { dir: "packages/problem-sdk", filter: "@tenkacloud/problem-sdk", shard: "packages" },
  { dir: "packages/format", filter: "@tenkacloud/format", shard: "packages" },
  {
    dir: "packages/coordination-plugin-sdk",
    filter: "@tenkacloud/coordination-plugin-sdk",
    shard: "packages",
  },
  { dir: "packages/portal-contracts", filter: "@tenkacloud/portal-contracts", shard: "packages" },
  { dir: "packages/web-kit", filter: "@tenkacloud/web-kit", shard: "packages" },
  {
    dir: "packages/portal-plugin-sdk",
    filter: "@tenkacloud/portal-plugin-sdk",
    shard: "packages",
  },
  { dir: "packages/problem-test-harness", filter: "@tenkacloud/problem-test", shard: "packages" },
  // Issue #2756: developer-portal already has a working vitest.config.ts and 18 test files,
  // but its tests never ran in CI (the ci job runs no tests; only this coverage matrix does).
  // Placed on the packages shard, the fastest shard to absorb the addition.
  { dir: "apps/developer-portal", filter: "@TenkaCloud/developer-portal", shard: "packages" },
  // Issue #2936 Phase 1: the AI evaluation contracts. Pure and AWS-independent, so it sits on
  // the packages shard with the other dependency-light packages.
  { dir: "packages/ai-eval", filter: "@tenkacloud/ai-eval", shard: "packages" },
  // Issue #3036 Phase 0/1: the security drill harness contracts (run state machine, witness
  // schema, finding/patch verdict engine). Pure and AWS-independent, so it sits on the packages
  // shard with the other dependency-light packages.
  { dir: "packages/security-harness", filter: "@tenkacloud/security-harness", shard: "packages" },
];

function shardDirs(shard: ShardName): readonly string[] {
  return COVERAGE_WORKSPACES.filter((ws) => ws.shard === shard).map((ws) => ws.dir);
}

// shard → dirs, derived from COVERAGE_WORKSPACES so the two can never drift apart. The keys are
// written out instead of reduced from SHARD_NAMES because `{} as Record<ShardName, …>` claims a
// shape the empty object does not have: drop a shard from the reduce and the assertion still
// says the key is there. Spelled out, `Record<ShardName, …>` makes a new shard a type error here.
export const SHARDS: Readonly<Record<ShardName, readonly string[]>> = {
  portal: shardDirs("portal"),
  "app-admin": shardDirs("app-admin"),
  packages: shardDirs("packages"),
};

/**
 * CI runs six coverage legs: three app-admin, two portal and one packages leg.
 * run-coverage.test.ts checks the workflow matrix and Codecov build count against this map.
 * A shard split with --part must contain exactly one workspace.
 */
export const COVERAGE_PARTS: Readonly<Record<ShardName, number>> = {
  "app-admin": 3,
  portal: 2,
  packages: 1,
};

export interface CoverageMatrixLeg {
  readonly shard: ShardName;
  readonly part: number;
  readonly parts: number;
}

/** Every (shard, part) pair CI runs — one GitHub Actions matrix leg, one Codecov upload. */
export function coverageMatrixLegs(): readonly CoverageMatrixLeg[] {
  return SHARD_NAMES.flatMap((shard) =>
    Array.from({ length: COVERAGE_PARTS[shard] }, (_unused, index) => ({
      shard,
      part: index + 1,
      parts: COVERAGE_PARTS[shard],
    })),
  );
}

function isShardName(value: string): value is ShardName {
  return (SHARD_NAMES as readonly string[]).includes(value);
}

/** Startup validation: fail loudly instead of silently skipping / double-running a workspace. */
export function validateWorkspaces(workspaces: readonly CoverageWorkspace[]): void {
  const seenDirs = new Set<string>();
  for (const ws of workspaces) {
    if (seenDirs.has(ws.dir)) {
      throw new Error(`run-coverage: duplicate workspace dir "${ws.dir}"`);
    }
    seenDirs.add(ws.dir);
    if (!isShardName(ws.shard)) {
      throw new Error(
        `run-coverage: workspace "${ws.dir}" has unknown shard "${ws.shard}". Known shards: ${SHARD_NAMES.join(", ")}`,
      );
    }
    const abs = resolve(REPO_ROOT, ws.dir);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      throw new Error(`run-coverage: workspace dir "${ws.dir}" does not exist`);
    }
  }
  validateShardParts(workspaces);
}

/**
 * A shard split across CI runners must hold exactly one workspace: `--part` maps onto Vitest's
 * `--shard`, which splits ONE workspace's file list. Splitting a multi-workspace shard would make
 * every part re-enter every workspace and pay its startup for a fraction of its files.
 */
export function validateShardParts(workspaces: readonly CoverageWorkspace[]): void {
  for (const shard of SHARD_NAMES) {
    const parts = COVERAGE_PARTS[shard];
    if (!Number.isInteger(parts) || parts < 1) {
      throw new Error(`run-coverage: shard "${shard}" has an invalid part count ${parts}`);
    }
    if (parts === 1) continue;
    const dirs = workspaces.filter((ws) => ws.shard === shard).map((ws) => ws.dir);
    if (dirs.length !== 1) {
      throw new Error(
        `run-coverage: shard "${shard}" is split into ${parts} parts but holds ${dirs.length} workspaces: ${dirs.join(", ")}`,
      );
    }
  }
}

export class UsageError extends Error {}

/**
 * A `--part i/N` split of one shard's test files, forwarded to Vitest as `--shard=i/N`.
 *
 * Rebalancing the shards only helps until the slowest single workspace becomes the floor: the
 * infrastructure suite alone is ~5m44s of wall time on a 4-core runner (538 files), so no
 * arrangement of whole workspaces gets a leg under a minute. Vitest's own `--shard` splits that
 * one workspace's file list across runners, which is the only lever left once a shard holds a
 * single workspace.
 */
export interface ShardPart {
  readonly index: number;
  readonly total: number;
}

export interface ParsedArgs {
  readonly shard?: ShardName;
  readonly part?: ShardPart;
  readonly printLcovPaths: boolean;
}

export function lcovPathForWorkspace(ws: CoverageWorkspace): string {
  return `./${ws.dir}/coverage/lcov.info`;
}

export function resolveLcovPaths(shard: ShardName | undefined): readonly string[] {
  return resolveWorkspaces(shard).map(lcovPathForWorkspace);
}

export function parseShardPart(raw: string | undefined): ShardPart {
  const match = /^(\d+)\/(\d+)$/.exec(raw ?? "");
  if (!match) {
    throw new UsageError(`--part expects "<index>/<total>" (e.g. "2/6"), got "${raw}"`);
  }
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (total < 1) {
    throw new UsageError(`--part total must be at least 1, got "${raw}"`);
  }
  if (index < 1 || index > total) {
    throw new UsageError(`--part index must be within 1..${total}, got "${raw}"`);
  }
  return { index, total };
}

/**
 * Rejects a `--part` that cannot be honoured. Kept out of `parseArgs` so that function stays
 * under the repo's cognitive-complexity ceiling and each rule reads on its own.
 */
function validatePartRequest(shard: ShardName | undefined, part: ShardPart | undefined): void {
  if (part === undefined || part.total <= 1) return;
  if (shard === undefined) {
    throw new UsageError(`--part requires --shard: it splits one shard's test files, not all`);
  }
  // A multi-workspace shard would pay Vitest's per-workspace startup on every part while each
  // part runs a fraction of that workspace's files — more wall time, not less. Splitting is
  // therefore only offered where it pays: a shard that holds exactly one workspace.
  const dirs = SHARDS[shard];
  if (dirs.length !== 1) {
    throw new UsageError(
      `--part needs a single-workspace shard; "${shard}" holds ${dirs.length}: ${dirs.join(", ")}`,
    );
  }
}

function parseShardFlag(value: string | undefined, alreadySet: boolean): ShardName {
  if (value === undefined || !isShardName(value)) {
    throw new UsageError(`Unknown shard "${value}". Known shards: ${SHARD_NAMES.join(", ")}`);
  }
  if (alreadySet) {
    throw new UsageError(`--shard was provided more than once`);
  }
  return value;
}

/**
 * No args = every workspace (current serial behavior). `--shard <name>` narrows to one shard,
 * and `--part <i>/<N>` splits that shard's test files N ways (Vitest `--shard`).
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  let shard: ShardName | undefined;
  let part: ShardPart | undefined;
  let printLcovPaths = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--print-lcov-paths") {
      printLcovPaths = true;
    } else if (arg === "--part") {
      if (part !== undefined) throw new UsageError(`--part was provided more than once`);
      part = parseShardPart(argv[i + 1]);
      i += 1;
    } else if (arg === "--shard") {
      shard = parseShardFlag(argv[i + 1], shard !== undefined);
      i += 1;
    } else {
      throw new UsageError(
        `Unknown arguments: ${argv.join(" ")}. Usage: bun run scripts/workspace/run-coverage.ts [--shard <${SHARD_NAMES.join("|")}>] [--part <i>/<N>] [--print-lcov-paths]`,
      );
    }
  }

  validatePartRequest(shard, part);
  return { shard, part, printLcovPaths };
}

export function resolveWorkspaces(shard: ShardName | undefined): readonly CoverageWorkspace[] {
  if (shard === undefined) {
    return COVERAGE_WORKSPACES;
  }
  return COVERAGE_WORKSPACES.filter((ws) => ws.shard === shard);
}

/** Sub-minute durations print as seconds; minute-plus durations print as `<m>m<s>s`. */
export function formatDuration(ms: number): string {
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${minutes}m${seconds.toFixed(1)}s`;
}

interface TimingResult {
  readonly dir: string;
  readonly durationMs: number;
  readonly success: boolean;
}

export function vitestPartArgs(part: ShardPart | undefined): string[] {
  // `--shard=1/1` is a no-op split that Vitest still validates against the file count, so an
  // unsplit run passes nothing at all rather than a degenerate flag.
  if (!part || part.total <= 1) return [];
  return [`--shard=${part.index}/${part.total}`];
}

function runWorkspace(ws: CoverageWorkspace, part?: ShardPart): TimingResult {
  const partSuffix = part && part.total > 1 ? ` (part ${part.index}/${part.total})` : "";
  console.log(`\n▶ ${ws.dir}${partSuffix}`);
  const start = performance.now();
  // Re-entering the same `bun` that is already running this file. mise pins the
  // version, and the process is only ever started by a developer or the CI runner —
  // both own their own PATH.
  const args = ["run", "--filter", ws.filter, "test:coverage", ...vitestPartArgs(part)];
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- re-entrant bun call
  const result = spawnSync("bun", args, { cwd: REPO_ROOT, stdio: "inherit" });
  const durationMs = performance.now() - start;
  const success = result.status === 0;
  if (success) {
    console.log(`✅ ${ws.dir} (${formatDuration(durationMs)})`);
  } else {
    console.error(`❌ ${ws.dir} failed (${formatDuration(durationMs)})`);
  }
  return { dir: ws.dir, durationMs, success };
}

/** Fail-fast: stop at the first failing workspace, same semantics as the old `&&` chain. */
function runWorkspaces(
  workspaces: readonly CoverageWorkspace[],
  part?: ShardPart,
): {
  readonly results: readonly TimingResult[];
  readonly failed: boolean;
} {
  const results: TimingResult[] = [];
  for (const ws of workspaces) {
    const result = runWorkspace(ws, part);
    results.push(result);
    if (!result.success) {
      return { results, failed: true };
    }
  }
  return { results, failed: false };
}

function buildSummaryLines(results: readonly TimingResult[]): string[] {
  const lines = ["", "Coverage timing summary (#2513):"];
  for (const r of results) {
    const mark = r.success ? "✅" : "❌";
    lines.push(`  ${mark} ${r.dir.padEnd(40)} ${formatDuration(r.durationMs)}`);
  }
  const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0);
  lines.push(`  ${"total".padEnd(43)} ${formatDuration(totalMs)}`);
  return lines;
}

function buildSummaryMarkdown(results: readonly TimingResult[]): string {
  const rows = results
    .map((r) => `| ${r.success ? "✅" : "❌"} \`${r.dir}\` | ${formatDuration(r.durationMs)} |`)
    .join("\n");
  const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0);
  return [
    "### Coverage timing summary (#2513)",
    "",
    "| workspace | duration |",
    "| --- | --- |",
    rows,
    `| **total** | **${formatDuration(totalMs)}** |`,
    "",
  ].join("\n");
}

function printSummary(results: readonly TimingResult[]): void {
  for (const line of buildSummaryLines(results)) {
    console.log(line);
  }
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    appendFileSync(summaryPath, `${buildSummaryMarkdown(results)}\n`);
  }
}

function runFixCoveragePaths(): number {
  // Re-entering the same `bun` that is already running this file. mise pins the
  // version, and the process is only ever started by a developer or the CI runner —
  // both own their own PATH.
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- re-entrant bun call
  const result = spawnSync("bun", ["run", "scripts/workspace/fix-coverage-paths.ts"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  return result.status ?? 1;
}

function main(): void {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }

  validateWorkspaces(COVERAGE_WORKSPACES);

  if (parsed.printLcovPaths) {
    console.log(resolveLcovPaths(parsed.shard).join(","));
    return;
  }

  const workspaces = resolveWorkspaces(parsed.shard);
  const { results, failed } = runWorkspaces(workspaces, parsed.part);

  printSummary(results);

  if (failed) {
    process.exit(1);
  }

  process.exit(runFixCoveragePaths());
}

if (import.meta.main) {
  main();
}
