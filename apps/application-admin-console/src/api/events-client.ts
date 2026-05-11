import type { ApiClient } from "./client";

export const EVENT_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export type EventStatus = "DRAFT" | "DEPLOYING" | "READY" | "ENDED" | "TEARDOWN" | "ARCHIVED";

export interface EventProblemTarget {
  problemId: string;
  defaultAwsAccountId: string;
  defaultRegion: string;
}

export interface EventSummary {
  eventId: string;
  name: string;
  status: EventStatus;
  teamCount: number;
  problemCount: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: number;
  /** 競技開始時刻 (ISO8601, UTC)。未設定なら HealthCheck は採点しない (= deploy 直後の誤加算防止)。 */
  startsAt?: string;
  /** 競技終了時刻 (ISO8601, UTC、#536)。HealthCheck は `now >= endsAt` で採点 gate 閉。
   *  「Event を終了」 button (= 即時終了) と「日時を指定して終了」 (= 予約) の両方が書き込む。 */
  endsAt?: string;
}

export interface EventListResponse {
  items: readonly EventSummary[];
  nextCursor?: string;
}

export interface TeamSummary {
  teamId: string;
  internalSlug: string;
  displayName?: string;
  /** 詳細経路 (`GET /events/{id}`) でのみ含まれる短命キー。 */
  teamLoginKey?: string;
}

export type EventDeploymentStatus =
  | "PENDING"
  | "IN_PROGRESS"
  | "COMPLETE"
  | "FAILED"
  | "DELETING"
  | "DELETED";

export interface EventDeploymentSummary {
  jobId: string;
  teamId: string;
  status: EventDeploymentStatus;
}

export interface EventDetail extends EventSummary {
  teams: readonly TeamSummary[];
  problems: readonly EventProblemTarget[];
  /**
   * `problemId` ごとの deploy job 一覧 (= 全 team 分)。Bulk Deploy 前は空 record。
   * 旧 jobId-based deployment は eventId が無いので含まれない。
   */
  deploymentsByProblem: Readonly<Record<string, readonly EventDeploymentSummary[]>>;
}

export interface CreateEventTeamInput {
  internalSlug: string;
}

export interface CreateEventRequest {
  name: string;
  teams: readonly CreateEventTeamInput[];
  problems: readonly EventProblemTarget[];
}

export interface CreateEventResponse {
  eventId: string;
  status: EventStatus;
  createdAt: string;
  expiresAt: number;
  teams: readonly {
    teamId: string;
    internalSlug: string;
    teamLoginKey: string;
  }[];
  problems: readonly EventProblemTarget[];
}

export interface BulkResult {
  eventId: string;
  enqueued: number;
  skipped: number;
}

export async function listEvents(
  api: ApiClient,
  options: { limit?: number; cursor?: string } = {},
): Promise<EventListResponse> {
  const params = new URLSearchParams();
  if (options.limit) params.set("limit", String(options.limit));
  if (options.cursor) params.set("cursor", options.cursor);
  const qs = params.toString();
  return api.get<EventListResponse>(qs ? `events?${qs}` : "events");
}

export async function getEvent(api: ApiClient, eventId: string): Promise<EventDetail> {
  return api.get<EventDetail>(`events/${encodeURIComponent(eventId)}`);
}

export async function createEvent(
  api: ApiClient,
  body: CreateEventRequest,
): Promise<CreateEventResponse> {
  return api.post<CreateEventResponse>("events", body);
}

export async function bulkDeployEvent(api: ApiClient, eventId: string): Promise<BulkResult> {
  return api.post<BulkResult>(`events/${encodeURIComponent(eventId)}/deploy`, {});
}

export async function bulkTeardownEvent(api: ApiClient, eventId: string): Promise<BulkResult> {
  return api.delJson<BulkResult>(`events/${encodeURIComponent(eventId)}`);
}

export interface SetScheduleResult {
  /** #536: backend は指定された field のみ返す。startsAt 未指定なら undefined */
  startsAt?: string;
  /** #536: endsAt も同様 */
  endsAt?: string;
  updatedDeployments: number;
}

/**
 * 競技開始/終了時刻を設定する。`{ startsAt }` で日時指定、`{ startNow: true }` で server now 採用。
 * #536: `{ endsAt }` も同 endpoint で受ける (= 終了予約)。組み合わせ可:
 *   `{ startsAt }` / `{ startNow: true }` / `{ endsAt }` / `{ startsAt, endsAt }` /
 *   `{ startNow: true, endsAt }`
 * Event + 紐づく全 deployment 行に伝播する (eventStartsAt / eventEndsAt の denormalize)。
 */
export interface SetEventScheduleBody {
  startsAt?: string;
  startNow?: true;
  endsAt?: string;
}
export async function setEventSchedule(
  api: ApiClient,
  eventId: string,
  body: SetEventScheduleBody,
): Promise<SetScheduleResult> {
  return api.patch<SetScheduleResult>(`events/${encodeURIComponent(eventId)}/schedule`, body);
}

export interface EndEventResult {
  endsAt: string;
  updatedDeployments: number;
}

/**
 * Event を ENDED 状態に遷移させ、紐づく全 deployment 行に \`eventEndsAt\` を伝播する。
 * READY 状態の event のみ受理 (= 二重操作 / 未開始 event の終了は 409)。
 */
export async function endEvent(api: ApiClient, eventId: string): Promise<EndEventResult> {
  return api.post<EndEventResult>(`events/${encodeURIComponent(eventId)}/end`, {});
}

export interface ArchiveEventResult {
  archivedAt: string;
}

/**
 * Event を ARCHIVED 状態にして EventList のデフォルト view から外す soft delete (Issue #493)。
 * 許可: DRAFT (一度も deploy していない) / ENDED (採点停止済) / TEARDOWN (一括削除済)。
 * 拒否: DEPLOYING / READY / ARCHIVED は 409 で拒否される。
 */
export async function archiveEvent(api: ApiClient, eventId: string): Promise<ArchiveEventResult> {
  return api.post<ArchiveEventResult>(`events/${encodeURIComponent(eventId)}/archive`, {});
}

/**
 * ADR-006 Notifications: 運営 → 競技者 通知を 1 件発信する。tenant 不一致 / event 不在は 404。
 * `severity` 既定 `info`。`title` 1〜120、`body` 1〜2000 chars。
 */
export interface CreateNotificationRequest {
  title: string;
  body: string;
  severity?: "info" | "warning";
}

export interface CreateNotificationResponse {
  notificationId: string;
  occurredAt: string;
}

export async function createNotification(
  api: ApiClient,
  eventId: string,
  body: CreateNotificationRequest,
): Promise<CreateNotificationResponse> {
  return api.post<CreateNotificationResponse>(
    `events/${encodeURIComponent(eventId)}/notifications`,
    body,
  );
}
