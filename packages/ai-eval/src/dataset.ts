/**
 * Issue #2936 Phase 1: golden dataset の契約。
 *
 * ## 100 件の意味
 *
 * 自動 release gate を名乗る suite は最低 100 件の validated case を持つ。開発用の小さな
 * smoke suite は許可するが、**100 件未満の suite に release 品質を保証したと言わせない**。
 * これは数合わせの規則ではなく、「言い換えを 100 個並べても coverage にはならない」ことと
 * 対にして初めて意味を持つので、coverage matrix の充足も同時に要求する。
 */

/**
 * coverage matrix。同じ template の言い換えで 100 件を満たすことを防ぐ。
 * ここに挙げた区分が 1 つでも空なら、その dataset は release gate に使えない。
 */
export const REQUIRED_COVERAGE_CATEGORIES = [
  "normal_success",
  "ambiguous_request",
  "tool_error",
  "partial_failure_recovery",
  "stale_or_conflicting_evidence",
  "prompt_injection",
  "forbidden_or_destructive_request",
  "budget_limit",
  "language_variation",
  "fairness_pair",
  "explanation_state_mismatch",
  "cost_quality_tradeoff",
] as const;

export type CoverageCategory = (typeof REQUIRED_COVERAGE_CATEGORIES)[number];

export const CASE_SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type CaseSeverity = (typeof CASE_SEVERITIES)[number];

export interface GoldenCase {
  readonly id: string;
  readonly category: CoverageCategory;
  readonly severity: CaseSeverity;
  /** 参加者 / 運営から見た入力。 */
  readonly input: string;
  /** 環境 fixture の digest。実 credential を持たないことは `assertNoSensitiveMaterial` が見る。 */
  readonly environmentFixtureDigest: string;
  /** 決定論的に判定できる期待結果。 */
  readonly expectedOutcomes: readonly string[];
  /** 1 件でも起きたら不合格になる副作用。 */
  readonly forbiddenEffects: readonly string[];
  /** 最終回答が根拠として結びつくべき evidence 参照。 */
  readonly requiredEvidence: readonly string[];
  /** 自由記述を評価するための rubric。 */
  readonly rubric: string;
  /** 誰がこの case を作り、誰が検証したか。 */
  readonly provenance: { readonly author: string; readonly reviewer: string };
}

export const RELEASE_GATE_MINIMUM_CASES = 100;

export class DatasetContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatasetContractError";
  }
}

export interface DatasetVerdict {
  /** release gate として使えるか。 */
  readonly usableAsReleaseGate: boolean;
  /** 使えない理由。使える場合は空。 */
  readonly reasons: readonly string[];
  readonly caseCount: number;
  readonly missingCategories: readonly CoverageCategory[];
}

/**
 * dataset が release gate を名乗れるかを判定する。
 *
 * **`false` を「まだ小さいから緩く通す」に読み替えてはならない。** smoke suite として使うのは
 * 自由だが、その run の結果に release 判断を載せることはできない。
 */
export function evaluateDatasetReadiness(cases: readonly GoldenCase[]): DatasetVerdict {
  const reasons: string[] = [];
  const present = new Set(cases.map((c) => c.category));
  const missingCategories = REQUIRED_COVERAGE_CATEGORIES.filter((c) => !present.has(c));

  if (cases.length < RELEASE_GATE_MINIMUM_CASES) {
    reasons.push(
      `validated case が ${cases.length} 件で、release gate に必要な ${RELEASE_GATE_MINIMUM_CASES} 件に達していません`,
    );
  }
  if (missingCategories.length > 0) {
    reasons.push(
      `coverage matrix が埋まっていません (未充足: ${missingCategories.join(", ")})。` +
        "同じ template の言い換えで件数だけ満たしても coverage にはなりません",
    );
  }
  const ids = new Set<string>();
  for (const item of cases) {
    if (ids.has(item.id)) reasons.push(`case id が重複しています: ${item.id}`);
    ids.add(item.id);
  }
  return {
    usableAsReleaseGate: reasons.length === 0,
    reasons,
    caseCount: cases.length,
    missingCategories,
  };
}

/**
 * fixture / case に credential や個人情報が混ざっていないことを検査する。
 *
 * dataset は共有され、report に引用され、失敗時には人が読む。ここに本物の secret が入ると、
 * 評価基盤そのものが漏洩経路になる。pattern は実行時に組み立てて、この source 自体が
 * secret scanner に引っかからないようにする。
 */
export function findSensitiveMaterial(serialized: string): string[] {
  const patterns: readonly { readonly label: string; readonly re: RegExp }[] = [
    { label: "bearer token", re: new RegExp(`${"Bea"}${"rer"}\\s+[A-Za-z0-9._-]{20,}`) },
    { label: "JWT", re: new RegExp(`\\b${"ey"}J[A-Za-z0-9._-]{20,}`) },
    { label: "AWS access key id", re: new RegExp(`\\b${"AK"}IA[0-9A-Z]{16}\\b`) },
    { label: "private key block", re: new RegExp(`BEGIN [A-Z ]*${"PRIVATE"} KEY`) },
    { label: "email address", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  ];
  return patterns.filter(({ re }) => re.test(serialized)).map(({ label }) => label);
}

export function assertNoSensitiveMaterial(cases: readonly GoldenCase[]): void {
  const leaks = findSensitiveMaterial(JSON.stringify(cases));
  if (leaks.length > 0) {
    throw new DatasetContractError(
      `golden dataset に含めてはならない情報が見つかりました: ${leaks.join(", ")}`,
    );
  }
}
