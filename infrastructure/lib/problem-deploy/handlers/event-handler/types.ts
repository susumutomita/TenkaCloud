import { z } from "zod";
import {
  type ProgressionGateConfig,
  ProgressionGateConfigSchema,
} from "../shared/progression-gate.js";

/**
 * 1 競技イベント (= ADR-004 の Event aggregate) の DDB 行 shape。
 *
 *   PK     = `EVENT#<eventId>` / SK = `META`
 *   GSI1PK = `TENANT#<tenantId>` / GSI1SK = `<createdAt>` (ISO8601)
 */
export interface EventItem {
  PK: string;
  SK: "META";
  GSI1PK: string;
  GSI1SK: string;

  eventId: string;
  tenantId: string;
  name: string;
  status: EventStatus;
  problems: EventProblemTarget[];
  teamCount: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: number;
  /**
   * [Problem Packs / Issue #2464] Deterministic id of the active catalog snapshot
   * pinned when this event was created. Present only when the active catalog has
   * at least one pack-sourced problem; core-only events omit it to keep the
   * legacy row shape byte-identical.
   */
  catalogSnapshotId?: string;
  /**
   * [Problem Packs / Issue #2464] Pack-sourced provenance pinned at event creation,
   * keyed by problem id. Core problems are intentionally absent (`undefined` =
   * core); this field is omitted entirely when the active catalog has no pack rows.
   */
  packProvenance?: Record<string, { packId: string; packVersion: string; contentDigest: string }>;
  /**
   * 競技開始時刻 (ISO8601, UTC)。これより前は HealthCheckLambda が probe / 採点を skip。
   * 未設定なら採点は始まらない (= deploy 直後に勝手にスコアが加算されるのを防ぐ)。
   * 値は分精度想定 (operator UI が DatePicker + TimeInput で入力)。
   */
  startsAt?: string;
  /**
   * 競技終了時刻 (ISO8601, UTC)。これ以降は HealthCheckLambda が probe / 採点を skip。
   * operator が「Event を終了」 button を押した時点で `now()` が書かれ、status も
   * `ENDED` に遷移する。Bulk Teardown 待たずに採点を停めるための gate (Issue #494)。
   */
  endsAt?: string;
  /**
   * [ADR-047] 自動撤去予定時刻 (ISO8601, UTC)。毎分 reconciler が `now >= teardownAt` を
   * 検知すると bulk teardown を自動発火し、撤去し忘れによる課金リークを防ぐ (#1910 の主動機)。
   * 不変条件: 設定する場合 `teardownAt >= endsAt` (採点 gate を閉じてから撤去する)。
   * 未設定なら自動撤去なし (= operator が手動で「Event を終了」/ teardown する従来挙動)。
   */
  teardownAt?: string;
  /**
   * [ADR-047] reconciler が teardownAt に基づき自動 teardown を発火した時刻 (ISO8601, UTC)。
   * status 遷移 (→ TEARDOWN) が一次の冪等ガードだが、監査 + 二重発火防止の補助として記録する。
   */
  teardownFiredAt?: string;
  /**
   * [ADR-047 follow-up] 自動デプロイ予定時刻 (ISO8601, UTC)。毎分 reconciler が `now >= deployAt`
   * を検知すると、 status=DRAFT の event について bulk deploy を自動発火し、 deploy のし忘れ /
   * 開始時刻直前の手動操作を不要にする (teardownAt の鏡像)。 不変条件: 設定する場合
   * `deployAt <= endsAt` (deploy → 採点 → 終了 の時系列を保つ)。 未設定なら自動デプロイなし
   * (= operator が手動で「Deploy」を押す従来挙動)。
   */
  deployAt?: string;
  /**
   * [ADR-047 follow-up] reconciler が deployAt に基づき自動 deploy を発火した時刻 (ISO8601, UTC)。
   * status 遷移 (DRAFT → DEPLOYING) が一次の冪等ガードだが、監査 + 二重発火防止の補助として記録する
   * (teardownFiredAt の鏡像)。
   */
  deployFiredAt?: string;
  /**
   * Archive 操作で `status=ARCHIVED` に遷移した時刻 (ISO 8601, UTC)。Issue #493。
   * EventList が ARCHIVED を default view から外すときの sort key としても使える。
   */
  archivedAt?: string;
  /**
   * 採点 lock flag (#558)。`true` のとき:
   *   - HealthCheck Lambda は uptime 加点 / probe を skip
   *   - submit-flag handler は `scoring_locked` outcome を返し score 不変
   *   - leaderboard / score-events の read は許可 (= 表彰画面で最終 score を見せる)
   * status (DRAFT/.../ARCHIVED) と直交する軸として持つ (`status=READY (locked)` 等の合成)。
   * reversible — operator が表彰中に bug 発見した場合 unlock 可能。
   */
  scoringLocked?: boolean;
  /** scoringLocked を true にした時刻 (ISO 8601, UTC)。unlock 時は undefined に戻す。 */
  scoringLockedAt?: string;
  /** scoringLocked を変更した operator の Cognito sub (= audit 用)。 */
  scoringLockedBy?: string;
  /**
   * Issue #1038 P1 #9 follow-up: scoreboard freeze window 分数 (= 終了 N 分前から順位を隠す)。
   * 0 で freeze 無効化、 1〜180 が想定範囲。 未設定なら participant-handler 側 default=30 が
   * 効く ([[participant-handler/leaderboard.ts:DEFAULT_FREEZE_MINUTES]])。
   */
  scoreboardFreezeMinutes?: number;
  /**
   * Issue #2283: Progression Gate (問題アンロック / チーム別ハンデ) 設定。
   * `PUT /events/:eventId/progression-gate` で保存 / `DELETE` で除去。 未設定 = Gate 無し
   * (= 従来どおり全問題を開始可能)。 enforcement は per-tenant feature flag
   * `challengePrerequisiteGate` (既定 OFF) が ON のときだけ有効 — 設定が残っていても
   * flag OFF なら participant / scoring 側は無視するので、 進行中 Event でも flag OFF 切替で
   * 即 unlock される。 shape の正本は `../shared/progression-gate.ts`。
   */
  progressionGate?: ProgressionGateConfig;
}

export const EventStatusSchema = z.enum([
  "DRAFT",
  "DEPLOYING",
  "READY",
  "ENDED",
  "TEARDOWN",
  "ARCHIVED",
]);
export type EventStatus = z.infer<typeof EventStatusSchema>;

/**
 * Event 内の 1 問題ごとの deploy target。region は問題テンプレが特定 region 依存の場合が
 * あるため **problem 単位** で固定。AWS Account ID は #528 以降 **team 単位** に移行する
 * (= 各 team は自社 AWS account で全問題を deploy する運用モデル)。
 *
 * `defaultAwsAccountId` は migration 期間中 optional に保つ:
 *   - 新規 Event: 不要 (= team.awsAccountId を使う)
 *   - 旧 Event: 既存値を fallback として使う (bulk-deploy.ts の `team.awsAccountId ??`)
 *
 * Phase 2 で `defaultAwsAccountId` を完全削除する予定。
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
export type EventProblemTarget = z.infer<typeof EventProblemTargetSchema>;

/**
 * Team aggregate の DDB 行 shape。
 *
 *   PK     = `EVENT#<eventId>` / SK = `TEAM#<teamId>`
 *   GSI1PK = `TENANT#<tenantId>` / GSI1SK = `EVENT#<eventId>#TEAM#<teamId>`
 *   GSI2PK = `TEAMKEY#<teamLoginKey>` / GSI2SK = `META` (sparse)
 */
export interface TeamItem {
  PK: string;
  SK: string;
  GSI1PK: string;
  GSI1SK: string;
  GSI2PK?: string;
  GSI2SK?: string;

  eventId: string;
  teamId: string;
  tenantId: string;
  /** 競技者が portal `PATCH /portal/me` で設定する表示名。未設定時は internalSlug を使う。 */
  displayName?: string;
  /** operator 入力 (or 自動生成) の内部 slug。CFn StackName 由来になる、deploy 後 immutable。 */
  internalSlug: string;
  /** 短命 bearer。team scope (1 key で event 内 N 問題にアクセス可)。 */
  teamLoginKey: string;
  /** #528: team の deploy 先 AWS Account ID (12 桁数字)。Bulk Deploy で problem.defaultRegion と
   *  組み合わせて使う。旧 Event は持たない (= bulk-deploy で problem.defaultAwsAccountId に fallback)。 */
  awsAccountId?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: number;
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
      z.object({
        internalSlug: z
          .string()
          .min(1)
          .max(40)
          .regex(
            /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/,
            "internalSlug は a-z0-9- (RFC1035-ish) のみ",
          ),
        /** #528: 各 team の deploy 先 AWS Account ID。problem.defaultAwsAccountId 廃止に伴い必須化 */
        awsAccountId: z.string().regex(/^\d{12}$/, "AWS Account ID は 12 桁の数字"),
      }),
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
 * `POST /events` のレスポンス。teamLoginKey は **この経路でしか露出しない短命キー**。
 * 競技者への hand-off は本レスポンスを保存して operator が手動配布する。
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
export type ScheduleEventRequest = z.infer<typeof ScheduleEventRequestSchema>;

export const TeamSummarySchema = z.object({
  teamId: z.string(),
  internalSlug: z.string(),
  displayName: z.string().optional(),
  /** 詳細経路でのみ teamLoginKey を返す。一覧経路には含めない。 */
  teamLoginKey: z.string().optional(),
  /** #528: team の deploy 先 AWS Account ID。旧 Event は undefined。 */
  awsAccountId: z.string().optional(),
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
