import { z } from "zod";
import { PROBLEM_ID_RE } from "./constants.js";

/**
 * Issue #2283: Event Deployment の Progression Gate (問題アンロック / チーム別ハンデ)。
 *
 * Gate は Challenge 自体の固定属性ではなく **Event の競技ルール** なので、 設定は
 * Event 行 (`EventItem.progressionGate`) に保存する。 Challenge metadata / catalog 側には
 * 強制ルールを持たせない (`onboardingOrder` は表示順ヒントに留める)。
 *
 * 本 module は event-handler (設定 API) / participant-handler (access enforcement) /
 * generic-scoring-handler (完了 bonus) の 3 Lambda から共有される唯一の定義箇所:
 *   - `ProgressionGateConfigSchema` — wire / 保存 shape の Zod schema
 *   - `resolveTeamGatePolicy` — Event default + team override の合成
 *   - `isGateCompleted` — 「Gate 完了」 判定 (初期実装は score > 0 or flagSubmitted。
 *     Issue #2283 の通り 「スコア獲得」 と 「Gate 完了」 は概念分離しており、 将来
 *     明示 completion event / uptime 維持等に差し替えられるようこの 1 関数に集約する)
 *   - `computeLockedProblemIds` — team の locked 問題集合 (毎回 pure に導出、 永続しない)
 *
 * Feature Flag (`challengePrerequisiteGate`, 既定 OFF) の判定は enforcement 側の責務
 * (= `tenant-feature-flags.ts`)。 Flag OFF ↔ ON の切替が進行中 Event へ即時反映されるよう、
 * lock 状態は一切永続せず read 時に毎回導出する。
 */

/** ADR-035 の per-tenant runtime flag key。 既定 OFF (= tenant FLAGS 行に true が無い限り無効)。 */
export const CHALLENGE_PREREQUISITE_GATE_FLAG = "challengePrerequisiteGate";

/**
 * problemId の形式は `shared/constants.ts` の `PROBLEM_ID_RE` を参照する
 * (= `EventProblemTargetSchema.problemId` と同じ RFC1035-ish slug。 重複定義しない)。
 */
export const GATE_PROBLEM_ID_RE = PROBLEM_ID_RE;

/** 完了 bonus の上限。 uptime 1 分 +100pt 規模の競技で桁違いの handicap を入力ミスで作らないための天井。 */
export const MAX_COMPLETION_BONUS = 100_000;

export const ProgressionGateTeamPolicySchema = z.enum(["required", "off"]);
export type ProgressionGateTeamPolicy = z.infer<typeof ProgressionGateTeamPolicySchema>;

/**
 * team 単位の上書き。
 *   - `required`: Gate 完了まで unlock target を開始できない
 *   - `off`: この team は Gate を bypass (= 最初から全問題)
 *   - `completionBonus`: Gate 完了時に 1 度だけ付与する固定ボーナス (省略時 0)
 */
export const ProgressionGateTeamOverrideSchema = z
  .object({
    policy: ProgressionGateTeamPolicySchema,
    completionBonus: z.number().int().min(0).max(MAX_COMPLETION_BONUS).optional(),
  })
  .strict();
export type ProgressionGateTeamOverride = z.infer<typeof ProgressionGateTeamOverrideSchema>;

/**
 * Event 1 件の Gate 設定 (= `PUT /events/:eventId/progression-gate` body / EventItem 保存 shape)。
 *
 * 初期実装は 「1 つの Gate challenge を起点に指定 target を unlock」 の単一 Gate モデル
 * (複数 Gate / 分岐ルートは Issue #2283 の将来拡張)。 自己参照 (= gate が自分自身を
 * unlock する) と重複 target は schema 段階で reject する。 単一 Gate なので循環参照は
 * 自己参照と等価。 「Event に含まれる問題か」 「team override の teamId が実在するか」 の
 * cross-entity 検証は event-handler の service 層 (= Event 行 / Teams を引ける場所) で行う。
 */
export const ProgressionGateConfigSchema = z
  .object({
    gateProblemId: z.string().regex(GATE_PROBLEM_ID_RE),
    unlockTargetIds: z.array(z.string().regex(GATE_PROBLEM_ID_RE)).min(1).max(49),
    defaultPolicy: ProgressionGateTeamPolicySchema,
    teamOverrides: z
      .record(z.string().min(1).max(64), ProgressionGateTeamOverrideSchema)
      .optional(),
  })
  .strict()
  .refine((cfg) => !cfg.unlockTargetIds.includes(cfg.gateProblemId), {
    message: "gateProblemId must not be one of unlockTargetIds (self reference)",
    path: ["unlockTargetIds"],
  })
  .refine((cfg) => new Set(cfg.unlockTargetIds).size === cfg.unlockTargetIds.length, {
    message: "unlockTargetIds must be unique",
    path: ["unlockTargetIds"],
  });
export type ProgressionGateConfig = z.infer<typeof ProgressionGateConfigSchema>;

/**
 * DDB 行に保存された値を寛容に parse する (= 手書き行 / 旧 shape への防御)。
 * schema を満たさない値は `undefined` (= Gate 無し) に倒す — 不正な設定行で
 * 競技操作を誤 block しないため (Gate は既定 OFF の opt-in 機能)。
 */
export function parseProgressionGate(raw: unknown): ProgressionGateConfig | undefined {
  const parsed = ProgressionGateConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export interface ResolvedTeamGatePolicy {
  readonly policy: ProgressionGateTeamPolicy;
  readonly completionBonus: number;
}

/** Event default policy に team override を合成する。 teamId 不明 (= 旧行) は default に倒す。 */
export function resolveTeamGatePolicy(
  config: ProgressionGateConfig,
  teamId: string | undefined,
): ResolvedTeamGatePolicy {
  const override = teamId ? config.teamOverrides?.[teamId] : undefined;
  return {
    policy: override?.policy ?? config.defaultPolicy,
    completionBonus: override?.completionBonus ?? 0,
  };
}

/**
 * Gate 完了判定 (初期実装)。 Gate challenge の deployment 行が
 *   - `gateCompletedAt` 済 (= scoring tick が latch した one-time marker。 完了後に
 *     uptime penalty で score が 0 以下へ戻っても再 lock しないための固定化) または
 *   - `score > 0` (= 最初の有効 probe / 加点が発生した。 Issue #2283 が明示的に認める
 *     初期 completion 判定。 multi-flag の部分正解も 「初回加点」 として完了扱いになる) または
 *   - `flagSubmitted === true` (= flag 系: 正解 submit 済)
 * なら完了。 行が無い (= 未 deploy) は未完了。
 *
 * 概念分離 (Issue #2283): 「Gate 完了」 の定義を将来 (明示 completion event / uptime N 分
 * 維持等) に差し替えるときは本関数だけを変更する。
 */
export function isGateCompleted(
  gateItem:
    | {
        readonly score?: unknown;
        readonly flagSubmitted?: unknown;
        readonly gateCompletedAt?: unknown;
      }
    | undefined,
): boolean {
  if (!gateItem) return false;
  if (typeof gateItem.gateCompletedAt === "string") return true;
  return Number(gateItem.score ?? 0) > 0 || gateItem.flagSubmitted === true;
}

/**
 * team 視点の locked 問題集合を pure に導出する。 永続しないので Feature Flag OFF /
 * Gate 設定削除 / Gate 完了のいずれでも次の read から即 unlock される。
 * (Feature Flag の判定は caller 側 — flag OFF なら本関数を呼ばず全 unlock 扱いにする。)
 */
export function computeLockedProblemIds(
  config: ProgressionGateConfig,
  teamId: string | undefined,
  gateCompleted: boolean,
): ReadonlySet<string> {
  const { policy } = resolveTeamGatePolicy(config, teamId);
  if (policy === "off" || gateCompleted) return new Set();
  return new Set(config.unlockTargetIds);
}
