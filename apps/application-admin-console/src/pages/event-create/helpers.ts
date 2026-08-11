/**
 * EventCreate wizard 用の pure helper / constants 集約。
 *
 * Issue #1241: EventCreate.tsx が 657 行に膨らんだので section components に分割した。
 * このファイルは React 非依存の純粋な constants / type / 関数だけを置き、
 * - section components (`EventCreate<X>Section.tsx`)
 * - parent (`EventCreate.tsx`)
 * - unit tests (`test/pages/EventCreate.team-rows.test.ts`)
 *
 * の 3 者から共有される。
 */
import type { MultiselectProps, SelectProps } from "@cloudscape-design/components";
import type { CompetitorAccountSummary } from "../../api/competitor-accounts-client";
import { AWS_REGIONS } from "../../data/aws-regions";
import {
  isProviderSelectable,
  type ProblemCostEstimateSummary,
  type ProblemRuntimeSummary,
} from "../../data/problems";
import type { useT } from "../../i18n";

export const NAME_MAX = 120;
// MUST match infrastructure/lib/problem-deploy/handlers/event-handler/types.ts (zod schema)。
// drift すると frontend が通した値を backend が reject する。
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export const ACCOUNT_ID_RE = /^\d{12}$/;
export const TEAMS_MIN = 1;
export const TEAMS_MAX = 99;
export const TEAM_COUNT_INPUT_MAX_LEN = 3; // TEAMS_MAX が 99 = 2 桁、+1 余裕で 3 桁まで入力受理
export const INITIAL_TEAM_COUNT = 3;

export const REGION_OPTIONS: SelectProps.Option[] = AWS_REGIONS.map((r) => ({
  value: r.code,
  label: r.label,
}));

/**
 * #528: 各 team の deploy 先 AWS Account ID は **team 単位** に。region は問題テンプレが
 * 特定 region 依存の場合があるので問題単位を維持。
 */
export interface TeamRow {
  internalSlug: string;
  awsAccountId: string;
  /**
   * Non-AWS single-provider events bind deploy credentials by provider + team
   * slug. Always initialized (defaults to the internalSlug) so validation and
   * submit never need a fallback branch.
   */
  nonAwsCredentialTeamSlug: string;
}

export interface ProblemRow {
  problemId: string;
  problemName: string;
  defaultRegion: string;
  runtimeProvider?: string;
  /** Composite runtimes keep every target provider instead of collapsing to AWS. */
  runtimeProviders?: readonly string[];
  composite?: boolean;
  /** Issue #1910: operator-facing cost-risk estimate derived from template.yaml. */
  costEstimate?: ProblemCostEstimateSummary;
  /** Issue #1201 Phase 2: 問題が動作確認済 region 集合。 wizard picker の選択肢を絞る。 */
  supportedRegions?: readonly string[];
}

export interface TeamValidation {
  readonly allSlugsValid: boolean;
  readonly allAccountsValid: boolean;
  readonly allNonAwsCredentialSlugsValid?: boolean;
  readonly hasDuplicateSlug: boolean;
  readonly providerMode?: EventProviderMode;
}

/** Team table の row 描画に使う view-model (idx を抱える)。 */
export type EventProviderMode =
  | { readonly kind: "aws" }
  | { readonly kind: "nonAws"; readonly provider: string }
  | { readonly kind: "composite"; readonly providers: readonly string[] }
  | { readonly kind: "mixed" };

export type TeamTableItem = TeamRow & { idx: number };

/** Multiselect option (value 必須) */
export type ProblemOption = MultiselectProps.Option & { value: string };

/**
 * Issue #1414, #2167: event の problem picker option を組み立てる。選択可否は
 * {@link isProviderSelectable} に委ねる:
 *   - aws/cloudformation は常に選択可。
 *   - 予約 provider (sakura/azure/gcp) は `enabledProviders` に含まれるとき選択可
 *     (= operator が `features.nonAwsRuntime` を ON にし team credentials を登録した状態)。
 *   - それ以外 (まだ無効な provider / 未知 runtime) は `disabled` + 「近日対応」 tag。
 *
 * #2167 以前は aws/cloudformation 固定判定で、 multi-cloud を有効化しても非 AWS 問題が
 * 永遠に disabled のままだった (= 「登録したのに使えない」)。 `enabledProviders` を受け取る
 * ことで flag 連動にし、 「近日対応」は本当に未許可の provider にだけ付くようにする。
 */
export function buildProblemOptions(
  problems: readonly {
    readonly id: string;
    readonly name: string;
    readonly runtime: ProblemRuntimeSummary;
  }[],
  reservedTag: string,
  enabledProviders: ReadonlySet<string>,
): ProblemOption[] {
  return problems.map((p) => {
    const base = { value: p.id, label: `${p.name} (${p.id})` };
    return isProviderSelectable(p.runtime, enabledProviders)
      ? base
      : { ...base, disabled: true, labelTag: reservedTag };
  });
}

export function buildVerifiedAccountOption(a: CompetitorAccountSummary): SelectProps.Option {
  const descriptionParts = [a.alias, a.region, a.competitorRoleName].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  return {
    value: a.awsAccountId,
    label: a.awsAccountId,
    labelTag: a.alias,
    description: descriptionParts.join(" / "),
    filteringTags: descriptionParts,
  };
}

export function formatVerifiedAccountSummary(a: CompetitorAccountSummary): string {
  return a.alias ? `${a.awsAccountId} (${a.alias})` : a.awsAccountId;
}

/**
 * Issue #1201 Phase 2: region picker の選択肢を `supportedRegions` で絞る純関数。
 *
 * - `supportedRegions` が undefined / 空 → 全 region (= 後方互換)
 * - 宣言されていれば、 集合と AWS_REGIONS の intersection で picker を構築
 * - 未知 region code (= AWS_REGIONS に無い文字列) は無視 (= UI に壊れた option を出さない)
 */
export function resolveRegionOptions(
  supportedRegions: readonly string[] | undefined,
  baseOptions: readonly SelectProps.Option[],
): readonly SelectProps.Option[] {
  if (!supportedRegions || supportedRegions.length === 0) return baseOptions;
  const allowed = new Set(supportedRegions);
  const intersection = baseOptions.filter((o) => o.value && allowed.has(o.value));
  // 宣言が無効 (= AWS_REGIONS と 1 件もマッチしない) のときは base に倒す。
  // ここで空配列を返すと wizard が壊れるので fail-safe。
  return intersection.length > 0 ? intersection : baseOptions;
}

/**
 * Issue #1201: 問題行の初期 region を決める純関数。
 *
 * - 問題 metadata に `defaultRegion` が宣言されていればそれを採用
 * - 未宣言なら `globalDefault` (= 通常 `DEFAULT_AWS_REGION.code`) にフォールバック
 *
 * 「全 event が ap-northeast-1 に集中して quota 上限に到達する」 問題を、 問題側
 * (= 動作確認済 region を一番よく知っている人) の宣言で散らすための仕掛け。
 */
export function resolveInitialRegion(
  metaDefaultRegion: string | undefined,
  globalDefault: string,
): string {
  return metaDefaultRegion ?? globalDefault;
}

export function resizeTeamRows(prev: TeamRow[], next: number): TeamRow[] {
  if (next === prev.length) return prev;
  if (next < prev.length) return prev.slice(0, Math.max(next, 0));
  const additions = Array.from({ length: next - prev.length }, (_, i) => ({
    internalSlug: `team-${prev.length + i + 1}`,
    awsAccountId: "",
    nonAwsCredentialTeamSlug: `team-${prev.length + i + 1}`,
  }));
  return [...prev, ...additions];
}

function requiredCompositeProviders(
  problem: Pick<ProblemRow, "runtimeProviders">,
): readonly string[] {
  /* v8 ignore next -- composite rows are constructed with runtimeProviders in EventCreate */
  if (!problem.runtimeProviders) throw new Error("composite problem row is missing providers");
  return problem.runtimeProviders;
}

export function resolveEventProviderMode(
  problemRows: readonly Pick<ProblemRow, "runtimeProvider" | "runtimeProviders" | "composite">[],
): EventProviderMode {
  if (problemRows.some((problem) => problem.composite)) {
    const providers = problemRows.flatMap((problem) =>
      problem.composite ? requiredCompositeProviders(problem) : [problem.runtimeProvider ?? "aws"],
    );
    return { kind: "composite", providers: [...new Set(providers)] };
  }
  // 未宣言 runtime は aws/cloudformation に正規化 (ProblemSummary と同じ規約)。
  const providers = problemRows.map((p) => p.runtimeProvider ?? "aws");
  const nonAws = new Set(providers.filter((p) => p !== "aws"));
  if (nonAws.size === 0) return { kind: "aws" };
  if (!providers.includes("aws") && nonAws.size === 1) {
    const [provider] = nonAws;
    return { kind: "nonAws", provider };
  }
  return { kind: "mixed" };
}

function providerRequirements(providerMode: EventProviderMode): {
  readonly aws: boolean;
  readonly nonAws: boolean;
} {
  if (providerMode.kind === "aws") return { aws: true, nonAws: false };
  if (providerMode.kind === "nonAws") return { aws: false, nonAws: true };
  if (providerMode.kind === "composite") {
    return {
      aws: providerMode.providers.includes("aws"),
      nonAws: providerMode.providers.some((provider) => provider !== "aws"),
    };
  }
  return { aws: false, nonAws: false };
}

export function validateTeamRows(
  teamRows: readonly TeamRow[],
  providerMode: EventProviderMode = { kind: "aws" },
): TeamValidation {
  let allSlugsValid = true;
  let allAccountsValid = true;
  let allNonAwsCredentialSlugsValid = true;
  const slugs = new Set<string>();
  let hasDuplicateSlug = false;
  const requirements = providerRequirements(providerMode);
  for (const t of teamRows) {
    if (!SLUG_RE.test(t.internalSlug)) allSlugsValid = false;
    if (requirements.aws && !ACCOUNT_ID_RE.test(t.awsAccountId)) allAccountsValid = false;
    if (requirements.nonAws && !SLUG_RE.test(t.nonAwsCredentialTeamSlug)) {
      allNonAwsCredentialSlugsValid = false;
    }
    if (slugs.has(t.internalSlug)) hasDuplicateSlug = true;
    else slugs.add(t.internalSlug);
  }
  return {
    allSlugsValid,
    allAccountsValid,
    allNonAwsCredentialSlugsValid,
    hasDuplicateSlug,
    providerMode,
  };
}

export function parseTeamCountInput(value: string): number | undefined {
  const next = Number.parseInt(value.replace(/\D/g, "").slice(0, TEAM_COUNT_INPUT_MAX_LEN), 10);
  return Number.isFinite(next) ? Math.max(0, Math.min(TEAMS_MAX, next)) : undefined;
}

export function getNameErrorText(
  t: ReturnType<typeof useT>,
  name: string,
  nameInvalid: boolean,
): string | undefined {
  return nameInvalid && name.length > 0
    ? t("event_create.name_invalid", { max: NAME_MAX })
    : undefined;
}

export function getTeamCountErrorText(
  t: ReturnType<typeof useT>,
  teamCountInvalid: boolean,
): string | undefined {
  return teamCountInvalid
    ? t("event_create.team_count_invalid", { min: TEAMS_MIN, max: TEAMS_MAX })
    : undefined;
}
