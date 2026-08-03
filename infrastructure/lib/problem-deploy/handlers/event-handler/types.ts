import { z } from "zod";
import type {
  EventProblemTarget,
  EventRecord,
  EventStatus,
} from "../../control-data/domain/events.js";
import type { TeamRecord } from "../../control-data/domain/teams.js";
import { ProgressionGateConfigSchema } from "../shared/progression-gate.js";

// [Issue #2527 Slice 1 step 2] The domain module owns these shapes; this handler
// re-exports them so existing importers keep their import path.
export type { EventProblemTarget } from "../../control-data/domain/events.js";

/**
 * 1 競技イベント (= ADR-004 の Event aggregate) の DDB 行 shape。
 *
 *   PK     = `EVENT#<eventId>` / SK = `META`
 *   GSI1PK = `TENANT#<tenantId>` / GSI1SK = `<createdAt>` (ISO8601)
 *
 * [Issue #2527 Slice 1 step 2] The domain fields live on {@link EventRecord}
 * (`control-data/domain/events.ts`, the source of truth); this item only adds
 * the physical DynamoDB keys.
 */
export interface EventItem extends EventRecord {
  PK: string;
  SK: "META";
  GSI1PK: string;
  GSI1SK: string;
}

export const EventStatusSchema = z.enum([
  "DRAFT",
  "DEPLOYING",
  "READY",
  "ENDED",
  "TEARDOWN",
  "ARCHIVED",
]);

/**
 * Event 内の 1 問題ごとの deploy target の validation schema。 shape の正本は
 * `control-data/domain/events.ts` の {@link EventProblemTarget} (下の lock-step
 * guard で一致を強制)。 `defaultAwsAccountId` は migration 期間中 optional に保ち、
 * Phase 2 で完全削除する予定 (#528)。
 */
export const EventProblemTargetSchema = z.object({
  problemId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/),
  /** @deprecated #528 で team 単位 (team.awsAccountId) に移行。旧 Event の fallback としてのみ残す */
  defaultAwsAccountId: z
    .string()
    .regex(/^\d{12}$/, "AWS Account ID は 12 桁の数字")
    .optional(),
  defaultRegion: z.string().regex(/^[a-z]{2}-[a-z]+-\d+$/, "AWS region 形式が不正です"),
});

// [Issue #2527 Slice 1 step 2] Compile-time lock-step guards: each validation
// schema and its domain shape must stay identical (either drifting direction
// fails typecheck).
type _MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _eventStatusLockstep: _MutuallyAssignable<
  z.infer<typeof EventStatusSchema>,
  EventStatus
> = true;
const _eventProblemTargetLockstep: _MutuallyAssignable<
  z.infer<typeof EventProblemTargetSchema>,
  EventProblemTarget
> = true;

/**
 * Team aggregate の DDB 行 shape。
 *
 *   PK     = `EVENT#<eventId>` / SK = `TEAM#<teamId>`
 *   GSI1PK = `TENANT#<tenantId>` / GSI1SK = `EVENT#<eventId>#TEAM#<teamId>`
 *
 * [Issue #2674] 旧 GSI2 (`TEAMKEY#<平文キー>`) は Teams テーブルごと削除済み —
 * participant 認証は Deployments テーブルの GSI2 が正本。
 *
 * [Issue #2527 Slice 1 step 2] The domain fields live on {@link TeamRecord}
 * (`control-data/domain/teams.ts`, the source of truth); this item adds the
 * physical DynamoDB keys and re-requires `teamLoginKey` (the DynamoDB row always
 * carries the bearer; the domain record keeps it optional because SQL point/list
 * payloads deliberately omit the plaintext).
 */
export interface TeamItem extends Omit<TeamRecord, "teamLoginKey"> {
  PK: string;
  SK: string;
  GSI1PK: string;
  GSI1SK: string;
  /** 短命 bearer。team scope (1 key で event 内 N 問題にアクセス可)。 */
  teamLoginKey: string;
}

/**
 * `POST /events` のリクエスト body。
 *
 * `teams` には internalSlug を operator が指定する。チーム数だけ array を送る。
 * `problems` には deploy する problemId と各々の default account / region。
 */
export const CreateEventRequestSchema = z.object({
  name: z.string().min(1).max(120),
  teams: z
    .array(
      z
        .object({
          internalSlug: z
            .string()
            .min(1)
            .max(40)
            .regex(
              /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/,
              "internalSlug は a-z0-9- (RFC1035-ish) のみ",
            ),
          /** #528: AWS-only events require this; non-AWS single-provider events use teamSlug credentials. */
          awsAccountId: z
            .string()
            .regex(/^\d{12}$/, "AWS Account ID は 12 桁の数字")
            .optional(),
          /** #2563: Non-AWS credential lookup slug registered via /admin/team-cloud-credentials. */
          nonAwsCredentialTeamSlug: z
            .string()
            .min(1)
            .max(40)
            .regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/, "teamSlug は a-z0-9- のみ")
            .optional(),
        })
        .refine(
          (team) => team.awsAccountId !== undefined || team.nonAwsCredentialTeamSlug !== undefined,
          {
            message:
              "awsAccountId (AWS event) か nonAwsCredentialTeamSlug (non-AWS event) のどちらかが必須",
          },
        ),
    )
    .min(1)
    // create.ts は event 1 行 + teams を 1 つの atomic TransactWrite で書く。 TransactWrite は
    // 100 item 上限なので teams は最大 99 (= 100 - event 1 行)。 以前 max(100) だったが、 event
    // 行の +1 を数え落とした off-by-one で、 schema 上は通る 100-team request が runtime で
    // `TransactWrite items > 100` を投げて 500 になっていた。 schema を実上限に揃える。
    .max(99, "1 event あたり最大 99 teams (event 1 行 + teams で DDB TransactWrite 100-item 上限)"),
  problems: z.array(EventProblemTargetSchema).min(1).max(50),
});
export type CreateEventRequest = z.infer<typeof CreateEventRequestSchema>;

/**
 * `POST /events` のレスポンス。作成時の teamLoginKey はこのレスポンスで一度だけ露出する。
 * 紛失時は明示的な rotation endpoint で別キーを再発行し、保存済み平文を再読込しない。
 */
export const CreateEventResponseSchema = z.object({
  eventId: z.string(),
  status: EventStatusSchema,
  createdAt: z.string(),
  expiresAt: z.number(),
  teams: z.array(
    z.object({
      teamId: z.string(),
      internalSlug: z.string(),
      teamLoginKey: z.string(),
    }),
  ),
  problems: z.array(EventProblemTargetSchema),
});
export type CreateEventResponse = z.infer<typeof CreateEventResponseSchema>;

export const EventSummarySchema = z.object({
  eventId: z.string(),
  name: z.string(),
  status: EventStatusSchema,
  teamCount: z.number(),
  problemCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  expiresAt: z.number(),
  startsAt: z.string().optional(),
  /** 競技終了時刻 (#536)。HealthCheck が `now >= endsAt` で gate 閉。
   *  「Event を終了」 button = now を書く / 「日時を指定して終了」 = 未来時刻を書く。 */
  endsAt: z.string().optional(),
  /** [ADR-047] 自動撤去予定時刻。reconciler が `now >= teardownAt` で bulk teardown を自動発火。 */
  teardownAt: z.string().optional(),
  /** [ADR-047 follow-up] 自動デプロイ予定時刻。reconciler が `now >= deployAt` で DRAFT event を bulk deploy。 */
  deployAt: z.string().optional(),
  /** 採点 lock flag (#558)。true なら加点経路全停止、read のみ可。 */
  scoringLocked: z.boolean().optional(),
  /** scoringLocked を true にした時刻 (#558)。 */
  scoringLockedAt: z.string().optional(),
  /**
   * Issue #1038 P1 #9 follow-up: scoreboard freeze window 分数。 operator が PATCH /schedule で
   * 設定。 0=freeze 無効、 1〜180=N 分前から freeze、 未設定=default 30 分。
   */
  scoreboardFreezeMinutes: z.number().int().min(0).max(180).optional(),
});
export type EventSummary = z.infer<typeof EventSummarySchema>;

/**
 * `PATCH /events/:eventId/schedule` body。
 *
 * 3 種の field を組み合わせ:
 * - `startsAt: ISO8601` — operator 指定の競技開始日時 (分精度)
 * - `startNow: true` — 即座に開始 (= server now を採用)。`startsAt` とは同時指定不可
 * - `endsAt: ISO8601` — 競技終了予約時刻 (#536)。HealthCheck が `now >= endsAt` で
 *   採点 gate を閉じるので、operator は手動で「Event を終了」を押さなくてよい
 *
 * 少なくとも 1 つは指定必須。同時指定可能な組:
 *   `{ startsAt }` / `{ startNow: true }` / `{ endsAt }` / `{ startsAt, endsAt }` /
 *   `{ startNow: true, endsAt }`
 *
 * datetime は `+09:00` 等の non-Z オフセット入力も受け付けるが、**canonical UTC Z 形式
 * に transform して persist する** (Issue #497)。理由: HealthCheck の `isScoringActive`
 * は ISO 8601 の辞書順比較を時系列比較として使うが、`Z` (0x5A) と `+` (0x2B) は code point
 * 順が逆転するので、混在すると「同年月日の異 timezone」の比較が壊れる。入り口で 1 形式に揃える。
 */
export const ScheduleEventRequestSchema = z
  .object({
    startsAt: z
      .string()
      .datetime({ offset: true })
      .transform((s) => new Date(s).toISOString())
      .optional(),
    startNow: z.literal(true).optional(),
    endsAt: z
      .string()
      .datetime({ offset: true })
      .transform((s) => new Date(s).toISOString())
      .optional(),
    /**
     * [ADR-047] 自動撤去予定時刻。non-Z offset 入力も canonical UTC Z に transform して persist
     * (startsAt / endsAt と同じ理由 = 辞書順比較の安定化、Issue #497)。teardownAt >= 実効 endsAt の
     * cross-field 不変条件は handler 側 (setEventSchedule) で検証する (= 既存 / 新規 endsAt を要するため)。
     */
    teardownAt: z
      .string()
      .datetime({ offset: true })
      .transform((s) => new Date(s).toISOString())
      .optional(),
    /**
     * [ADR-047 follow-up] 自動デプロイ予定時刻。non-Z offset 入力も canonical UTC Z に transform して
     * persist (startsAt / endsAt / teardownAt と同じ理由 = 辞書順比較の安定化、Issue #497)。
     * deployAt <= 実効 endsAt の cross-field 不変条件は handler 側 (setEventSchedule) で検証する。
     */
    deployAt: z
      .string()
      .datetime({ offset: true })
      .transform((s) => new Date(s).toISOString())
      .optional(),
    /**
     * Issue #1038 P1 #9 follow-up: scoreboard freeze window 分数 (= 終了 N 分前から順位を隠す)。
     * 0 で freeze 無効化、 1〜180 分の範囲を受け付ける。 未指定なら既存値を保持。
     */
    scoreboardFreezeMinutes: z.number().int().min(0).max(180).optional(),
  })
  .refine(
    (v) =>
      v.startsAt !== undefined ||
      v.startNow === true ||
      v.endsAt !== undefined ||
      v.teardownAt !== undefined ||
      v.deployAt !== undefined ||
      v.scoreboardFreezeMinutes !== undefined,
    {
      message:
        "startsAt / startNow / endsAt / teardownAt / deployAt / scoreboardFreezeMinutes のいずれかは必須",
    },
  )
  .refine((v) => !(v.startsAt !== undefined && v.startNow === true), {
    message: "startsAt と startNow は同時指定不可",
  });

export const TeamSummarySchema = z.object({
  teamId: z.string(),
  internalSlug: z.string(),
  displayName: z.string().optional(),
  /** #528: team の deploy 先 AWS Account ID。旧 Event は undefined。 */
  awsAccountId: z.string().optional(),
  /** Admin/Operator の明示的な credential expansion でのみ返す。 */
  teamLoginKey: z.string().optional(),
});
export type TeamSummary = z.infer<typeof TeamSummarySchema>;

/**
 * EventDetail の問題セット行に紐づく deploy job の最小情報。
 * operator が「どの team のどの問題が PENDING/COMPLETE/FAILED か」を一目で
 * 確認できるようにし、jobId 経由で /deployments/:jobId に click-through できる。
 */
export const EventDeploymentSummarySchema = z.object({
  jobId: z.string(),
  teamId: z.string(),
  status: z.enum([
    "PENDING",
    "IN_PROGRESS",
    "COMPLETE",
    "FAILED",
    "DELETING",
    "DELETED",
    "EXPIRED",
    "AUTO_DELETED",
  ]),
});
export type EventDeploymentSummary = z.infer<typeof EventDeploymentSummarySchema>;

/**
 * Issue #1038 P1 #7: operator が Event 詳細画面で全 team の score event 推移を一目で
 * 把握できるよう、 EventDetail に optional な team-grouped score events を含める。
 *
 * 公開 source は 5 種 (= uptime / flag / flag-wrong / hint / gate-bonus)。 marker 用
 * `attack-detected` (= result=down) は累計 score に影響しないので除外。 leaderboard 合計と
 * chart 累積を一致させる目的で、 participant 側 chart endpoint
 * (= `/portal/leaderboard/score-events`) と同じ shape にする (gate-bonus は #2283 の
 * Gate 完了 bonus — score に加算されるので除外すると合計と chart がズレる)。
 */
export const TeamScoreEventViewSchema = z.object({
  jobId: z.string(),
  problemId: z.string(),
  source: z.enum(["uptime", "flag", "flag-wrong", "hint", "gate-bonus"]),
  points: z.number(),
  result: z.enum(["ok", "wrong"]),
  occurredAt: z.string(),
});
export type TeamScoreEventView = z.infer<typeof TeamScoreEventViewSchema>;

export const TeamScoreEventsSchema = z.object({
  teamId: z.string(),
  teamName: z.string(),
  /** occurredAt 昇順 (= chart の cumulative 計算に向く順序)。 */
  events: z.array(TeamScoreEventViewSchema),
});
export type TeamScoreEvents = z.infer<typeof TeamScoreEventsSchema>;

export const EventDetailSchema = EventSummarySchema.extend({
  problems: z.array(EventProblemTargetSchema),
  teams: z.array(TeamSummarySchema),
  /**
   * `problemId` ごとの deploy job 一覧 (= 全 team 分)。Bulk Deploy 前は空 record。
   * 旧 jobId-based deployment は eventId が無いので含まれない。
   */
  deploymentsByProblem: z.record(z.string(), z.array(EventDeploymentSummarySchema)),
  /**
   * Issue #1038 P1 #7: 全 team の累計 score event timeline。 `?withScoreEvents=true` 経由で
   * のみ含まれる (= default は undefined で従来挙動を維持、 余分な DDB query を発生させない)。
   * teams[] と同じ順序 (= teamId 昇順) で並べる。
   */
  scoreEventsByTeam: z.array(TeamScoreEventsSchema).optional(),
  /**
   * Issue #2283: Progression Gate 設定 (未設定 = Gate 無し)。 detail 経路のみ返す
   * (一覧 summary には載せない — list 画面は Gate の有無を必要としない)。
   */
  progressionGate: ProgressionGateConfigSchema.optional(),
});
export type EventDetail = z.infer<typeof EventDetailSchema>;

/**
 * `POST /events/:eventId/deploy` の opt-in body (#555 partial deploy / retry failed)。
 *
 * 全フィールド optional:
 *   - **何も指定しない** (body `{}` / 無し) → 従来通り teams × problems を全展開
 *   - `retryFailedOnly: true` → status=FAILED の deployment 行のみ抽出。旧 DDB 行を
 *     DELETE → 同 (teamId, problemId) で新 jobId で PENDING を CREATE する (= 旧 jobId は
 *     消える)。Issue #555 / 要件 FR-3 の「失敗分を再実行」 button の backend。
 *   - `forceRedeploy: true` → 既存 terminal deployment (COMPLETE / FAILED / DELETED) を
 *     DELETE → 同 (teamId, problemId) で新 jobId の PENDING を CREATE する。pre-#744 の
 *     stackOutputs を持つ COMPLETE stack を最新 template で update し直す運用復旧用。
 *   - `teamIds` / `problemIds` → 指定された team / problem だけに範囲を絞る (= 後追い参加
 *     team / 後追い投入問題のみを deploy)。`retryFailedOnly: true` / `forceRedeploy: true` と
 *     組み合わせ可能。
 *
 * idempotent semantics: 既存 deployment と (eventId, teamId, problemId) が衝突する組は
 * 全展開モードでも skipped に計上する (= 後追い deploy が二重生成しないため)。
 * `retryFailedOnly` は旧 FAILED 行を必ず DELETE してから新 PENDING を CREATE するので
 * idempotent (= 連打しても二重生成しない)。
 */
export const BulkDeployRequestSchema = z
  .object({
    retryFailedOnly: z.literal(true).optional(),
    forceRedeploy: z.literal(true).optional(),
    teamIds: z.array(z.string().min(1)).min(1).max(100).optional(),
    problemIds: z.array(z.string().min(1)).min(1).max(50).optional(),
  })
  .strict()
  .refine((v) => !(v.retryFailedOnly && v.forceRedeploy), {
    message: "retryFailedOnly and forceRedeploy are mutually exclusive",
    path: ["forceRedeploy"],
  });
export type BulkDeployRequest = z.infer<typeof BulkDeployRequestSchema>;

/**
 * Issue #888 FR-1 + PR #889 review: Red Team Disruption Fire request の Zod schema。
 *
 * `scope` ごとに必須 / 禁止 field が異なるため refine で cross-field 制約を表現する。
 * `randomCount` は integer + finite を要求 (= NaN / Infinity / 小数を reject)。
 */
export const DisruptionFireRequestSchema = z
  .object({
    disruptionId: z.string().min(1).max(64),
    problemId: z.string().min(1).max(128),
    parameters: z.record(z.unknown()).optional(),
    scope: z.enum(["all", "team", "random-n"]),
    targetTeamIds: z.array(z.string().min(1).max(128)).max(200).optional(),
    randomCount: z.number().int().finite().min(1).max(200).optional(),
    requestId: z.string().min(8).max(128),
    /**
     * [ADR-037] 発火の timing。 `immediate` (既定) は従来どおり即注入、 `scheduled` は
     * operator が `afterMinutes` 分後に注入を予約する (= executor が自分の aws-scheduler で遅延)。
     */
    timing: z.enum(["immediate", "scheduled", "recurring"]).default("immediate"),
    /** scheduled のみ必須。 1〜1440 分 (= 最長 24h)。 finite + integer で NaN / 小数を reject。 */
    afterMinutes: z.number().int().finite().min(1).max(1440).optional(),
    /** [ADR-037] recurring のみ必須。 再注入の間隔 (分)。 1〜1440。 */
    intervalMinutes: z.number().int().finite().min(1).max(1440).optional(),
    /** [ADR-037] recurring のみ必須。 最大注入回数 (= always-ends の上限)。 1〜60。 */
    maxFires: z.number().int().finite().min(1).max(60).optional(),
  })
  .strict()
  .refine((v) => v.timing !== "scheduled" || v.afterMinutes !== undefined, {
    message: "afterMinutes is required when timing is 'scheduled'",
    path: ["afterMinutes"],
  })
  .refine((v) => v.timing === "scheduled" || v.afterMinutes === undefined, {
    message: "afterMinutes is only valid when timing is 'scheduled'",
    path: ["afterMinutes"],
  })
  .refine(
    (v) =>
      v.timing !== "recurring" || (v.intervalMinutes !== undefined && v.maxFires !== undefined),
    {
      message: "intervalMinutes and maxFires are required when timing is 'recurring'",
      path: ["intervalMinutes"],
    },
  )
  .refine(
    (v) =>
      v.timing === "recurring" || (v.intervalMinutes === undefined && v.maxFires === undefined),
    {
      message: "intervalMinutes / maxFires are only valid when timing is 'recurring'",
      path: ["intervalMinutes"],
    },
  )
  .refine((v) => v.scope !== "team" || (v.targetTeamIds && v.targetTeamIds.length > 0), {
    message: "targetTeamIds is required when scope is 'team'",
    path: ["targetTeamIds"],
  })
  .refine((v) => v.scope !== "random-n" || v.randomCount !== undefined, {
    message: "randomCount is required when scope is 'random-n'",
    path: ["randomCount"],
  })
  .refine((v) => v.scope === "team" || !v.targetTeamIds || v.targetTeamIds.length === 0, {
    message: "targetTeamIds is only valid for scope='team'",
    path: ["targetTeamIds"],
  })
  .refine((v) => v.scope === "random-n" || v.randomCount === undefined, {
    message: "randomCount is only valid for scope='random-n'",
    path: ["randomCount"],
  });
export type DisruptionFireRequest = z.infer<typeof DisruptionFireRequestSchema>;
