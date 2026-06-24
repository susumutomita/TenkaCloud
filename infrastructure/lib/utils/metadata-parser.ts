/**
 * 問題の `metadata.json` の **pure parser** 群 (SRP)。
 *
 * `discover-problems-catalog.ts` が `problems/<category>/<id>/metadata.json` を fs 走査して
 * section ごとに切り出すのに対し、 本 module は I/O を一切持たず「1 件の unknown を型付き
 * value に narrow する」純関数だけを集める (= `scoring-metadata.ts` / `endpoints-metadata.ts`
 * と同じ sibling 方針)。 各関数は CDK synth 時 (discover 経由) と Lambda runtime の両方から
 * 参照されるため、 副作用無しに保ち unit test で全分岐を pin できるようにする。
 *
 * 公開面 (型 / 関数) は `discover-problems-catalog.ts` から re-export されるので、 既存 importer は
 * これまで通り `discover-problems-catalog.js` から import し続けられる。
 */

/**
 * [ADR-012 Phase 3.B] `phased-polling` kind の time-based rule 切替宣言の 1 件。
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `metadata.json:phases[]` の 1 件を `ProblemPhaseEntry` に narrow する。 `name` / `afterMinutes` が
 * 揃わなければ undefined。 `effect.switchPlatformToDegraded` は string 要素だけ filter する。
 */
export function parsePhaseEntry(value: unknown): ProblemPhaseEntry | undefined {
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

/**
 * `metadata.json:disruptions[]` の 1 件を `ProblemDisruptionEntry` に narrow する。 `id` / `name` /
 * `eventDetailType` が揃わなければ undefined。 triggers / action / effect / recurrence は各 sub-parser に委譲。
 */
export function parseDisruptionEntry(value: unknown): ProblemDisruptionEntry | undefined {
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
