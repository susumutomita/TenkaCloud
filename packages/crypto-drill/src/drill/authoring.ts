/**
 * 節を書くときの小さな組み立て関数。
 *
 * 教材は「同じ形の宣言を 15 節ぶん並べる」書き物なので、`{ ja, en }` や
 * `{ level, text }` の入れ子を毎回手で書くと本文よりも構造の記述が長くなり、
 * 節ごとの差分が読めなくなる。ここに寄せるのは **入れ子を畳むだけ** の関数に限り、
 * 分岐やデータ加工は持ち込まない (持ち込むと教材の内容が helper に隠れる)。
 */

import type { AnswerFormat, DrillCase, DrillChoice, DrillHint, Localized } from "./types";

/** 2 言語必須の本文を 1 行で書く。 */
export function loc(ja: string, en: string): Localized {
  return { ja, en };
}

/** 段階ヒント。`level` は 1 から始め、大きいほど踏み込む。 */
export function hint(level: number, ja: string, en: string): DrillHint {
  return { level, text: loc(ja, en) };
}

/**
 * 解答欄。`width` は `expected` の桁数から決める (= 期待桁数を人が書き写して
 * ずれる余地を消す)。
 */
export function answerCase(input: {
  readonly id: string;
  readonly ja: string;
  readonly en: string;
  readonly expected: string;
  readonly format: AnswerFormat;
}): DrillCase {
  return {
    id: input.id,
    label: loc(input.ja, input.en),
    expected: input.expected,
    format: input.format,
    width: input.expected.length,
  };
}

/** 選択肢。`rationale` は正誤どちらでも表示するので必須にする。 */
export function choice(input: {
  readonly id: string;
  readonly ja: string;
  readonly en: string;
  readonly correct: boolean;
  readonly rationaleJa: string;
  readonly rationaleEn: string;
}): DrillChoice {
  return {
    id: input.id,
    label: loc(input.ja, input.en),
    correct: input.correct,
    rationale: loc(input.rationaleJa, input.rationaleEn),
  };
}
