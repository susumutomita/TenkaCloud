/**
 * Issue #2936 Phase 1: 評価対象の version 契約。
 *
 * ## なぜ model 名だけでは足りないのか
 *
 * AI 機能は code が build と test を通っていても、model 更新、prompt 変更、Skill 差し替え、
 * tool schema、context 圧縮、timeout 設定で静かに劣化する。「どの model か」だけを記録した
 * 評価結果は、劣化したときに **何が変わったせいなのか** を答えられない。
 *
 * よって評価対象は「同じ model でも prompt / Skill / tool policy / runtime / context の
 * 組み立てが変われば別 version」として扱う。ここに並ぶ field はすべて **必須** で、
 * 欠けた target は評価結果を名乗れない。
 */

export interface EvaluationTarget {
  /** 評価対象の機能 (例: `agent-gameday`)。 */
  readonly feature: string;
  /** この target の version。同じ feature の別構成と区別する唯一の id。 */
  readonly version: string;
  readonly provider: string;
  /** provider の model id。 */
  readonly model: string;
  /**
   * model snapshot。provider が snapshot を持たない場合も `"unpinned"` と明示させる。
   * 省略を許すと「pin したつもりで動いていなかった」が後から判別できない。
   */
  readonly modelSnapshot: string;
  /** 決定論性に効く parameter (temperature 等)。値そのものを記録する。 */
  readonly parameters: Readonly<Record<string, number | string | boolean>>;
  /** system prompt の digest。本文は保存しない (公開・流出面を増やさない)。 */
  readonly systemPromptDigest: string;
  /** instruction bundle の digest。 */
  readonly instructionBundleDigest: string;
  /** 有効な Skill の digest 群。順序非依存で比較する。 */
  readonly skillDigests: readonly string[];
  readonly toolPolicyVersion: string;
  readonly runtimeVersion: string;
  readonly datasetVersion: string;
  readonly evaluatorVersion: string;
  readonly releaseGatePolicyVersion: string;
  /** 比較対象の baseline target version。初回は `undefined` を許す。 */
  readonly baselineVersion?: string;
}

export class TargetContractError extends Error {
  constructor(
    public readonly missing: readonly string[],
    message: string,
  ) {
    super(message);
    this.name = "TargetContractError";
  }
}

const REQUIRED_STRING_FIELDS = [
  "feature",
  "version",
  "provider",
  "model",
  "modelSnapshot",
  "systemPromptDigest",
  "instructionBundleDigest",
  "toolPolicyVersion",
  "runtimeVersion",
  "datasetVersion",
  "evaluatorVersion",
  "releaseGatePolicyVersion",
] as const;

/**
 * target を検証する。欠けた field は名指しで throw する。
 *
 * 「足りないものを既定値で埋める」ことはしない。既定値で埋めた target は、後から
 * 「何を評価したのか」を答えられない記録になる。
 */
export function assertCompleteTarget(target: EvaluationTarget): void {
  const missing = REQUIRED_STRING_FIELDS.filter((field) => {
    const value = target[field];
    return typeof value !== "string" || value.trim().length === 0;
  });
  if (!Array.isArray(target.skillDigests)) missing.push("skillDigests" as never);
  if (missing.length > 0) {
    throw new TargetContractError(
      missing,
      `evaluation target incomplete: ${missing.join(", ")} が指定されていません。` +
        "model 名だけでは劣化の原因を切り分けられないため、これらは省略できません。",
    );
  }
}

/**
 * 2 つの target が **同一構成** かどうか。1 つでも違えば別 version として扱う。
 *
 * これが `false` なのに同じ version 番号が付いていたら、評価結果の比較は無効である。
 */
export function isSameConfiguration(left: EvaluationTarget, right: EvaluationTarget): boolean {
  const scalarsMatch = REQUIRED_STRING_FIELDS.filter((field) => field !== "version").every(
    (field) => left[field] === right[field],
  );
  if (!scalarsMatch) return false;
  if (JSON.stringify(left.parameters) !== JSON.stringify(right.parameters)) return false;
  return (
    JSON.stringify([...left.skillDigests].sort()) === JSON.stringify([...right.skillDigests].sort())
  );
}

/**
 * 同じ version 番号で中身が違う target を検出する。
 *
 * これを見逃すと「baseline と比較した」という主張が嘘になる。schema 上は 2 つの target が
 * 同じ名前を名乗れてしまうので、比較の前に必ず通す。
 */
export function assertVersionIntegrity(left: EvaluationTarget, right: EvaluationTarget): void {
  if (left.version === right.version && !isSameConfiguration(left, right)) {
    throw new TargetContractError(
      [],
      `target version "${left.version}" が異なる構成に対して 2 回使われています。` +
        "同じ model でも prompt / Skill / tool policy / runtime が変われば別 version です。",
    );
  }
}
