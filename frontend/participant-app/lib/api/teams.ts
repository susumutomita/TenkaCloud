/**
 * Teams API Client
 *
 * 参加者向けチーム管理 API クライアント
 */

import { del, get, post } from './client';
import type {
  CreateTeamInput,
  JoinTeamInput,
  TeamInfo,
  TeamMember,
} from './types';

// =============================================================================
// API Functions
// =============================================================================

/**
 * 自分のチーム情報を取得
 */
export async function getMyTeam(eventId: string): Promise<TeamInfo | null> {
  try {
    return await get<TeamInfo>(`/participant/events/${eventId}/team`);
  } catch (error) {
    if (error instanceof Error && error.message.includes('404')) {
      return null;
    }
    throw error;
  }
}

/**
 * チームを作成
 */
export async function createTeam(
  eventId: string,
  input: CreateTeamInput
): Promise<TeamInfo> {
  return post<TeamInfo>(`/participant/events/${eventId}/team`, input);
}

/**
 * チームに参加（招待コードを使用）
 */
export async function joinTeam(
  eventId: string,
  input: JoinTeamInput
): Promise<TeamInfo> {
  return post<TeamInfo>(`/participant/events/${eventId}/team/join`, input);
}

/**
 * チームから離脱
 */
export async function leaveTeam(
  eventId: string
): Promise<{ success: boolean; message: string }> {
  return post<{ success: boolean; message: string }>(
    `/participant/events/${eventId}/team/leave`
  );
}

/**
 * 招待コードを再生成（キャプテンのみ）
 */
export async function regenerateInviteCode(
  eventId: string
): Promise<{ inviteCode: string }> {
  return post<{ inviteCode: string }>(
    `/participant/events/${eventId}/team/invite-code`
  );
}

/**
 * チームメンバーを削除（キャプテンのみ）
 */
export async function removeMember(
  eventId: string,
  memberId: string
): Promise<{ success: boolean; message: string }> {
  return del<{ success: boolean; message: string }>(
    `/participant/events/${eventId}/team/members/${memberId}`
  );
}

/**
 * キャプテンを移譲（キャプテンのみ）
 */
export async function transferCaptain(
  eventId: string,
  newCaptainId: string
): Promise<TeamInfo> {
  return post<TeamInfo>(
    `/participant/events/${eventId}/team/transfer-captain`,
    {
      newCaptainId,
    }
  );
}

/**
 * チームメンバー一覧を取得
 */
export async function getTeamMembers(
  eventId: string
): Promise<{ members: TeamMember[] }> {
  return get<{ members: TeamMember[] }>(
    `/participant/events/${eventId}/team/members`
  );
}

/**
 * チームを解散（キャプテンのみ）
 */
export async function disbandTeam(
  eventId: string
): Promise<{ success: boolean; message: string }> {
  return del<{ success: boolean; message: string }>(
    `/participant/events/${eventId}/team`
  );
}
