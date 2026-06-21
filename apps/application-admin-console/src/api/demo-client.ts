import { StatusCodes } from "http-status-codes";
import { type ApiClient, ApiError } from "./client";
import type { EventListResponse, EventSummary } from "./events-client";

/**
 * Issue #1954 — no-AWS demo mode (slice 1).
 *
 * `createApiClient` と同じ {@link ApiClient} interface を満たす **フロント完結のモック**。
 * 実 AWS / backend / Cognito を一切呼ばず、 path + method で fixture を返す。 `useApiClient`
 * が `config.mode === "demo"` のときこれを差し込む (= 公開 demo URL で AWS なし・課金なしで
 * 運営フローを体験させる)。
 *
 * slice 1 は運営フローの入口 = EventList を read-only で提供する。 未対応の経路は
 * `NOT_IMPLEMENTED` の {@link ApiError} を投げる (= 実 endpoint を叩かない / 黙って空を返さない)。
 * 後続 slice で event 作成・チーム登録・疑似デプロイ進捗・スコアボードを足す。
 */

/** 運営画面が "それっぽく" 見える固定 event 一覧 (時刻は決定的: テストを安定させる)。 */
const DEMO_EVENTS: readonly EventSummary[] = [
  {
    eventId: "demo-event-ready",
    name: "Demo Cloud Cup — Spring",
    status: "READY",
    teamCount: 3,
    problemCount: 2,
    createdAt: "2026-05-20T09:00:00.000Z",
    updatedAt: "2026-05-20T10:00:00.000Z",
    expiresAt: 1779000000,
    startsAt: "2026-05-22T01:00:00.000Z",
    endsAt: "2026-05-22T04:00:00.000Z",
  },
  {
    eventId: "demo-event-deploying",
    name: "Demo Onboarding Day",
    status: "DEPLOYING",
    teamCount: 5,
    problemCount: 1,
    createdAt: "2026-05-21T09:00:00.000Z",
    updatedAt: "2026-05-21T09:30:00.000Z",
    expiresAt: 1779100000,
  },
  {
    eventId: "demo-event-ended",
    name: "Demo Annual Arena 2026",
    status: "ENDED",
    teamCount: 8,
    problemCount: 4,
    createdAt: "2026-04-01T09:00:00.000Z",
    updatedAt: "2026-04-01T13:00:00.000Z",
    expiresAt: 1775000000,
    scoringLocked: true,
    scoringLockedAt: "2026-04-01T13:00:00.000Z",
  },
];

/** leading slash と query string を落とした route key (例 `events?limit=50` → `events`)。 */
export function demoRouteKey(path: string): string {
  return path.replace(/^\//, "").split("?")[0];
}

export function createDemoApiClient(): ApiClient {
  const unsupported = (method: string, path: string): never => {
    throw new ApiError(
      StatusCodes.NOT_IMPLEMENTED,
      `Demo mode does not simulate "${method} ${demoRouteKey(path)}" yet — no real AWS is called.`,
    );
  };

  return {
    async get<T>(path: string): Promise<T> {
      if (demoRouteKey(path) === "events") {
        const body: EventListResponse = { items: DEMO_EVENTS };
        return body as unknown as T;
      }
      return unsupported("GET", path);
    },
    async post<T>(path: string): Promise<T> {
      return unsupported("POST", path);
    },
    async put<T>(path: string): Promise<T> {
      return unsupported("PUT", path);
    },
    async patch<T>(path: string): Promise<T> {
      return unsupported("PATCH", path);
    },
    async del(path: string): Promise<void> {
      unsupported("DELETE", path);
    },
    async delJson<T>(path: string): Promise<T> {
      return unsupported("DELETE", path);
    },
  };
}
