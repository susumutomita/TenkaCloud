/**
 * 「アルゴリズムを読む → 自分で計算する → コードを書く → 実行結果を確認する」を 1 節ずつ
 * 繰り返す段階学習ドリルの型。SHA-256 専用ではなく、暗号分野の教材共通フォーマットとして
 * 使う (SHA-1 / HMAC / AES などを足すときは `sections/` を書き足すだけで済む)。
 *
 * 本文は ja / en を **どちらも必須** にしている。片方だけの節が混ざると、locale を切り替えた
 * 学習者にだけ空欄が出る。`drill.test.ts` が全節・全課題を走査して欠落を落とす。
 */

/** 対応 locale。participant-portal の `SUPPORTED_LOCALES` と同じ 2 つ。 */
export type LocaleCode = "ja" | "en";

/** 2 言語必須の本文。 */
export interface Localized {
  readonly ja: string;
  readonly en: string;
}

/** locale を適用して 1 本の文字列にする。 */
export function localize(text: Localized, locale: LocaleCode): string {
  return text[locale];
}

/** 解答欄の記法。採点時の正規化規則を決める。 */
export type AnswerFormat = "hex" | "binary" | "decimal" | "text";

/**
 * 1 つの解答欄。
 *
 * 1 課題に複数の `DrillCase` を持たせるのは、手計算より自分のコードを書いた方が速い状態を
 * 作って学習を促すためである。実装したことの証明にはならない (期待値は bundle から読める)。
 */
export interface DrillCase {
  readonly id: string;
  /** 何を入力として何を求めるか (例: `ROTR^7(0x6a09e667)`)。 */
  readonly label: Localized;
  /** 正規化済みの正解。`sections/` は必ず参照実装から生成する。 */
  readonly expected: string;
  readonly format: AnswerFormat;
  /**
   * 期待される桁数。UI が入力欄の補助表示に使う。
   *
   * `expected` から導けるので任意ではなく必須にする (任意にすると UI 側に
   * 到達不能な既定値の分岐が生まれる)。
   */
  readonly width: number;
}

/** 段階ヒント。`level` が小さいほど踏み込まない。 */
export interface DrillHint {
  readonly level: number;
  readonly text: Localized;
}

/** 選択式課題の選択肢。 */
export interface DrillChoice {
  readonly id: string;
  readonly label: Localized;
  readonly correct: boolean;
  /** 正誤いずれでも表示する根拠。「なぜそうなるか」を残すのが目的。 */
  readonly rationale: Localized;
}

interface TaskBase {
  readonly id: string;
  readonly title: Localized;
  readonly instruction: Localized;
  readonly hints: readonly DrillHint[];
}

/**
 * 値を答える課題。
 *
 * `kind: "implementation"` は「自分の環境で関数を書き、示された入力に対する出力を貼る」課題で、
 * 採点対象が複数ケースになる点だけが `"value"` と違う。ブラウザ内で学習者のコードを
 * `eval` することはしない (プラットフォーム全体で禁止しており、教材のためにその境界を
 * 緩めない)。`starter` は学習者が手元で走らせる雛形である。
 */
export interface ValueTask extends TaskBase {
  readonly kind: "value" | "implementation";
  readonly cases: readonly DrillCase[];
  readonly starter?: string;
}

/** 選択式課題 (単一選択 / 複数選択)。 */
export interface ChoiceTask extends TaskBase {
  readonly kind: "choice";
  readonly multi: boolean;
  readonly choices: readonly DrillChoice[];
}

export type DrillTask = ValueTask | ChoiceTask;

/** bit 列を 1 段ずつ並べる図解 (byte 列 / パディング / ROTR の対応)。 */
export interface BitLane {
  readonly label: string;
  readonly bits: string;
  readonly note?: Localized;
}

/** 32 bit 語を 16 進と 2 進で並べる図解。 */
export interface WordRow {
  readonly label: string;
  readonly hex: string;
  readonly binary: string;
  readonly note?: Localized;
}

/** 真理値表の 1 行。 */
export interface TruthRow {
  readonly inputs: readonly string[];
  readonly output: string;
}

/** ラウンド表の 1 行 (a..h の 16 進)。 */
export interface RoundRow {
  readonly index: number;
  readonly words: readonly string[];
}

/** ハッシュ差分表示の 1 行。 */
export interface DiffRow {
  readonly label: string;
  readonly hex: string;
}

/** 節ごとの図解。UI 側は `kind` で描画を切り替える。 */
export type DrillVisual =
  | { readonly kind: "bit-lanes"; readonly lanes: readonly BitLane[]; readonly groupSize: number }
  | { readonly kind: "words"; readonly rows: readonly WordRow[] }
  | {
      readonly kind: "truth-table";
      readonly headers: readonly string[];
      readonly rows: readonly TruthRow[];
    }
  | {
      readonly kind: "rounds";
      readonly labels: readonly string[];
      readonly rows: readonly RoundRow[];
    }
  | { readonly kind: "hash-diff"; readonly rows: readonly DiffRow[] };

/** 1 節 = 問題説明 + 図解 + 課題 + 解説 + 次のステップ。 */
export interface DrillSection {
  readonly id: string;
  readonly order: number;
  readonly title: Localized;
  readonly goal: Localized;
  /** 問題説明。段落単位で分ける。 */
  readonly reading: readonly Localized[];
  readonly visual?: DrillVisual;
  readonly tasks: readonly DrillTask[];
  /** 解説。採点後に読む前提で「なぜ」を書く。 */
  readonly explanation: readonly Localized[];
  readonly nextStep: Localized;
}

/** ドリル全体。 */
export interface Drill {
  readonly id: string;
  readonly title: Localized;
  readonly summary: Localized;
  readonly sections: readonly DrillSection[];
}

/** `task.kind` で値課題かどうかを判定する type guard。 */
export function isValueTask(task: DrillTask): task is ValueTask {
  return task.kind !== "choice";
}

/** ドリル内の全課題を節順に平坦化する。 */
export function listTasks(drill: Drill): readonly DrillTask[] {
  return drill.sections.flatMap((section) => section.tasks);
}
