import { z } from "zod";

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
    .max(100, "1 event あたり 100 teams が DDB TransactWrite 上限"),
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
  /** 採点 lock flag (#558)。true なら加点経路全停止、read のみ可。 */
  scoringLocked: z.boolean().optional(),
  /** scoringLocked を true にした時刻 (#558)。 */
  scoringLockedAt: z.string().optional(),
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
  })
  .refine((v) => v.startsAt !== undefined || v.startNow === true || v.endsAt !== undefined, {
    message: "startsAt / startNow / endsAt のいずれかは必須",
  })
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
  status: z.enum(["PENDING", "IN_PROGRESS", "COMPLETE", "FAILED", "DELETING", "DELETED"]),
});
export type EventDeploymentSummary = z.infer<typeof EventDeploymentSummarySchema>;

export const EventDetailSchema = EventSummarySchema.extend({
  problems: z.array(EventProblemTargetSchema),
  teams: z.array(TeamSummarySchema),
  /**
   * `problemId` ごとの deploy job 一覧 (= 全 team 分)。Bulk Deploy 前は空 record。
   * 旧 jobId-based deployment は eventId が無いので含まれない。
   */
  deploymentsByProblem: z.record(z.string(), z.array(EventDeploymentSummarySchema)),
});
export type EventDetail = z.infer<typeof EventDetailSchema>;
