import type { FetchAuthConfig } from "../http/fetch-with-auth.ts";
import { fetchWithAuth } from "../http/fetch-with-auth.ts";

/**
 * Issue #1305: Tenant Application Plane events CRUD client。
 * Tenant Admin API: `/events`。
 */

export interface EventSummary {
  readonly eventId: string;
  readonly name?: string;
  readonly status?: string;
  readonly startAt?: string;
  readonly endAt?: string;
  readonly problemset?: string;
}

export interface CreateEventInput {
  readonly name: string;
  readonly start: string;
  readonly end: string;
  readonly problemset: string;
}

export interface EventReport {
  readonly markdown: string;
}

export class EventsApi {
  constructor(
    private readonly baseUrl: string,
    private readonly authConfig: FetchAuthConfig,
  ) {}

  async list(status?: string): Promise<EventSummary[]> {
    const res = (await fetchWithAuth(
      this.baseUrl,
      "/events",
      { query: status ? { status } : undefined },
      this.authConfig,
    )) as { data?: EventSummary[]; events?: EventSummary[] } | EventSummary[] | undefined;
    if (Array.isArray(res)) return res;
    return res?.data ?? res?.events ?? [];
  }

  async get(eventId: string): Promise<EventSummary> {
    return (await fetchWithAuth(
      this.baseUrl,
      `/events/${encodeURIComponent(eventId)}`,
      {},
      this.authConfig,
    )) as EventSummary;
  }

  async create(input: CreateEventInput): Promise<EventSummary> {
    return (await fetchWithAuth(
      this.baseUrl,
      "/events",
      { method: "POST", body: input },
      this.authConfig,
    )) as EventSummary;
  }

  async end(eventId: string): Promise<EventSummary> {
    return (await fetchWithAuth(
      this.baseUrl,
      `/events/${encodeURIComponent(eventId)}/end`,
      { method: "POST" },
      this.authConfig,
    )) as EventSummary;
  }

  async archive(eventId: string): Promise<EventSummary> {
    return (await fetchWithAuth(
      this.baseUrl,
      `/events/${encodeURIComponent(eventId)}/archive`,
      { method: "POST" },
      this.authConfig,
    )) as EventSummary;
  }

  async report(eventId: string): Promise<EventReport> {
    const res = (await fetchWithAuth(
      this.baseUrl,
      `/events/${encodeURIComponent(eventId)}/report`,
      { headers: { accept: "text/markdown, application/json" } },
      this.authConfig,
    )) as EventReport | string;
    if (typeof res === "string") return { markdown: res };
    return res;
  }
}
