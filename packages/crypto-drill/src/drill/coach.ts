/**
 * AI サポート。
 *
 * 方式は `/tenka-drill` skill と同じで、**プラットフォームは LLM を呼ばない**。呼べば
 * イベント外にも常時かかる従量課金と API 鍵の保管が生まれ、「イベント間はゼロ」という
 * 運用方針と矛盾する。代わりに、節と課題の文脈を埋め込んだプロンプトを組み立てて
 * 学習者自身の Claude Code へ渡す。
 *
 * 2 つのモードを用意する。
 *   - `hint`: 答えを言わずに次の 1 歩だけ示す (段階ヒント)。
 *   - `explain`: なぜこの処理が要るか、よくある間違い、次に理解すべき点を解説する。
 *
 * どちらのモードでも、組み立てたプロンプトに **正解値を含めない**。理由は、生成した文字列が
 * そのまま画面へ出るため、含めればモデルへの指示に関わらずその場に答えが表示され、ヒントを
 * 求める意味が消えるからである。
 *
 * これは答えを隠す仕組みではない。貼った先のモデルが課題文から答えを自力で計算することは
 * 防げない (SHA-256 の計算自体は容易である)。ヒントへ導く導線として理解する。
 * 静的な段階ヒント (`task.hints`) は AI を使わない経路として併存する。
 */

import type { DrillHint, DrillSection, DrillTask, LocaleCode, Localized } from "./types";
import { isValueTask, localize } from "./types";

/** 開示済みのヒント。`level` 昇順。 */
export function visibleHints(task: DrillTask, revealedHints: number): readonly DrillHint[] {
  return [...task.hints].sort((a, b) => a.level - b.level).slice(0, revealedHints);
}

/** まだ開示していないヒントが残っているか。 */
export function hasMoreHints(task: DrillTask, revealedHints: number): boolean {
  return revealedHints < task.hints.length;
}

export type CoachMode = "hint" | "explain";

export interface CoachPromptInput {
  readonly drillTitle: string;
  readonly section: DrillSection;
  readonly task: DrillTask;
  readonly locale: LocaleCode;
  readonly mode: CoachMode;
  readonly attempts: number;
}

/** locale ごとの定型文。`Localized` と同形だが、教材本文ではなく UI 文言なのでここに置く。 */
interface CoachCopy {
  readonly sectionHeading: string;
  readonly taskHeading: string;
  readonly intro: (drillTitle: string) => string;
  readonly attempts: (attempts: number) => string;
}

const COACH_COPY: Readonly<Record<LocaleCode, CoachCopy>> = {
  ja: {
    sectionHeading: "節",
    taskHeading: "課題",
    intro: (drillTitle) => `私は TenkaCloud の学習ドリル「${drillTitle}」を進めています。`,
    attempts: (attempts) => `これまでの提出回数: ${attempts}`,
  },
  en: {
    sectionHeading: "Section",
    taskHeading: "Task",
    intro: (drillTitle) => `I am working through the TenkaCloud learning drill "${drillTitle}".`,
    attempts: (attempts) => `Attempts so far: ${attempts}`,
  },
};

const MODE_INSTRUCTIONS: Readonly<Record<CoachMode, Localized>> = {
  hint: {
    ja: [
      "私が詰まっている箇所に対して、答えの値は書かずに次の 1 歩だけ示してください。",
      "まず私の理解のどこがずれている可能性が高いかを 1 つ挙げ、次に確認すべき中間値を 1 つだけ指定してください。",
      "最終的な数値やハッシュ値は書かないでください。",
    ].join("\n"),
    en: [
      "Give me only the next single step toward the answer — do not write the answer value itself.",
      "Name the one misunderstanding most likely behind my mistake, then point me at exactly one intermediate value to check.",
      "Do not write out the final number or hash.",
    ].join("\n"),
  },
  explain: {
    ja: [
      "この節について次の 3 点を解説してください。",
      "1. なぜこの処理が SHA-256 に必要なのか (省いたら何が壊れるか)。",
      "2. この節でよくある間違いと、その間違いが最終ハッシュにどう現れるか。",
      "3. 次に理解すべきポイント。",
    ].join("\n"),
    en: [
      "Explain the following three things about this step.",
      "1. Why SHA-256 needs this operation (what breaks if you drop it).",
      "2. The common mistakes here, and how each one shows up in the final hash.",
      "3. What to understand next.",
    ].join("\n"),
  },
};

/** 課題の解答欄が何を求めているか (正解値は含めない)。 */
function describeAsks(task: DrillTask, locale: LocaleCode): readonly string[] {
  if (isValueTask(task)) {
    return task.cases.map((drillCase) => `- ${localize(drillCase.label, locale)}`);
  }
  return task.choices.map((choice) => `- ${localize(choice.label, locale)}`);
}

/**
 * 学習者の Claude Code へ貼るプロンプトを組み立てる。
 *
 * 節本文・課題文・解答欄の問いかけまでを渡し、正解値と選択肢の正誤は渡さない。
 */
export function buildCoachPrompt(input: CoachPromptInput): string {
  const { locale, section, task } = input;
  const copy = COACH_COPY[locale];
  return [
    copy.intro(input.drillTitle),
    "",
    `## ${copy.sectionHeading} ${section.order}: ${localize(section.title, locale)}`,
    localize(section.goal, locale),
    "",
    ...section.reading.map((paragraph) => localize(paragraph, locale)),
    "",
    `## ${copy.taskHeading}: ${localize(task.title, locale)}`,
    localize(task.instruction, locale),
    "",
    ...describeAsks(task, locale),
    "",
    copy.attempts(input.attempts),
    "",
    localize(MODE_INSTRUCTIONS[input.mode], locale),
  ].join("\n");
}
