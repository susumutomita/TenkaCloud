#!/usr/bin/env bun
/**
 * Issue #1424: 100% coverage を CI で enforce する gate。
 *
 * `make test-coverage` が各 workspace 配下に生成する `coverage/lcov.info` を読み、
 * **agent-owned workspace (3 SPA + 共有 package)** が lines / functions / branches すべて
 * 100% であることを保証する。 1 つでも下回ったら exit 1 で CI を落とす (= 回帰検知)。
 *
 * `infrastructure` は owner lane (CDK + Lambda handlers) かつ現状 100% 未満なので gate からは
 * 外し、 現在値だけ参考表示する (= #1424 の「100% への道筋を示す」)。 100% に到達したら
 * GATED_WORKSPACES に移す。
 *
 * lcov に「statements」は無いが、 v8 では statements ≈ lines。 lines/functions/branches の
 * 3 軸が 100% なら実質 4 軸 100% (= 回帰すれば必ずこのいずれかが落ちる)。
 *
 * Usage: `make test-coverage && bun run .claude/skills/quality-gates/scripts/check-coverage-gate.ts`
 * (run from the repo root; relocated off the product body — see SKILL.md).
 *
 * Issue #2513: `--shard <infrastructure|spas|packages>` narrows both GATED_WORKSPACES and
 * REPORTED_WORKSPACES down to the workspaces `scripts/workspace/run-coverage.ts`'s SHARDS assigns to that
 * shard, so CI's 3-way coverage matrix can gate each shard independently. CI calls this script
 * directly (not through run.ts) inside each shard job. No flag = full gate, unchanged.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SHARD_NAMES, SHARDS, type ShardName } from "../../../../scripts/workspace/run-coverage.ts";

const REPO_ROOT = process.cwd();

/** 100% を必須とする agent-owned workspace。 回帰したら CI を落とす。 */
export const GATED_WORKSPACES = [
  "apps/admin-console",
  "apps/application-admin-console",
  "apps/participant-portal",
  "packages/auth-client",
  "packages/problem-runtime",
  "packages/saml-utils",
  "packages/trust-bridge",
  "packages/format",
  "packages/coordination-plugin-sdk",
  "packages/web-kit",
] as const;

/** gate しないが現在値を表示する workspace (owner lane、 100% への道筋表示用)。 */
export const REPORTED_WORKSPACES = [
  "infrastructure",
  // Issue #2292 Phase 3 foundation. Move to GATED_WORKSPACES once its first
  // auth/storage branch suite reaches 100%.
  "apps/always-on-control-plane",
  // Issue #2756: developer-portal's tests now run in CI (packages shard) for the first
  // time, but its authoring-tool scripts (generate-catalog.ts / generate-reference.ts /
  // check-internal-links.ts) sit at ~53% lines / ~24% branches — a real gap, not a few
  // stray branches, so it starts report-only (段階導入) rather than gated. Move to
  // GATED_WORKSPACES once those scripts' coverage reaches 100%.
  "apps/developer-portal",
  // Issue #2951: the tcloud CLI is new. Its pure modules are covered, but the thin
  // side-effect entrypoint (src/cli.ts: keychain probing, config file I/O, process.exit)
  // is not, so it starts report-only like every other new workspace here. Move it to
  // GATED_WORKSPACES once the entrypoint is covered too.
  "packages/tcloud",
] as const;

interface Metric {
  readonly found: number;
  readonly hit: number;
}
export interface LcovTotals {
  readonly lines: Metric;
  readonly functions: Metric;
  readonly branches: Metric;
}

// lcov のメトリクス行 key → (どの metric の found/hit に足すか)。 if/else 連鎖より
// 認知的複雑度が低く、 lcov の prefix 追加にも開かれている。
const LCOV_KEY_MAP: Record<string, readonly [keyof LcovTotals, "found" | "hit"]> = {
  LF: ["lines", "found"],
  LH: ["lines", "hit"],
  FNF: ["functions", "found"],
  FNH: ["functions", "hit"],
  BRF: ["branches", "found"],
  BRH: ["branches", "hit"],
};

/** lcov.info を集計して lines / functions / branches の found・hit 合計を返す。 */
export function parseLcovTotals(lcov: string): LcovTotals {
  const acc = {
    lines: { found: 0, hit: 0 },
    functions: { found: 0, hit: 0 },
    branches: { found: 0, hit: 0 },
  };
  for (const line of lcov.split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const target = LCOV_KEY_MAP[line.slice(0, idx)];
    if (!target) continue;
    const n = Number(line.slice(idx + 1));
    if (Number.isNaN(n)) continue;
    acc[target[0]][target[1]] += n;
  }
  return acc;
}

/** found===hit (= 100%) なら true。 found===0 (計測対象なし) も 100% 扱い。 */
export function isMetricFull(m: Metric): boolean {
  return m.hit >= m.found;
}

export function isFullyCovered(t: LcovTotals): boolean {
  return isMetricFull(t.lines) && isMetricFull(t.functions) && isMetricFull(t.branches);
}

/** 表示用 % (found=0 は 100)。 */
export function metricPct(m: Metric): number {
  return m.found === 0 ? 100 : Math.round((m.hit / m.found) * 10000) / 100;
}

interface WorkspaceResult {
  readonly workspace: string;
  readonly totals: LcovTotals | null; // null = lcov 不在
  readonly full: boolean;
}

function evaluateWorkspace(workspace: string): WorkspaceResult {
  const lcovPath = join(REPO_ROOT, workspace, "coverage", "lcov.info");
  if (!existsSync(lcovPath)) {
    return { workspace, totals: null, full: false };
  }
  const totals = parseLcovTotals(readFileSync(lcovPath, "utf8"));
  return { workspace, totals, full: isFullyCovered(totals) };
}

function formatTotals(t: LcovTotals): string {
  return `lines ${metricPct(t.lines)}% / functions ${metricPct(t.functions)}% / branches ${metricPct(t.branches)}%`;
}

function isShardName(value: string): value is ShardName {
  return (SHARD_NAMES as readonly string[]).includes(value);
}

/** Issue #2513: `--shard <name>` narrows the gate to one shard; no args = full gate (unchanged). */
function parseShardArg(argv: readonly string[]): ShardName | undefined {
  if (argv.length === 0) {
    return undefined;
  }
  if (argv.length === 2 && argv[0] === "--shard") {
    const candidate = argv[1];
    if (candidate !== undefined && isShardName(candidate)) {
      return candidate;
    }
    console.error(`Unknown shard "${argv[1]}". Known shards: ${SHARD_NAMES.join(", ")}`);
    process.exit(2);
  }
  console.error(
    `Unknown arguments: ${argv.join(" ")}. Usage: bun run check-coverage-gate.ts [--shard <${SHARD_NAMES.join("|")}>]`,
  );
  process.exit(2);
}

function main(): void {
  const shard = parseShardArg(process.argv.slice(2));
  const gatedWorkspaces = shard
    ? GATED_WORKSPACES.filter((ws) => SHARDS[shard].includes(ws))
    : GATED_WORKSPACES;
  const reportedWorkspaces = shard
    ? REPORTED_WORKSPACES.filter((ws) => SHARDS[shard].includes(ws))
    : REPORTED_WORKSPACES;

  const failures: string[] = [];
  console.log(
    `Coverage gate (#1424)${shard ? ` [shard: ${shard}]` : ""} — agent-owned workspaces must be 100%:\n`,
  );

  for (const ws of gatedWorkspaces) {
    const r = evaluateWorkspace(ws);
    if (r.totals === null) {
      console.error(
        `  ❌ ${ws}: coverage/lcov.info が見つかりません (make test-coverage を先に実行)`,
      );
      failures.push(ws);
    } else if (!r.full) {
      console.error(`  ❌ ${ws}: ${formatTotals(r.totals)}`);
      failures.push(ws);
    } else {
      console.log(`  ✅ ${ws}: 100%`);
    }
  }

  console.log("\n参考 (gate 対象外、 100% への道筋):");
  for (const ws of reportedWorkspaces) {
    const r = evaluateWorkspace(ws);
    console.log(`  • ${ws}: ${r.totals ? formatTotals(r.totals) : "(lcov 不在)"}`);
  }

  if (failures.length > 0) {
    console.error(
      `\n${failures.length} workspace が 100% 未満です: ${failures.join(", ")}。 回帰したテストを直してください (config で mask しない)。`,
    );
    process.exit(1);
  }
  console.log(`\n${gatedWorkspaces.length} workspace すべて 100%。`);
}

if (import.meta.main) {
  main();
}
