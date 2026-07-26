/**
 * 自動採点。
 *
 * **信頼境界: この採点は自己学習のフィードバックであり、信頼できる採点ではない。**
 * 期待値は SPA の bundle に載って学習者の手元へ配られ、進捗は学習者が書き換えられる
 * localStorage にある。つまり devtools から正解を読むことも、達成済みに書き換えることも
 * できる。これは教材として意図した設計で、学習者が自分を騙す動機が無いから成立している。
 *
 * したがって、ここの合否をスコア・順位・修了判定・資格の根拠に **決して使わない**。
 * 得点に効く判定が必要になったら、期待値を配らないサーバ側の採点 (problem-deploy backend の
 * flag 採点と同じ構え) を別に用意する。この module をその用途へ流用してはいけない。
 *
 * 採点は **正規化してから完全一致** で判定する。表記ゆれ (`0x` 前置、桁区切り、大文字) は
 * 吸収するが、桁数は吸収しない。`0018` と `18` を同一視すると、ビッグエンディアンで
 * 「上位が 0 埋めされる」というこの節の学習内容そのものが検査できなくなる。
 * 例外は 10 進で、こちらは先頭 0 に情報がないため落とす。
 *
 * 不一致の理由を `verdict` で返し、UI が「未入力」「記法が違う」「値が違う」を
 * 書き分けられるようにする (どれも同じ「不正解」にすると、学習者は自分の誤りの
 * 種類を切り分けられない)。
 */

import type { AnswerFormat, ChoiceTask, DrillTask, ValueTask } from "./types";

/** 1 欄の判定結果。 */
export type CaseVerdict = "correct" | "empty" | "malformed" | "incorrect";

export interface CaseResult {
  readonly caseId: string;
  readonly verdict: CaseVerdict;
  /** 正規化後の解答。UI が「こう解釈した」を見せるために返す。 */
  readonly normalized: string;
  readonly expected: string;
}

export interface GradeResult {
  readonly taskId: string;
  readonly passed: boolean;
  readonly cases: readonly CaseResult[];
}

/** 選択式の submission は選んだ選択肢 id の集合。 */
export interface ChoiceSubmission {
  readonly kind: "choice";
  readonly selected: readonly string[];
}

/** 値課題の submission は 欄 id → 生入力。 */
export interface ValueSubmission {
  readonly kind: "value";
  readonly answers: Readonly<Record<string, string>>;
}

export type TaskSubmission = ChoiceSubmission | ValueSubmission;

const SEPARATORS = /[\s_,:|-]/g;

const FORMAT_PATTERNS: Readonly<Record<Exclude<AnswerFormat, "text">, RegExp>> = {
  hex: /^[0-9a-f]+$/,
  binary: /^[01]+$/,
  decimal: /^[0-9]+$/,
};

const FORMAT_PREFIXES: Readonly<Record<Exclude<AnswerFormat, "text">, string>> = {
  hex: "0x",
  binary: "0b",
  decimal: "",
};

/** 正規化の結果。`ok: false` は記法が壊れている (= `malformed`)。 */
export interface NormalizedAnswer {
  readonly ok: boolean;
  readonly value: string;
}

/**
 * 解答を正規化する。`text` 以外は区切り記号と基数前置を落として小文字化する。
 *
 * `decimal` だけは先頭 0 を落とす (`007` = `7`)。16 進・2 進で同じことをすると桁数の
 * 学習内容が消えるため、あえて揃えない。
 */
export function normalizeAnswer(raw: string, format: AnswerFormat): NormalizedAnswer {
  if (format === "text") return { ok: true, value: raw.trim() };
  const stripped = raw.trim().toLowerCase().replace(SEPARATORS, "");
  const prefix = FORMAT_PREFIXES[format];
  const body =
    prefix !== "" && stripped.startsWith(prefix) ? stripped.slice(prefix.length) : stripped;
  if (body === "") return { ok: true, value: "" };
  if (!FORMAT_PATTERNS[format].test(body)) return { ok: false, value: body };
  if (format !== "decimal") return { ok: true, value: body };
  const withoutLeadingZeros = body.replace(/^0+/, "");
  return { ok: true, value: withoutLeadingZeros === "" ? "0" : withoutLeadingZeros };
}

/** 1 欄を採点する。 */
export function gradeCase(
  drillCase: ValueTask["cases"][number],
  raw: string | undefined,
): CaseResult {
  const base = { caseId: drillCase.id, expected: drillCase.expected } as const;
  if (raw === undefined || raw.trim() === "") {
    return { ...base, verdict: "empty", normalized: "" };
  }
  const normalized = normalizeAnswer(raw, drillCase.format);
  if (!normalized.ok) return { ...base, verdict: "malformed", normalized: normalized.value };
  const verdict = normalized.value === drillCase.expected ? "correct" : "incorrect";
  return { ...base, verdict, normalized: normalized.value };
}

/** 値課題を採点する。全欄が `correct` のときだけ合格。 */
export function gradeValueTask(
  task: ValueTask,
  answers: Readonly<Record<string, string>>,
): GradeResult {
  const cases = task.cases.map((drillCase) => gradeCase(drillCase, answers[drillCase.id]));
  return {
    taskId: task.id,
    passed: cases.every((result) => result.verdict === "correct"),
    cases,
  };
}

/**
 * 選択式を採点する。**選ぶべき選択肢を全部選び、選ぶべきでないものを 1 つも選んでいない**
 * ことを要求する (部分点は出さない — 「衝突とは何か」を半分だけ理解した状態を合格にしない)。
 */
export function gradeChoiceTask(task: ChoiceTask, selected: readonly string[]): GradeResult {
  const chosen = new Set(selected);
  const cases = task.choices.map((choice) => {
    const picked = chosen.has(choice.id);
    const verdict: CaseVerdict = picked === choice.correct ? "correct" : "incorrect";
    return {
      caseId: choice.id,
      verdict,
      normalized: picked ? "selected" : "",
      expected: choice.correct ? "selected" : "",
    };
  });
  const answered = chosen.size > 0;
  return {
    taskId: task.id,
    passed: answered && cases.every((result) => result.verdict === "correct"),
    cases,
  };
}

/** submission の種類に応じて採点関数へ振り分ける。 */
export function gradeTask(task: DrillTask, submission: TaskSubmission): GradeResult {
  if (task.kind === "choice") {
    if (submission.kind !== "choice") {
      throw new Error(`task ${task.id} expects a choice submission`);
    }
    return gradeChoiceTask(task, submission.selected);
  }
  if (submission.kind !== "value") {
    throw new Error(`task ${task.id} expects a value submission`);
  }
  return gradeValueTask(task, submission.answers);
}
