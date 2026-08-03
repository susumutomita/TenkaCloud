#!/usr/bin/env bun
/**
 * jscpd ベースライン・ラチェット (copy-paste 検出)。
 *
 * 目的は「重複ゼロ」ではない。 apps は責務でアプリを分けており、 意図的な類似実装は
 * 存在してよい。 検出したいのは **既存コードを調べずに持ち込まれる新しいコピペ /
 * 再実装** なので、 現状の重複量を area 単位でベースラインに焼き込み、 それを
 * 超えたときだけ CI を落とす (= audit-dependencies.ts と同じ baseline 方式)。
 *
 * 使い方:
 *   bun run scripts/quality/check-duplication.ts            — gate (増加で exit 1)
 *   bun run scripts/quality/check-duplication.ts --update   — baseline を現状に更新
 *
 * baseline を増やす方向に更新する PR は、 なぜ重複が正当か (責務分離 / 契約ミラー等)
 * を PR body に書く (= trustedDependencies / audit-baseline と同じ運用)。 減らす方向は
 * いつでも歓迎 — gate が「actual < baseline」を検出したら ratchet-down を促す。
 *
 * area = 責務境界の近似 (apps/<name> / packages/<name> / infrastructure / scripts /
 * .claude)。 クローンは両端の file が属する area にそれぞれ加算されるため、 area を
 * またぐコピペはどちらの area の増分としても現れる。
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareCodePoints } from "../lib/code-point-order";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASELINE_PATH = join(REPO_ROOT, "scripts", "quality", "duplication-baseline.json");
const REPORT_PATH = join(REPO_ROOT, ".jscpd-report", "jscpd-report.json");

interface CloneFileRef {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

export interface Clone {
  readonly firstFile: CloneFileRef;
  readonly secondFile: CloneFileRef;
  readonly lines: number;
  readonly format: string;
}

export interface JscpdReport {
  readonly duplicates: readonly Clone[];
}

/** `apps/<name>` / `packages/<name>` は 2 階層、 それ以外は最上位 dir を area とする。 */
export function areaOf(path: string): string {
  const parts = path.split("/");
  if ((parts[0] === "apps" || parts[0] === "packages") && parts.length > 1) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0] ?? path;
}

/**
 * area ごとの重複行数。 クローンの行数を firstFile / secondFile 双方の area に加算する
 * (= 同一 area 内クローンはその area に 2 回乗る)。 移動を伴わない編集では安定し、
 * 新しいコピペは必ずどこかの area の増分として現れる。
 */
export function aggregateDuplicatedLines(clones: readonly Clone[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const clone of clones) {
    for (const file of [clone.firstFile, clone.secondFile]) {
      const area = areaOf(file.name);
      totals[area] = (totals[area] ?? 0) + clone.lines;
    }
  }
  return totals;
}

export interface AreaDelta {
  readonly area: string;
  readonly baseline: number;
  readonly actual: number;
}

export interface Comparison {
  readonly regressions: readonly AreaDelta[];
  readonly improvements: readonly AreaDelta[];
}

/** baseline 未記載の area は 0 扱い (= 新 area への持ち込みも増加として検出する)。 */
export function compareToBaseline(
  actual: Record<string, number>,
  baseline: Record<string, number>,
): Comparison {
  const areas = new Set([...Object.keys(actual), ...Object.keys(baseline)]);
  const regressions: AreaDelta[] = [];
  const improvements: AreaDelta[] = [];
  for (const area of [...areas].sort(compareCodePoints)) {
    const a = actual[area] ?? 0;
    const b = baseline[area] ?? 0;
    if (a > b) regressions.push({ area, baseline: b, actual: a });
    else if (a < b) improvements.push({ area, baseline: b, actual: a });
  }
  return { regressions, improvements };
}

/** 失敗時の調査取っ掛かり: 対象 area に触れるクローンを行数の大きい順に返す。 */
export function largestClonesTouching(
  clones: readonly Clone[],
  area: string,
  limit: number,
): readonly Clone[] {
  return clones
    .filter((c) => areaOf(c.firstFile.name) === area || areaOf(c.secondFile.name) === area)
    .toSorted((x, y) => y.lines - x.lines)
    .slice(0, limit);
}

function cloneLabel(clone: Clone): string {
  const f = clone.firstFile;
  const s = clone.secondFile;
  return `${f.name}:${f.start}-${f.end} ⇄ ${s.name}:${s.start}-${s.end} (${clone.lines} lines)`;
}

function runJscpd(): JscpdReport {
  // 検査用の実行は console 出力を抑え、 JSON レポートだけ生成する (CLI 引数が
  // .jscpd.json の reporters を上書きする)。 人間向けの詳細表示は `make dup-report`。
  const result = spawnSync(
    join(REPO_ROOT, "node_modules", ".bin", "jscpd"),
    ["--reporters", "json", "--silent"],
    { cwd: REPO_ROOT, stdio: ["ignore", "inherit", "inherit"] },
  );
  if (result.status !== 0) {
    throw new Error(`jscpd exited with status ${result.status ?? "unknown"}`);
  }
  if (!existsSync(REPORT_PATH)) {
    throw new Error(`jscpd report not found at ${REPORT_PATH}`);
  }
  return JSON.parse(readFileSync(REPORT_PATH, "utf8")) as JscpdReport;
}

function readBaseline(): Record<string, number> {
  if (!existsSync(BASELINE_PATH)) return {};
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Record<string, number>;
}

function sortedRecord(totals: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(totals).sort(([a], [b]) => a.localeCompare(b)));
}

export function main(argv: readonly string[]): number {
  const update = argv.includes("--update");
  const report = runJscpd();
  const actual = aggregateDuplicatedLines(report.duplicates);

  if (update) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(sortedRecord(actual), null, 2)}\n`, "utf8");
    console.log(`duplication baseline updated: ${BASELINE_PATH}`);
    for (const [area, lines] of Object.entries(sortedRecord(actual))) {
      console.log(`  ${area}: ${lines} duplicated lines`);
    }
    return 0;
  }

  const baseline = readBaseline();
  const { regressions, improvements } = compareToBaseline(actual, baseline);

  if (improvements.length > 0) {
    console.log("duplication decreased below the baseline — consider ratcheting down:");
    for (const d of improvements) {
      console.log(`  ${d.area}: ${d.baseline} → ${d.actual} duplicated lines`);
    }
    console.log("  (bun run scripts/quality/check-duplication.ts --update)");
  }

  if (regressions.length === 0) {
    console.log("OK duplication is at or below the baseline for every area.");
    return 0;
  }

  console.error("NG duplication increased vs scripts/quality/duplication-baseline.json:");
  for (const d of regressions) {
    console.error(`  ${d.area}: baseline ${d.baseline} → actual ${d.actual} duplicated lines`);
    for (const clone of largestClonesTouching(report.duplicates, d.area, 5)) {
      console.error(`    - ${cloneLabel(clone)}`);
    }
  }
  console.error(
    [
      "",
      "まず既存実装を探して再利用・抽出で解消してください (bunx jscpd で全クローン表示)。",
      "責務分離のための意図的な重複なら、 PR body に理由を書いた上で",
      "`bun run scripts/quality/check-duplication.ts --update` で baseline を更新します。",
    ].join("\n"),
  );
  return 1;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
