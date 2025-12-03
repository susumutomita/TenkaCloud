/**
 * Profile API Client
 *
 * 参加者プロフィール API クライアント
 */

import { get, put } from "./client";
import type {
  Badge,
  ParticipantEventSummary,
  ParticipantProfile,
} from "./types";

// =============================================================================
// API Functions
// =============================================================================

/**
 * 自分のプロフィールを取得
 */
export async function getMyProfile(): Promise<ParticipantProfile | null> {
  try {
    return await get<ParticipantProfile>("/participant/profile");
  } catch (error) {
    if (error instanceof Error && error.message.includes("404")) {
      return null;
    }
    throw error;
  }
}

/**
 * プロフィールを更新
 */
export async function updateProfile(data: {
  name?: string;
  avatarUrl?: string;
}): Promise<ParticipantProfile> {
  return put<ParticipantProfile>("/participant/profile", data);
}

/**
 * 自分のバッジ一覧を取得
 */
export async function getMyBadges(): Promise<{ badges: Badge[] }> {
  return get<{ badges: Badge[] }>("/participant/profile/badges");
}

/**
 * 参加イベント履歴を取得
 */
export async function getEventHistory(options?: {
  limit?: number;
  offset?: number;
}): Promise<{ events: ParticipantEventSummary[]; total: number }> {
  const params: Record<string, string | number | boolean | undefined> = {};

  if (options?.limit !== undefined) {
    params.limit = options.limit;
  }
  if (options?.offset !== undefined) {
    params.offset = options.offset;
  }

  return get<{ events: ParticipantEventSummary[]; total: number }>(
    "/participant/profile/history",
    params,
  );
}

/**
 * グローバルランキングを取得
 */
export async function getGlobalRanking(options?: {
  limit?: number;
  offset?: number;
}): Promise<{
  rankings: Array<{
    rank: number;
    userId: string;
    name: string;
    totalScore: number;
    eventsParticipated: number;
  }>;
  total: number;
  myRank?: number;
}> {
  const params: Record<string, string | number | boolean | undefined> = {};

  if (options?.limit !== undefined) {
    params.limit = options.limit;
  }
  if (options?.offset !== undefined) {
    params.offset = options.offset;
  }

  return get("/participant/rankings", params);
}
