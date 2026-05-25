import type { FetchAuthConfig } from "../http/fetch-with-auth.ts";
import { fetchWithAuth } from "../http/fetch-with-auth.ts";

/**
 * Issue #1305: Scoreboard / score-events polling client。
 * Event API: `/events/<eventId>/scoreboard` と `/events/<eventId>/score-events`。
 */

export interface ScoreboardRow {
  readonly rank?: number;
  readonly teamId: string;
  readonly teamName?: string;
  readonly score: number;
  readonly updatedAt?: string;
}

export interface ScoreEvent {
  readonly eventTime: string;
  readonly teamId: string;
  readonly problemId?: string;
  readonly delta?: number;
  readonly reason?: string;
}

export interface ScoreEventsQuery {
  readonly team?: string;
  readonly from?: string;
  readonly to?: string;
}

export class ScoreboardApi {
  constructor(
    private readonly baseUrl: string,
    private readonly authConfig: FetchAuthConfig,
  ) {}

  async scoreboard(eventId: string): Promise<ScoreboardRow[]> {
    const res = (await fetchWithAuth(
      this.baseUrl,
      `/events/${encodeURIComponent(eventId)}/scoreboard`,
      {},
      this.authConfig,
    )) as { data?: ScoreboardRow[]; rows?: ScoreboardRow[] } | ScoreboardRow[] | undefined;
    if (Array.isArray(res)) return res;
    return res?.data ?? res?.rows ?? [];
  }

  async scoreEvents(eventId: string, query: ScoreEventsQuery = {}): Promise<ScoreEvent[]> {
    const res = (await fetchWithAuth(
      this.baseUrl,
      `/events/${encodeURIComponent(eventId)}/score-events`,
      {
        query: {
          team: query.team,
          from: query.from,
          to: query.to,
        },
      },
      this.authConfig,
    )) as { data?: ScoreEvent[]; events?: ScoreEvent[] } | ScoreEvent[] | undefined;
    if (Array.isArray(res)) return res;
    return res?.data ?? res?.events ?? [];
  }
}
