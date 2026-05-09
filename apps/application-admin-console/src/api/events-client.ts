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

export interface EventDetail extends EventSummary {
  teams: readonly TeamSummary[];
  problems: readonly EventProblemTarget[];
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
  startsAt: string;
  updatedDeployments: number;
}

/**
 * 競技開始時刻を設定する。`{ startsAt }` で日時指定、`{ startNow: true }` で server now 採用。
 * Event + 紐づく全 deployment 行に伝播する (eventStartsAt の denormalize)。
 */
export async function setEventSchedule(
  api: ApiClient,
  eventId: string,
  body: { startsAt: string } | { startNow: true },
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
