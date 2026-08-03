#!/usr/bin/env bun
/**
 * Issue #2513: PR CI の `Run tests with coverage` ステップが ~17m13s かかっている問題への対処。
 *
 * これまで root package.json の `test:coverage` は 17 workspace の `test:coverage` script を
 * `&&` で直列に繋ぐだけだった (= ほぼ全 CI 時間がここに集中)。 本 script はその直列実行を
 * ワークスペース定義として一箇所に集約し (`COVERAGE_WORKSPACES`)、 CI からは
 * `--shard <infrastructure|spas|packages>` で 3 分割 matrix として並列実行できるようにする。
 * `--shard` を渡さなければ従来どおり全 workspace を直列実行する
 * (= `make test-coverage` / `make ci-local` はこのモードのまま、 挙動を変えない)。
 *
 * 各 workspace の実行前後を `▶ <dir>` / `✅ <dir> (<duration>)` で標準出力へ boundary 表示し、
 * 全 workspace 完了後に per-workspace timing summary を表示する。 `GITHUB_STEP_SUMMARY` が
 * 設定されていれば (= GitHub Actions 実行時) 同じ表を GitHub-flavored markdown で追記する。
 *
 * 失敗時は現行の `&&` chain と同じ fail-fast semantics を保つ (最初に失敗した workspace で
 * 停止し、 そこまでの timing summary を表示してから exit 1 = 失敗が workspace に紐づけて追える)。
 * 全 workspace 成功後は `scripts/workspace/fix-coverage-paths.ts` (#993、 idempotent かつ absent file は
 * skip するので shard mode でも安全) を実行し、 その exit code をそのまま伝播する。
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");

export type ShardName = "infrastructure" | "spas" | "packages";

export const SHARD_NAMES: readonly ShardName[] = ["infrastructure", "spas", "packages"];

export interface CoverageWorkspace {
  readonly dir: string;
  readonly filter: string;
  readonly shard: ShardName;
}

// Issue #2513 / #2756: the single source of truth for which workspaces `test:coverage` covers.
// Order + membership must stay identical to the (now-retired) root package.json chain plus
// developer-portal (#2756) — scripts/workspace/run-coverage.test.ts hardcodes the expected
// 18-dir list to catch accidental drops.
export const COVERAGE_WORKSPACES: readonly CoverageWorkspace[] = [
  { dir: "infrastructure", filter: "@TenkaCloud/infrastructure", shard: "infrastructure" },
  { dir: "apps/admin-console", filter: "@TenkaCloud/admin-console", shard: "spas" },
  {
    dir: "apps/application-admin-console",
    filter: "@TenkaCloud/application-admin-console",
    shard: "spas",
  },
  { dir: "apps/participant-portal", filter: "@TenkaCloud/participant-portal", shard: "spas" },
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
  {
    dir: "apps/always-on-control-plane",
    filter: "@tenkacloud/always-on-control-plane",
    shard: "packages",
  },
  // Issue #2756: developer-portal already has a working vitest.config.ts and 18 test files,
  // but its tests never ran in CI (the ci job runs no tests; only this coverage matrix does).
  // Placed on the packages shard, which already hosts the odd-one-out
  // apps/always-on-control-plane and is the fastest shard to absorb the addition.
  { dir: "apps/developer-portal", filter: "@TenkaCloud/developer-portal", shard: "packages" },
];

function shardDirs(shard: ShardName): readonly string[] {
  return COVERAGE_WORKSPACES.filter((ws) => ws.shard === shard).map((ws) => ws.dir);
}

// shard → dirs, derived from COVERAGE_WORKSPACES so the two can never drift apart. The keys are
// written out instead of reduced from SHARD_NAMES because `{} as Record<ShardName, …>` claims a
// shape the empty object does not have: drop a shard from the reduce and the assertion still
// says the key is there. Spelled out, `Record<ShardName, …>` makes a new shard a type error here.
export const SHARDS: Readonly<Record<ShardName, readonly string[]>> = {
  infrastructure: shardDirs("infrastructure"),
  spas: shardDirs("spas"),
  packages: shardDirs("packages"),
};

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
}

export class UsageError extends Error {}

export interface ParsedArgs {
  readonly shard?: ShardName;
  readonly printLcovPaths: boolean;
}

export function lcovPathForWorkspace(ws: CoverageWorkspace): string {
  return `./${ws.dir}/coverage/lcov.info`;
}

export function resolveLcovPaths(shard: ShardName | undefined): readonly string[] {
  return resolveWorkspaces(shard).map(lcovPathForWorkspace);
}

/** No args = every workspace (current serial behavior). `--shard <name>` narrows to one shard. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  let shard: ShardName | undefined;
  let printLcovPaths = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--print-lcov-paths") {
      printLcovPaths = true;
      continue;
    }
    if (arg === "--shard") {
      const candidate = argv[i + 1];
      if (candidate === undefined || !isShardName(candidate)) {
        throw new UsageError(
          `Unknown shard "${candidate}". Known shards: ${SHARD_NAMES.join(", ")}`,
        );
      }
      if (shard !== undefined) {
        throw new UsageError(`--shard was provided more than once`);
      }
      shard = candidate;
      i += 1;
      continue;
    }
    throw new UsageError(
      `Unknown arguments: ${argv.join(" ")}. Usage: bun run scripts/workspace/run-coverage.ts [--shard <${SHARD_NAMES.join("|")}>] [--print-lcov-paths]`,
    );
  }
  return { shard, printLcovPaths };
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

function runWorkspace(ws: CoverageWorkspace): TimingResult {
  console.log(`\n▶ ${ws.dir}`);
  const start = performance.now();
  // Re-entering the same `bun` that is already running this file. mise pins the
  // version, and the process is only ever started by a developer or the CI runner —
  // both own their own PATH.
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- re-entrant bun call
  const result = spawnSync("bun", ["run", "--filter", ws.filter, "test:coverage"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
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
function runWorkspaces(workspaces: readonly CoverageWorkspace[]): {
  readonly results: readonly TimingResult[];
  readonly failed: boolean;
} {
  const results: TimingResult[] = [];
  for (const ws of workspaces) {
    const result = runWorkspace(ws);
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
  const { results, failed } = runWorkspaces(workspaces);

  printSummary(results);

  if (failed) {
    process.exit(1);
  }

  process.exit(runFixCoveragePaths());
}

if (import.meta.main) {
  main();
}
