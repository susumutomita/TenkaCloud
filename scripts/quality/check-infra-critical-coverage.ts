#!/usr/bin/env bun
/**
 * Issue #2758: infrastructure の high-risk ファイルに限定した coverage ratchet (Phase 1)。
 *
 * infrastructure 全体はまだ #1424 の 100% gate 対象外 (report-only, aggregate %表示のみ) —
 * その方針自体は変えない。 だが AssumeRole/ExternalId・tenant isolation・deploy state
 * machine・scoring・delete lifecycle・auth boundary (`scripts/quality/infra-critical-paths.ts`
 * の registry) は壊れると競技者アカウントへの越境や不正スコアリングに直結するため、
 * jscpd baseline ratchet (`check-duplication.ts`) と同じ形で「今の値からの回帰だけ」を
 * 検出する。 100% を要求する gate ではない。
 *
 * `infrastructure/coverage/lcov.info` (= `cd infrastructure && bun run test:coverage` /
 * CI の `scripts/workspace/run-coverage.ts --shard infrastructure` が生成) を per-file に
 * パースし、 registry の各ファイルの lines/functions/branches % を
 * `scripts/quality/infra-critical-coverage-baseline.json` と比較する。
 *
 * SF: のパス表記は実行経路によって異なる — ローカルで `cd infrastructure && bun run
 * test:coverage` を直接叩くと workspace 相対 (`SF:lib/...`) のまま、 CI の
 * `run-coverage.ts` 経由だと最後に走る `fix-coverage-paths.ts` が repo-root 相対
 * (`SF:infrastructure/lib/...`) へ prefix する。 両方を同じ registry キー
 * (`infrastructure/lib/...`) に正規化して比較する。
 *
 * Usage:
 *   bun run scripts/quality/check-infra-critical-coverage.ts            — gate (下降で exit 1)
 *   bun run scripts/quality/check-infra-critical-coverage.ts --update   — baseline を現状で更新
 *
 * `make infra-coverage-check` はテストを再実行しない — 既存の
 * `infrastructure/coverage/lcov.info` をそのまま読む (再実行は `make test-coverage` 等が担う)。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type CriticalPathEntry, INFRA_CRITICAL_PATHS } from "./infra-critical-paths";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LCOV_PATH = join(REPO_ROOT, "infrastructure", "coverage", "lcov.info");
const BASELINE_PATH = join(
  REPO_ROOT,
  "scripts",
  "quality",
  "infra-critical-coverage-baseline.json",
);

// float 丸め誤差 (同じ lcov から生成した値でも再計算のたびに末尾が揺れることがある) を
// 回帰と誤検知しないための許容幅。 jscpd ratchet は整数行数なので epsilon 不要だが、
// coverage は % (小数) なので必要。
const EPSILON = 0.01;

interface Metric {
  readonly found: number;
  readonly hit: number;
}

export interface LcovFileTotals {
  readonly lines: Metric;
  readonly functions: Metric;
  readonly branches: Metric;
}

export interface FileMetricPct {
  readonly lines: number;
  readonly functions: number;
  readonly branches: number;
}

// lcov のメトリクス行 key → どの metric の found/hit に足すか。 check-coverage-gate.ts の
// LCOV_KEY_MAP と同じ発想 (if/else 連鎖より認知的複雑度が低い) だが、 あちらは全 workspace
// 横断の集計 (SF: を無視) なのに対しこちらは SF: ごとに区切る per-file 集計なので、 現在の
// SF を追跡する外側のループごと切り分けている — 抽出すると「同じに見えるが責務が違う」
// 薄いラッパーが増えるだけなので、 意図的にこの 1 ファイル内で完結させる。
const LCOV_KEY_MAP: Record<string, readonly [keyof LcovFileTotals, "found" | "hit"]> = {
  LF: ["lines", "found"],
  LH: ["lines", "hit"],
  FNF: ["functions", "found"],
  FNH: ["functions", "hit"],
  BRF: ["branches", "found"],
  BRH: ["branches", "hit"],
};

function emptyTotals(): { lines: Metric; functions: Metric; branches: Metric } {
  return {
    lines: { found: 0, hit: 0 },
    functions: { found: 0, hit: 0 },
    branches: { found: 0, hit: 0 },
  };
}

/** SF: を境に record を切り、 各 source file の lines/functions/branches found・hit を集計する。 */
export function parseLcovPerFile(lcov: string): Record<string, LcovFileTotals> {
  const perFile: Record<string, ReturnType<typeof emptyTotals>> = {};
  let currentFile: string | null = null;

  for (const line of lcov.split("\n")) {
    if (line.startsWith("SF:")) {
      currentFile = line.slice(3).trim();
      perFile[currentFile] ??= emptyTotals();
      continue;
    }
    if (line === "end_of_record") {
      currentFile = null;
      continue;
    }
    if (currentFile === null) continue;

    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const target = LCOV_KEY_MAP[line.slice(0, idx)];
    if (!target) continue;
    const n = Number(line.slice(idx + 1));
    if (Number.isNaN(n)) continue;
    perFile[currentFile][target[0]][target[1]] += n;
  }

  return perFile;
}

/** found===0 (計測対象なし) は 100% 扱い (check-coverage-gate.ts の metricPct と同じ規約)。 */
export function metricPct(m: Metric): number {
  return m.found === 0 ? 100 : Math.round((m.hit / m.found) * 10000) / 100;
}

export function pctForFile(totals: LcovFileTotals): FileMetricPct {
  return {
    lines: metricPct(totals.lines),
    functions: metricPct(totals.functions),
    branches: metricPct(totals.branches),
  };
}

/**
 * SF: の表記ゆれ (workspace 相対 `lib/...` か repo-root 相対 `infrastructure/lib/...` か) を
 * registry キー (常に repo-root 相対 `infrastructure/...`) に正規化する。
 */
export function canonicalizeLcovPath(sf: string): string {
  return sf.startsWith("infrastructure/") ? sf : `infrastructure/${sf}`;
}

export interface CollectResult {
  readonly percentages: Readonly<Record<string, FileMetricPct>>;
  readonly missingFromLcov: readonly string[];
}

/**
 * registry の各 entry を lcov の per-file 集計から引く。 lcov に一切現れない
 * (= rename でパスがずれた、 あるいはどのテストからも import されていない) entry は
 * `missingFromLcov` に積む — 0% として黙って比較させると「実は計測すらされていない」
 * 状態を検知できなくなるため、 呼び出し側で loud に fail させる。
 */
export function collectActualPercentages(
  perFile: Readonly<Record<string, LcovFileTotals>>,
  registry: readonly CriticalPathEntry[],
): CollectResult {
  const percentages: Record<string, FileMetricPct> = {};
  const missingFromLcov: string[] = [];

  const canonical: Record<string, LcovFileTotals> = {};
  for (const [sf, totals] of Object.entries(perFile)) {
    canonical[canonicalizeLcovPath(sf)] = totals;
  }

  for (const entry of registry) {
    const totals = canonical[entry.path];
    if (!totals) {
      missingFromLcov.push(entry.path);
      continue;
    }
    percentages[entry.path] = pctForFile(totals);
  }

  return { percentages, missingFromLcov };
}

export interface FileRegression {
  readonly path: string;
  readonly metric: keyof FileMetricPct;
  readonly baseline: number;
  readonly actual: number;
}

/** baseline 未記載の entry は新規追加として扱い (0% baseline)、 回帰対象にしない。 */
export function compareToBaseline(
  actual: Readonly<Record<string, FileMetricPct>>,
  baseline: Readonly<Record<string, FileMetricPct>>,
): {
  readonly regressions: readonly FileRegression[];
  readonly improvements: readonly FileRegression[];
} {
  const regressions: FileRegression[] = [];
  const improvements: FileRegression[] = [];
  const metrics: readonly (keyof FileMetricPct)[] = ["lines", "functions", "branches"];

  for (const [path, pct] of Object.entries(actual)) {
    const base = baseline[path];
    for (const metric of metrics) {
      const baselineValue = base ? base[metric] : 0;
      const actualValue = pct[metric];
      if (actualValue < baselineValue - EPSILON) {
        regressions.push({ path, metric, baseline: baselineValue, actual: actualValue });
      } else if (actualValue > baselineValue + EPSILON) {
        improvements.push({ path, metric, baseline: baselineValue, actual: actualValue });
      }
    }
  }
  return { regressions, improvements };
}

/** registry に載ったパスが repo に実在するかを起動時に確認する。 rename の silent drop 防止。 */
export function findMissingRegistryFiles(
  registry: readonly CriticalPathEntry[],
  repoRoot: string,
): readonly string[] {
  return registry
    .filter((entry) => !existsSync(join(repoRoot, entry.path)))
    .map((entry) => entry.path);
}

function readBaseline(): Record<string, FileMetricPct> {
  if (!existsSync(BASELINE_PATH)) return {};
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Record<string, FileMetricPct>;
}

function sortedRecord<T>(totals: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(totals).sort(([a], [b]) => a.localeCompare(b)));
}

function formatPct(pct: FileMetricPct): string {
  return `lines ${pct.lines}% / functions ${pct.functions}% / branches ${pct.branches}%`;
}

export function main(argv: readonly string[]): number {
  const update = argv.includes("--update");

  const missingFiles = findMissingRegistryFiles(INFRA_CRITICAL_PATHS, REPO_ROOT);
  if (missingFiles.length > 0) {
    console.error("NG scripts/quality/infra-critical-paths.ts に存在しないファイルがあります:");
    for (const path of missingFiles) {
      console.error(`  - ${path}`);
    }
    console.error(
      "\nファイルが rename/削除された場合は registry を更新してください (silent drop を防ぐため fail します)。",
    );
    return 1;
  }

  if (!existsSync(LCOV_PATH)) {
    console.error(
      `NG ${LCOV_PATH} が見つかりません。 先に \`cd infrastructure && bun run test:coverage\` (または \`make test-coverage\`) を実行してください。`,
    );
    return 1;
  }

  const perFile = parseLcovPerFile(readFileSync(LCOV_PATH, "utf8"));
  const { percentages, missingFromLcov } = collectActualPercentages(perFile, INFRA_CRITICAL_PATHS);

  if (missingFromLcov.length > 0) {
    console.error("NG lcov に coverage データが見当たらない registry ファイルがあります:");
    for (const path of missingFromLcov) {
      console.error(`  - ${path}`);
    }
    console.error(
      "\nrename でパスがずれたか、 どのテストからも import されていない可能性があります。 " +
        "0% として黙って比較しないため fail します — registry のパスを確認するか、 " +
        "対応するテストを追加してください。",
    );
    return 1;
  }

  if (update) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(sortedRecord(percentages), null, 2)}\n`, "utf8");
    console.log(`infra-critical-coverage baseline updated: ${BASELINE_PATH}`);
    for (const [path, pct] of Object.entries(sortedRecord(percentages))) {
      console.log(`  ${path}: ${formatPct(pct)}`);
    }
    return 0;
  }

  const baseline = readBaseline();
  const { regressions, improvements } = compareToBaseline(percentages, baseline);

  if (improvements.length > 0) {
    console.log("coverage improved above the baseline for some files — consider ratcheting up:");
    for (const d of improvements) {
      console.log(`  ${d.path} [${d.metric}]: ${d.baseline}% → ${d.actual}%`);
    }
    console.log("  (bun run scripts/quality/check-infra-critical-coverage.ts --update)");
  }

  if (regressions.length === 0) {
    console.log(
      `OK ${INFRA_CRITICAL_PATHS.length} critical-path files — no coverage regression vs baseline.`,
    );
    return 0;
  }

  console.error(
    "NG coverage decreased vs scripts/quality/infra-critical-coverage-baseline.json for a high-risk file:",
  );
  for (const d of regressions) {
    console.error(`  ${d.path} [${d.metric}]: baseline ${d.baseline}% → actual ${d.actual}%`);
  }
  console.error(
    "\nこれらのファイルは AssumeRole/ExternalId・tenant isolation・deploy state machine・" +
      "scoring・delete lifecycle・auth boundary のいずれかを担う high-risk path です " +
      "(scripts/quality/infra-critical-paths.ts)。 テストを直してから再実行してください " +
      "(意図的な仕様変更で baseline を下げる場合は PR body に理由を書いた上で --update)。",
  );
  return 1;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
