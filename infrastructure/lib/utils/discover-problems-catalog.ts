import * as fs from "node:fs";
import * as path from "node:path";
import { type ProblemEndpointSlot, parseEndpointSlot } from "./endpoints-metadata.js";
import { type ProblemScoringMetadata, parseScoringMetadata } from "./scoring-metadata.js";

export type { ProblemEndpointSlot, ProblemScoringMetadata };

/**
 * `problems/<category>/<id>/metadata.json` を持つディレクトリを列挙し、
 * `{ [problemId]: "problems/<category>/<id>" }` の map を返す。
 */
export function discoverProblemsCatalog(problemsRoot: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const meta of iterateProblemsMetadata(problemsRoot)) {
    result[meta.id] = `problems/${meta.category}/${meta.dirName}`;
  }
  return result;
}

/**
 * `discoverProblemsCatalog` の sibling。同じ走査で `scoring` section を抜き、
 * `{ [problemId]: ProblemScoringMetadata }` の map を返す。`scoring` を持たない
 * 問題はキーごと出さない (= scoring 無効)。
 *
 * Lambda env vars (`BATTLE_PROBLEMS_SCORING`) として deploy-handler / participant-
 * handler に渡し、両 Lambda が同じ scoring 規則を共有する。
 */
export function discoverProblemsScoring(
  problemsRoot: string,
): Record<string, ProblemScoringMetadata> {
  const result: Record<string, ProblemScoringMetadata> = {};
  for (const meta of iterateProblemsMetadata(problemsRoot)) {
    const cfg = parseScoringMetadata(meta.scoring);
    if (cfg) result[meta.id] = cfg;
  }
  return result;
}

/**
 * `discoverProblemsCatalog` の sibling (ADR-012 Phase 3.A)。`endpoints[]` section を抜き、
 * `{ [problemId]: ProblemEndpointSlot[] }` の map を返す。`endpoints` を持たない問題は
 * キーごと出さない (= endpoint 無効、Challenge 系 flag-only 問題が該当)。
 *
 * Lambda env (`PROBLEM_ENDPOINTS`) として Participant Portal handler / scoring dispatcher
 * に渡し、各 Lambda が default URL を CFn output から read-through 算出する。
 */
export function discoverProblemsEndpoints(
  problemsRoot: string,
): Record<string, readonly ProblemEndpointSlot[]> {
  const result: Record<string, readonly ProblemEndpointSlot[]> = {};
  for (const meta of iterateProblemsMetadata(problemsRoot)) {
    if (!Array.isArray(meta.endpoints)) continue;
    const slots: ProblemEndpointSlot[] = [];
    for (const entry of meta.endpoints) {
      const slot = parseEndpointSlot(entry);
      if (slot) slots.push(slot);
    }
    if (slots.length > 0) result[meta.id] = slots;
  }
  return result;
}

/**
 * `discoverProblemsCatalog` の sibling (ADR-012 Phase 3.B)。`phases[]` section を抜き、
 * `{ [problemId]: PhaseEntry[] }` の map を返す。`phases` を持たない問題はキーごと出さない。
 *
 * `phased-polling` kind の dispatcher が time-based rule 切替に参照する。CDK synth 時に
 * metadata.json を走査し、Lambda 起動時 (`BATTLE_PROBLEMS_PHASES` env) に再度 file IO せず
 * 単一 JSON 文字列で受け取る (= cold start 削減)。
 */
export interface ProblemPhaseEntry {
  readonly name: string;
  readonly afterMinutes: number;
  readonly effect?: {
    readonly scorePathOverride?: string;
    readonly switchPlatformToDegraded?: readonly string[];
  };
  readonly description?: string;
}

export function discoverProblemsPhases(
  problemsRoot: string,
): Record<string, readonly ProblemPhaseEntry[]> {
  const result: Record<string, readonly ProblemPhaseEntry[]> = {};
  for (const meta of iterateProblemsMetadata(problemsRoot)) {
    if (!Array.isArray(meta.phases)) continue;
    const phases: ProblemPhaseEntry[] = [];
    for (const entry of meta.phases) {
      const phase = parsePhaseEntry(entry);
      if (phase) phases.push(phase);
    }
    if (phases.length > 0) result[meta.id] = phases;
  }
  return result;
}

function parsePhaseEntry(value: unknown): ProblemPhaseEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as {
    name?: unknown;
    afterMinutes?: unknown;
    effect?: unknown;
    description?: unknown;
  };
  if (typeof v.name !== "string" || typeof v.afterMinutes !== "number") return undefined;
  const effectInput =
    v.effect && typeof v.effect === "object" ? (v.effect as Record<string, unknown>) : undefined;
  const effect = effectInput
    ? {
        ...(typeof effectInput.scorePathOverride === "string"
          ? { scorePathOverride: effectInput.scorePathOverride }
          : {}),
        ...(Array.isArray(effectInput.switchPlatformToDegraded)
          ? {
              switchPlatformToDegraded: effectInput.switchPlatformToDegraded.filter(
                (s): s is string => typeof s === "string",
              ),
            }
          : {}),
      }
    : undefined;
  return {
    name: v.name,
    afterMinutes: v.afterMinutes,
    ...(effect ? { effect } : {}),
    ...(typeof v.description === "string" ? { description: v.description } : {}),
  };
}

/**
 * `discoverProblemsCatalog` の sibling (ADR-008 Phase 3 / Issue #642)。
 * `metadata.visibility === "private"` の問題 id のみを抜いて map で返す。
 * public 問題は省略 (= env var を最小化、 default 動作を維持)。
 *
 * Lambda env (`BATTLE_PROBLEMS_VISIBILITY`) として deploy-handler に渡し、
 * `CHALLENGE_PAYLOAD_BUCKET` env と組み合わせて S3 presigned URL を発行する判定に使う。
 * 両 env が空のときは従来の local-path 経路で動作 (= dormant default)。
 */
export function discoverProblemsVisibility(problemsRoot: string): Record<string, "private"> {
  const result: Record<string, "private"> = {};
  for (const meta of iterateProblemsMetadata(problemsRoot)) {
    if (meta.visibility === "private") {
      result[meta.id] = "private";
    }
  }
  return result;
}

/**
 * [ADR-028 / ADR-030 Phase 3 / #1420] `{ [problemId]: { plugin } }` を返す。 problem が
 * `interTeamCoordination.plugin` (= coordination plugin の module path) を宣言していれば収集する。
 * CoordinationDispatcher Lambda の `PROBLEM_COORDINATION` env へ JSON 化して渡し、 scope resolver が
 * team→moduleRef を解決するのに使う。 宣言の無い問題はキーごと不在 (= coordination 無効)。
 */
export function discoverProblemsCoordination(
  problemsRoot: string,
): Record<string, { readonly plugin: string }> {
  const result: Record<string, { readonly plugin: string }> = {};
  for (const meta of iterateProblemsMetadata(problemsRoot)) {
    const coord = meta.interTeamCoordination;
    if (!coord || typeof coord !== "object" || Array.isArray(coord)) continue;
    const plugin = (coord as { plugin?: unknown }).plugin;
    if (typeof plugin === "string" && plugin.length > 0) {
      result[meta.id] = { plugin };
    }
  }
  return result;
}

/**
 * Issue #888: 各 problem metadata.json から `disruptions[]` 宣言を抽出する。
 *
 * Lambda runtime に渡す形は `{ [problemId]: ProblemDisruptionEntry[] }`。 fire API が
 * `(problemId, disruptionId)` の組で declaration を引き、 `operatorEditable` allow-list /
 * `eventDetailType` などを参照する。
 *
 * `disruptions` を持たない問題はキーごと出さない (= env var を最小化)。
 */
/**
 * [ADR-013 Phase 2 / Issue #1422] condition-triggered disruption の発火条件。 OR で結合され、
 * 最初に true になった trigger で発火する (= scoring Lambda 側 eval、 重複は idempotency で抑制)。
 */
export type DisruptionTrigger =
  | { readonly kind: "after-deploy"; readonly afterMinutes: number }
  | { readonly kind: "team-score-above"; readonly threshold: number }
  | { readonly kind: "phase-entered"; readonly phaseName: string };

/**
 * [ADR-031 / Issue #1419] cross-account disruption の宣言的アクション種別。 executor がこの kind で
 * AssumeRole 後に叩く API を 1 本に dispatch する (ssm:SendCommand / lambda:InvokeFunction /
 * cloudformation:UpdateStack)。 platform は kind を dispatch するだけ、 障害の中身は問題が所有する。
 */
export type DisruptionActionKind = "ssm-run-command" | "lambda-invoke" | "cfn-stack-update";

export const DISRUPTION_ACTION_KINDS: readonly DisruptionActionKind[] = [
  "ssm-run-command",
  "lambda-invoke",
  "cfn-stack-update",
];

/**
 * [ADR-029 INV-2 / ADR-031] 障害の復旧宣言。 「いかなる disruption も永続しない」ための必須要素で、
 * executor は注入と同時に `afterSeconds` 後 (または round 終了 / clear API) の revert を予約する。
 */
export interface DisruptionActionRevert {
  readonly afterSeconds: number;
  readonly documentName?: string;
  readonly paramTemplate?: Readonly<Record<string, unknown>>;
}

/**
 * [ADR-031 / Issue #1419] disruption が競技者アカウントで起こす障害の宣言。 `targetRef` は team の
 * `stackOutputs` の key (= 注入対象を CFn 出力から解決)、 `paramTemplate` の `{{key}}` 置換は
 * `parameters` / `operatorEditable` 由来の値のみを参照できる (= injection 面の縮小)。 `revert` は必須。
 */
export interface DisruptionAction {
  readonly kind: DisruptionActionKind;
  readonly targetRef: string;
  readonly documentName?: string;
  readonly functionRef?: string;
  readonly paramTemplate?: Readonly<Record<string, unknown>>;
  readonly revert: DisruptionActionRevert;
}

/**
 * [ADR-033 / Issue #1665] disruption の **採点上の効果**。 実クラウドへの fault 注入 (= {@link DisruptionAction})
 * とは別レイヤで、 採点エンジンが active window の間だけ team の点に直接効果を与える (= シナリオ圧力)。
 *
 * `kind: "penalty"` のみ実装済 (= active な各 tick で `points` を減点)。 `durationSeconds` は ADR-029
 * 「いかなる障害も永続しない」に従い正の有限秒・上限 1h。 `unavailability` 等は follow-up。
 */
export type DisruptionEffect = {
  readonly kind: "penalty";
  readonly points: number;
  readonly durationSeconds: number;
};

/** [ADR-033] 採点上の効果の上限秒 (= ADR-029 と揃え 1h、 永続障害を禁止)。 */
export const DISRUPTION_EFFECT_MAX_DURATION_SECONDS = 3600;

export interface ProblemDisruptionEntry {
  readonly id: string;
  readonly name: string;
  readonly eventDetailType: string;
  readonly description?: string;
  readonly defaultAfterMinutes?: number;
  readonly operatorEditable?: readonly string[];
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly publicHint?: boolean;
  /** [ADR-013 Phase 2 / #1422] 宣言時のみ condition-triggered 発火が有効 (省略 = Phase 1 self-fire のみ)。 */
  readonly triggers?: readonly DisruptionTrigger[];
  /** [ADR-031 / #1419] cross-account 実行アクション (省略 = Phase A 監査のみ = 後方互換)。 */
  readonly action?: DisruptionAction;
  /** [ADR-033 / #1665] 採点上の効果 (省略 = 効果なし = 後方互換)。 */
  readonly effect?: DisruptionEffect;
  /**
   * [ADR-037 Slice 3] 条件発火 (triggers) 時に「定期実行」させる宣言。 宣言されると trigger 成立時に
   * recurrence を載せて発火し、 executor が `rate(intervalMinutes)` schedule を作って maxFires 回くり返す
   * (= 「スコア一定以上で定期妨害」)。 省略 = 1 回だけ発火 (= 後方互換)。
   */
  readonly recurrence?: { readonly intervalMinutes: number; readonly maxFires: number };
}

/**
 * SCHEMA `disruptions[].effect` を fail-safe に取り出す。 `kind="penalty"` / `points` が正の有限数 /
 * `durationSeconds` が正の有限数かつ上限以内のときだけ返し、 それ以外は undefined (= 効果なしに倒す)。
 * 宣言時の strict 検証は validate-problems が担う ({@link parseDisruptionAction} と同型)。
 */
export function parseDisruptionEffect(value: unknown): DisruptionEffect | undefined {
  if (!isPlainObject(value)) return undefined;
  if (value.kind !== "penalty") return undefined;
  const points = value.points;
  const durationSeconds = value.durationSeconds;
  if (typeof points !== "number" || !Number.isFinite(points) || points <= 0) return undefined;
  if (
    typeof durationSeconds !== "number" ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    durationSeconds > DISRUPTION_EFFECT_MAX_DURATION_SECONDS
  ) {
    return undefined;
  }
  return { kind: "penalty", points, durationSeconds };
}

/**
 * SCHEMA `disruptions[].action` を型付きで取り出す。 executor が安全に実行できる形 (= kind が
 * allow-list 内、 targetRef が string、 revert.afterSeconds が正の有限数) のときだけ返し、 それ以外は
 * undefined (= fail-safe で Phase A 監査のみに倒す)。 宣言時の strict 検証は validate-problems が担う。
 */
export function parseDisruptionAction(value: unknown): DisruptionAction | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as {
    kind?: unknown;
    targetRef?: unknown;
    documentName?: unknown;
    functionRef?: unknown;
    paramTemplate?: unknown;
    revert?: unknown;
  };
  if (!isDisruptionActionKind(v.kind) || typeof v.targetRef !== "string" || v.targetRef === "") {
    return undefined;
  }
  const revert = parseDisruptionActionRevert(v.revert);
  if (!revert) return undefined;
  return {
    kind: v.kind,
    targetRef: v.targetRef,
    ...(typeof v.documentName === "string" ? { documentName: v.documentName } : {}),
    ...(typeof v.functionRef === "string" ? { functionRef: v.functionRef } : {}),
    ...(isPlainObject(v.paramTemplate) ? { paramTemplate: v.paramTemplate } : {}),
    revert,
  };
}

function isDisruptionActionKind(value: unknown): value is DisruptionActionKind {
  return (
    typeof value === "string" && DISRUPTION_ACTION_KINDS.includes(value as DisruptionActionKind)
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDisruptionActionRevert(value: unknown): DisruptionActionRevert | undefined {
  if (!isPlainObject(value)) return undefined;
  const afterSeconds = value.afterSeconds;
  if (typeof afterSeconds !== "number" || !Number.isFinite(afterSeconds) || afterSeconds <= 0) {
    return undefined;
  }
  return {
    afterSeconds,
    ...(typeof value.documentName === "string" ? { documentName: value.documentName } : {}),
    ...(isPlainObject(value.paramTemplate) ? { paramTemplate: value.paramTemplate } : {}),
  };
}

/** SCHEMA `disruptions[].triggers[]` (oneOf) を型付きで取り出す。 不正 / 不明 kind は drop。 */
export function parseDisruptionTriggers(value: unknown): DisruptionTrigger[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: DisruptionTrigger[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const t = raw as {
      kind?: unknown;
      afterMinutes?: unknown;
      threshold?: unknown;
      phaseName?: unknown;
    };
    if (t.kind === "after-deploy" && typeof t.afterMinutes === "number") {
      out.push({ kind: "after-deploy", afterMinutes: t.afterMinutes });
    } else if (t.kind === "team-score-above" && typeof t.threshold === "number") {
      out.push({ kind: "team-score-above", threshold: t.threshold });
    } else if (t.kind === "phase-entered" && typeof t.phaseName === "string") {
      out.push({ kind: "phase-entered", phaseName: t.phaseName });
    }
  }
  return out.length > 0 ? out : undefined;
}

export function discoverProblemsDisruptions(
  problemsRoot: string,
): Record<string, readonly ProblemDisruptionEntry[]> {
  const result: Record<string, readonly ProblemDisruptionEntry[]> = {};
  for (const meta of iterateProblemsMetadata(problemsRoot)) {
    if (!Array.isArray(meta.disruptions)) continue;
    const entries: ProblemDisruptionEntry[] = [];
    for (const raw of meta.disruptions) {
      const entry = parseDisruptionEntry(raw);
      if (entry) entries.push(entry);
    }
    if (entries.length > 0) result[meta.id] = entries;
  }
  return result;
}

/**
 * Lambda env (= `BATTLE_PROBLEMS_DISRUPTIONS`、 `discoverProblemsDisruptions` の出力を JSON 化した
 * もの) を `{ [problemId]: ProblemDisruptionEntry[] }` に戻す。 未設定 / 壊れた JSON は空 map。
 */
export function parseDisruptionsCatalogEnv(
  raw: string | undefined,
): Record<string, readonly ProblemDisruptionEntry[]> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, readonly ProblemDisruptionEntry[]>;
  } catch {
    return {};
  }
}

/**
 * SCHEMA `disruptions[].recurrence` を fail-safe に取り出す。 両 field 正の有限整数のみ採用 (それ以外は
 * undefined = 1 回だけ発火)。 上限は手動 fire の schema と揃え intervalMinutes ≤ 1440 / maxFires ≤ 60。
 */
export function parseDisruptionRecurrence(
  value: unknown,
): { intervalMinutes: number; maxFires: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as { intervalMinutes?: unknown; maxFires?: unknown };
  const { intervalMinutes, maxFires } = v;
  if (
    typeof intervalMinutes !== "number" ||
    !Number.isInteger(intervalMinutes) ||
    intervalMinutes < 1 ||
    intervalMinutes > 1440
  ) {
    return undefined;
  }
  if (
    typeof maxFires !== "number" ||
    !Number.isInteger(maxFires) ||
    maxFires < 1 ||
    maxFires > 60
  ) {
    return undefined;
  }
  return { intervalMinutes, maxFires };
}

function parseDisruptionEntry(value: unknown): ProblemDisruptionEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as {
    id?: unknown;
    name?: unknown;
    eventDetailType?: unknown;
    description?: unknown;
    defaultAfterMinutes?: unknown;
    operatorEditable?: unknown;
    parameters?: unknown;
    publicHint?: unknown;
    triggers?: unknown;
    action?: unknown;
    effect?: unknown;
    recurrence?: unknown;
  };
  if (
    typeof v.id !== "string" ||
    typeof v.name !== "string" ||
    typeof v.eventDetailType !== "string"
  ) {
    return undefined;
  }
  const triggers = parseDisruptionTriggers(v.triggers);
  const action = parseDisruptionAction(v.action);
  const effect = parseDisruptionEffect(v.effect);
  const recurrence = parseDisruptionRecurrence(v.recurrence);
  return {
    id: v.id,
    name: v.name,
    eventDetailType: v.eventDetailType,
    ...(typeof v.description === "string" ? { description: v.description } : {}),
    ...(typeof v.defaultAfterMinutes === "number"
      ? { defaultAfterMinutes: v.defaultAfterMinutes }
      : {}),
    ...(Array.isArray(v.operatorEditable)
      ? {
          operatorEditable: v.operatorEditable.filter((s): s is string => typeof s === "string"),
        }
      : {}),
    // PR #889 review: typeof [] === "object" のため array が漏れる。 Record/object のみ許容。
    ...(v.parameters && typeof v.parameters === "object" && !Array.isArray(v.parameters)
      ? { parameters: v.parameters as Record<string, unknown> }
      : {}),
    ...(typeof v.publicHint === "boolean" ? { publicHint: v.publicHint } : {}),
    ...(triggers ? { triggers } : {}),
    ...(action ? { action } : {}),
    ...(effect ? { effect } : {}),
    ...(recurrence ? { recurrence } : {}),
  };
}

interface ProblemMetadataEntry {
  id: string;
  category: string;
  dirName: string;
  scoring: unknown;
  endpoints: unknown;
  phases: unknown;
  visibility: unknown;
  disruptions: unknown;
  interTeamCoordination: unknown;
}

function* iterateProblemsMetadata(problemsRoot: string): Generator<ProblemMetadataEntry> {
  if (!fs.existsSync(problemsRoot)) {
    console.warn(
      `[discoverProblemsCatalog] ${problemsRoot} not found — assuming pre-install or wrong cwd. ` +
        `Catalog will be empty; tenant API will reject all problemId.`,
    );
    return;
  }
  for (const category of fs.readdirSync(problemsRoot, { withFileTypes: true })) {
    if (!category.isDirectory()) continue;
    const categoryDir = path.join(problemsRoot, category.name);
    for (const problem of fs.readdirSync(categoryDir, { withFileTypes: true })) {
      if (!problem.isDirectory()) continue;
      const metadataPath = path.join(categoryDir, problem.name, "metadata.json");
      const metadata = readProblemMetadata(metadataPath, category.name, problem.name);
      if (metadata) yield metadata;
    }
  }
}

function readProblemMetadata(
  metadataPath: string,
  category: string,
  dirName: string,
): ProblemMetadataEntry | undefined {
  if (!fs.existsSync(metadataPath)) return undefined;
  try {
    const meta = JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as {
      id?: unknown;
      scoring?: unknown;
      endpoints?: unknown;
      phases?: unknown;
      visibility?: unknown;
      disruptions?: unknown;
      interTeamCoordination?: unknown;
    };
    if (typeof meta.id !== "string" || meta.id.length === 0) {
      console.warn(`[discoverProblemsCatalog] ${metadataPath}: missing or invalid 'id' field`);
      return undefined;
    }
    return {
      id: meta.id,
      category,
      dirName,
      scoring: meta.scoring,
      endpoints: meta.endpoints,
      phases: meta.phases,
      visibility: meta.visibility,
      disruptions: meta.disruptions,
      interTeamCoordination: meta.interTeamCoordination,
    };
  } catch (err) {
    console.warn(
      `[discoverProblemsCatalog] ${metadataPath}: parse failed (${(err as Error).message}). ` +
        `Run 'make validate-problems' to see schema errors.`,
    );
    return undefined;
  }
}
