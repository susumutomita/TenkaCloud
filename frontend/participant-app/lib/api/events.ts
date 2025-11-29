/**
 * Events API Client
 *
 * 参加者向けイベント API クライアント
 */

import { get, post } from "./client";
import type {
  EventDetails,
  EventStatus,
  Leaderboard,
  ParticipantEvent,
  ProblemType,
} from "./types";

// =============================================================================
// API Functions
// =============================================================================

/**
 * 参加可能なイベント一覧を取得
 */
export async function getAvailableEvents(options?: {
  status?: EventStatus | EventStatus[];
  type?: ProblemType;
  limit?: number;
  offset?: number;
}): Promise<{ events: ParticipantEvent[]; total: number }> {
  const params: Record<string, string | number | boolean | undefined> = {};

  if (options?.status) {
    params.status = Array.isArray(options.status)
      ? options.status.join(",")
      : options.status;
  }
  if (options?.type) {
    params.type = options.type;
  }
  if (options?.limit !== undefined) {
    params.limit = options.limit;
  }
  if (options?.offset !== undefined) {
    params.offset = options.offset;
  }

  return get<{ events: ParticipantEvent[]; total: number }>(
    "/participant/events",
    params,
  );
}

/**
 * 参加中のイベント一覧を取得
 */
export async function getMyEvents(): Promise<{ events: ParticipantEvent[] }> {
  return get<{ events: ParticipantEvent[] }>("/participant/events/me");
}

/**
 * イベント詳細を取得
 */
export async function getEventDetails(
  eventId: string,
): Promise<EventDetails | null> {
  try {
    return await get<EventDetails>(`/participant/events/${eventId}`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("404")) {
      return null;
    }
    throw error;
  }
}

/**
 * イベントに登録
 */
export async function registerForEvent(
  eventId: string,
): Promise<{ success: boolean; message: string }> {
  return post<{ success: boolean; message: string }>(
    `/participant/events/${eventId}/register`,
  );
}

/**
 * イベント登録をキャンセル
 */
export async function unregisterFromEvent(
  eventId: string,
): Promise<{ success: boolean; message: string }> {
  return post<{ success: boolean; message: string }>(
    `/participant/events/${eventId}/unregister`,
  );
}

/**
 * リーダーボードを取得
 */
export async function getLeaderboard(
  eventId: string,
): Promise<Leaderboard | null> {
  try {
    return await get<Leaderboard>(`/participant/events/${eventId}/leaderboard`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("404")) {
      return null;
    }
    throw error;
  }
}

/**
 * 自分のランキングを取得
 */
export async function getMyRanking(eventId: string): Promise<{
  rank: number;
  totalScore: number;
  problemScores: Record<string, number>;
} | null> {
  try {
    return await get<{
      rank: number;
      totalScore: number;
      problemScores: Record<string, number>;
    }>(`/participant/events/${eventId}/my-ranking`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("404")) {
      return null;
    }
    throw error;
  }
}
