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
 * Usage: `make test-coverage && bun run scripts/check-coverage-gate.ts`
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

/** 100% を必須とする agent-owned workspace。 回帰したら CI を落とす。 */
export const GATED_WORKSPACES = [
  "apps/admin-console",
  "apps/application-admin-console",
  "apps/participant-portal",
  "apps/cli",
  "packages/auth-client",
  "packages/problem-runtime",
  "packages/saml-utils",
  "packages/trust-bridge",
  "packages/format",
  "packages/coordination-plugin-sdk",
  "packages/web-kit",
] as const;

/** gate しないが現在値を表示する workspace (owner lane、 100% への道筋表示用)。 */
export const REPORTED_WORKSPACES = ["infrastructure"] as const;

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

function main(): void {
  const failures: string[] = [];
  console.log("Coverage gate (#1424) — agent-owned workspaces must be 100%:\n");

  for (const ws of GATED_WORKSPACES) {
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
  for (const ws of REPORTED_WORKSPACES) {
    const r = evaluateWorkspace(ws);
    console.log(`  • ${ws}: ${r.totals ? formatTotals(r.totals) : "(lcov 不在)"}`);
  }

  if (failures.length > 0) {
    console.error(
      `\n${failures.length} workspace が 100% 未満です: ${failures.join(", ")}。 回帰したテストを直してください (config で mask しない)。`,
    );
    process.exit(1);
  }
  console.log(`\n${GATED_WORKSPACES.length} workspace すべて 100%。`);
}

if (import.meta.main) {
  main();
}
