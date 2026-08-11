import { z } from "zod";
import { ULID_RE as JOB_ID_RE, PROBLEM_ID_RE } from "../shared/constants.js";

/**
 * Issue #1242: participant-handler 全 route 境界の入力 schema を 1 箇所に集約する。
 *
 * 旧 index.ts は body / query / path-param を `Record<string, unknown>` から手動 cast
 * していた (= field 型 / required check が grep でしか見えなかった)。 deploy-handler /
 * event-handler では既に zod で validate しているため、 同じ pattern を participant-handler
 * にも適用する。
 *
 * 設計方針:
 *   - schema は default mode (= 余剰 field passthrough)。 未知 field を strict reject
 *     すると、 frontend / SDK が新 field を追加した瞬間に旧 Lambda 全部が 400 を返し
 *     deploy 順序事故を起こす (= rolling deploy の互換性破壊)。 required field は厳密。
 *   - PATH param は kebab / regex check が既に shared/constants.ts に居る (PROBLEM_ID_RE /
 *     ULID_RE)。 schema は `.regex()` で同じ pattern を表現し、 1 source of truth を維持。
 *   - downstream service が `unknown` を再 validate しているケース (= submitFlag / castEvent
 *     / setDisplayTeamName) も schema 適用後は typed value を渡せるが、 service 側の
 * defensive validation は残す (DB row 改竄 / schema drift 防御層、 既存の分離契約と整合)。
 *
 * route → schema 対応:
 *   - GET    /portal/me                                       — token only (schema 不要)
 *   - GET    /portal/me/score-events                          — token only (schema 不要)
 *   - GET    /portal/me/console-signin-url                    SsoQuerySchema (?jobId)
 *   - GET    /portal/me/cli-credentials                       SsoQuerySchema (?jobId)
 *   - GET    /portal/me/notifications                         NotificationsQuerySchema (?limit)
 *   - POST   /portal/me/cast-event                            CastEventBodySchema
 *   - GET    /portal/me/event-inbox                           EventInboxQuerySchema (?jobId&sinceMs)
 *   - GET    /portal/me/battle-attacks                        BattleAttacksQuerySchema (?jobId&sinceMin)
 *   - GET    /portal/me/deploy-logs                           DeployLogsQuerySchema (?jobId&limit&nextToken)
 *   - GET    /portal/leaderboard                              — token only
 *   - GET    /portal/leaderboard/score-events                 — token only
 *   - PATCH  /portal/me                                       PatchMeBodySchema
 *   - POST   /portal/me/submit-flag                           SubmitFlagBodySchema
 *   - POST   /portal/me/problems/:problemId/hints/:hintId/reveal  ProblemHintParamSchema (path)
 *   - GET    /portal/me/problems/:problemId/endpoints              ProblemIdParamSchema (path)
 *   - POST   /portal/me/problems/:problemId/endpoints/:slot        ProblemSlotParamSchema + UpsertEndpointBodySchema
 *   - DELETE /portal/me/problems/:problemId/endpoints/:slot        ProblemSlotParamSchema
 */

/** slot 名は kebab-case (`metadata.endpoints[].slot` pattern と同じ)。 */
export const SLOT_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** hint id は metadata.json 側で `[a-z0-9][a-z0-9-]{0,63}` 想定。 既存 handler の 1〜64 文字 cap を維持。 */
const HINT_ID_MAX = 64;

const ProblemIdSchema = z.string().regex(PROBLEM_ID_RE, "invalid_problem_id");
const JobIdSchema = z.string().regex(JOB_ID_RE, "invalid_jobid");
const SlotSchema = z.string().regex(SLOT_NAME_RE, "invalid_slot");
const HintIdSchema = z.string().min(1).max(HINT_ID_MAX);

/**
 * Hono の `c.req.query()` は常に `string | undefined` を返す。 number 系の field は
 * `z.coerce.number()` で受けて `safeParse` 段で NaN / float を reject する。
 * 旧コードは `Number(raw)` → service 側で `Number.isInteger` reject だったので、
 * 同等の振る舞いを schema layer に持ち上げる。
 */
const OptionalIntFromQuery = z
  .union([z.string(), z.undefined()])
  .transform((v) => (v === undefined ? undefined : Number(v)))
  .refine((v) => v === undefined || Number.isFinite(v), { message: "not_a_number" });

/* ────────── body schemas ────────── */

/**
 * PATCH /portal/me — チーム表示名の更新。 service 側の `validateTeamName` (RE / 1-40 文字)
 * を二重に呼ぶのは過剰なので schema は `string` を要求するだけに留め、 文字種制約は
 * service が単独で評価する (= update.ts の TEAM_NAME_RE を 1 source of truth に保つ)。
 */
export const PatchMeBodySchema = z.object({
  teamName: z.string(),
});

/**
 * POST /portal/me/submit-flag — { problemId, flag, flagId? }。 旧 index.ts は service に渡す前に
 * regex / length check を index.ts で並べていた。 schema layer に集約。
 *
 * Issue #1796: multi-flag kind で「どの sub-flag への提出か」 を表す optional `flagId`。 単一 flag
 * kind は無視する (= 後方互換)。 cap は hint id と同じ 1-64 文字。
 */
export const SubmitFlagBodySchema = z.object({
  problemId: ProblemIdSchema,
  flag: z.string().min(1).max(200),
  flagId: z.string().min(1).max(64).optional(),
});

/**
 * POST /portal/me/cast-event — inter-team dispatch primitive。
 *
 * - `targetJobId` は ULID
 * - `kind` は `[a-z][a-z0-9-]{0,63}` (= cast-event.ts の KIND_RE)
 * - `payload` は object | null | undefined のいずれか。 service 側で 4 KB cap を二重 check
 */
const CAST_EVENT_KIND_RE = /^[a-z][a-z0-9-]{0,63}$/;
export const CastEventBodySchema = z.object({
  targetJobId: JobIdSchema,
  kind: z.string().regex(CAST_EVENT_KIND_RE, "invalid_kind"),
  payload: z.union([z.record(z.string(), z.unknown()), z.null(), z.undefined()]).optional(),
});

/**
 * POST /portal/me/coordination/op — body は { op }。 op の意味論 (alliance / route / 等) は
 * 問題同梱 plugin の validateOp が判定するので、 schema は op の存在だけを要求し中身は通す
 * (= 過剰な platform 側 validation を持ち込まない。 size は DDB 400KB 制約が loud に弾く)。
 */
export const CoordinationOpBodySchema = z.object({
  op: z.unknown(),
});

/**
 * POST /portal/me/problems/:problemId/endpoints/:slot — body は { url }。
 * URL の細かい validation (= http/https / 長さ / プライベート IP 等) は
 * `isValidOverrideUrl` (= service 側) が一手に行うので、 schema は `string` のみ要求。
 */
export const UpsertEndpointBodySchema = z.object({
  url: z.string(),
});

/* ────────── query schemas ────────── */

export const SsoQuerySchema = z.object({
  jobId: JobIdSchema,
});

/**
 * [Composite Runtime / Issue #2077] Path params for the composite-target AWS
 * access bridge routes. Both ids are ULIDs and are consumed ONLY as a lookup key
 * — never as an authority. The server resolves the role ARN / account id / role
 * chain from the team-scoped target row, so no such field appears here.
 */
export const CompositeTargetAccessParamSchema = z.object({
  parentDeploymentId: JobIdSchema,
  targetDeploymentId: JobIdSchema,
});

export const NotificationsQuerySchema = z.object({
  /** undefined は handler 側で default (NOTIFICATIONS_DEFAULT_LIMIT) を適用する。 */
  limit: OptionalIntFromQuery,
});

export const EventInboxQuerySchema = z.object({
  jobId: JobIdSchema,
  /** undefined のときは handler 側で `Date.now() - INBOX_SINCE_MS_MAX` を default。 */
  sinceMs: OptionalIntFromQuery,
});

export const BattleAttacksQuerySchema = z.object({
  jobId: JobIdSchema,
  /** undefined のときは BATTLE_ATTACKS_SINCE_MIN_DEFAULT を handler 側で default。 */
  sinceMin: OptionalIntFromQuery,
});

export const DeployLogsQuerySchema = z.object({
  jobId: JobIdSchema,
  /** 旧 `parseDeployLogLimit` (= 1〜100 / 整数) は service 側に残し、 schema は受信のみ。 */
  limit: z.string().optional(),
  nextToken: z.string().optional(),
});

/* ────────── path-param schemas ────────── */

export const ProblemIdParamSchema = z.object({
  problemId: ProblemIdSchema,
});

export const ProblemSlotParamSchema = z.object({
  problemId: ProblemIdSchema,
  slot: SlotSchema,
});

export const ProblemHintParamSchema = z.object({
  problemId: ProblemIdSchema,
  hintId: HintIdSchema,
});
