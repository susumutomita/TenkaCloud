/**
 * 図解データの組み立て。
 *
 * 図は本文と別に手で書くのではなく、参照実装 trace から起こす。表示と採点が同じ源から
 * 出るので「図の値と正解が違う」事故が構造的に起きない。
 */

import type { BitLane, DrillVisual, Localized, RoundRow, TruthRow, WordRow } from "../drill/types";
import { STATE_LABELS } from "./constants";
import type { RoundTrace, ScheduleStep } from "./trace";
import { toBinary32, toHex32 } from "./word";

/** 32 bit 語 1 行 (16 進 + 2 進)。 */
export function wordRow(label: string, word: number, note?: Localized): WordRow {
  return { label, hex: toHex32(word), binary: toBinary32(word), note };
}

/** bit 列 1 段。 */
export function bitLane(label: string, bits: string, note?: Localized): BitLane {
  return { label, bits, note };
}

/**
 * 1 bit 入力の真理値表 (x, y, z の 8 通り)。
 *
 * 語単位の関数をそのまま 1 bit で呼ぶ: bit 演算は桁ごとに独立なので、最下位 1 bit だけを
 * 見れば表がそのまま得られる。「Ch / Maj は 32 桁を並列に処理しているだけ」という
 * 事実を、別実装を書かずに示せる。
 */
export function singleBitTruthRows(
  fn: (x: number, y: number, z: number) => number,
): readonly TruthRow[] {
  const rows: TruthRow[] = [];
  for (let x = 0; x <= 1; x += 1) {
    for (let y = 0; y <= 1; y += 1) {
      for (let z = 0; z <= 1; z += 1) {
        rows.push({ inputs: [String(x), String(y), String(z)], output: String(fn(x, y, z) & 1) });
      }
    }
  }
  return rows;
}

/** 真理値表 8 行を、その出力列だけ縦に連結した 2 進文字列にする (採点用)。 */
export function truthOutputColumn(rows: readonly TruthRow[]): string {
  return rows.map((row) => row.output).join("");
}

/**
 * 出力列を隠した真理値表。
 *
 * 学習者に埋めさせる表を図解として出すため、答えを伏せた行を作る。図解と採点期待値を
 * 同じ `singleBitTruthRows` から起こしたまま、表示だけ隠せる。
 */
export function maskTruthOutputs(rows: readonly TruthRow[]): readonly TruthRow[] {
  return rows.map((row) => ({ inputs: row.inputs, output: "?" }));
}

/** ラウンド表。各行が a..h の 16 進。 */
export function roundRows(rounds: readonly RoundTrace[]): readonly RoundRow[] {
  return rounds.map((round) => ({
    index: round.index,
    words: round.after.map(toHex32),
  }));
}

/** ラウンド表の図解 (見出しは a..h)。 */
export function roundsVisual(rounds: readonly RoundTrace[]): DrillVisual {
  return { kind: "rounds", labels: [...STATE_LABELS], rows: roundRows(rounds) };
}

/** message schedule の導出過程を 1 step ぶん語行へ展開する。 */
export function scheduleStepRows(step: ScheduleStep): readonly WordRow[] {
  return [
    wordRow(`W[${step.index - 16}]`, step.wMinus16),
    wordRow(`σ0(W[${step.index - 15}])`, step.sigma0),
    wordRow(`W[${step.index - 7}]`, step.wMinus7),
    wordRow(`σ1(W[${step.index - 2}])`, step.sigma1),
    wordRow(`W[${step.index}]`, step.result),
  ];
}
