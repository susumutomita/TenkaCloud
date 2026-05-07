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
}

export const EventStatusSchema = z.enum(["DRAFT", "DEPLOYING", "READY", "TEARDOWN", "ARCHIVED"]);
export type EventStatus = z.infer<typeof EventStatusSchema>;

/**
 * Event 内の 1 問題ごとの **デフォルト deploy target**。Bulk Deploy 時に各 team に対して
 * この account / region で deploy する。team ごとに override したい場合は将来拡張。
 */
export const EventProblemTargetSchema = z.object({
  problemId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/),
  defaultAwsAccountId: z.string().regex(/^\d{12}$/, "AWS Account ID は 12 桁の数字"),
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
});
export type EventSummary = z.infer<typeof EventSummarySchema>;

export const TeamSummarySchema = z.object({
  teamId: z.string(),
  internalSlug: z.string(),
  displayName: z.string().optional(),
  /** 詳細経路でのみ teamLoginKey を返す。一覧経路には含めない。 */
  teamLoginKey: z.string().optional(),
});
export type TeamSummary = z.infer<typeof TeamSummarySchema>;

export const EventDetailSchema = EventSummarySchema.extend({
  problems: z.array(EventProblemTargetSchema),
  teams: z.array(TeamSummarySchema),
});
export type EventDetail = z.infer<typeof EventDetailSchema>;
