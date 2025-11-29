/**
 * Events API Client
 *
 * イベント管理 API クライアント
 */

import { del, get, patch, post, put } from './client';
import type { CloudProvider, ProblemType } from './problems';

// =============================================================================
// Types
// =============================================================================

export type EventStatus =
  | 'draft'
  | 'scheduled'
  | 'active'
  | 'paused'
  | 'completed'
  | 'cancelled';
export const EVENT_STATUSES: readonly EventStatus[] = [
  'draft',
  'scheduled',
  'active',
  'paused',
  'completed',
  'cancelled',
] as const;

export type ParticipantType = 'individual' | 'team';
export type ScoringType = 'realtime' | 'batch';

export interface Event {
  id: string;
  name: string;
  type: ProblemType;
  status: EventStatus;
  tenantId: string;
  startTime: string;
  endTime: string;
  timezone: string;
  participantType: ParticipantType;
  maxParticipants: number;
  minTeamSize?: number;
  maxTeamSize?: number;
  cloudProvider: CloudProvider;
  regions: string[];
  scoringType: ScoringType;
  scoringIntervalMinutes: number;
  leaderboardVisible: boolean;
  freezeLeaderboardMinutes?: number;
  problemCount: number;
  participantCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface EventProblem {
  problemId: string;
  problemTitle: string;
  order: number;
  unlockTime?: string;
  pointMultiplier: number;
}

export interface EventDetails extends Event {
  problems: EventProblem[];
}

export interface CreateEventInput {
  name: string;
  type: ProblemType;
  startTime: string;
  endTime: string;
  timezone: string;
  participantType: ParticipantType;
  maxParticipants: number;
  minTeamSize?: number;
  maxTeamSize?: number;
  cloudProvider: CloudProvider;
  regions: string[];
  scoringType: ScoringType;
  scoringIntervalMinutes: number;
  leaderboardVisible: boolean;
  freezeLeaderboardMinutes?: number;
  problemIds: string[];
}

export interface UpdateEventInput {
  name?: string;
  startTime?: string;
  endTime?: string;
  timezone?: string;
  maxParticipants?: number;
  minTeamSize?: number;
  maxTeamSize?: number;
  regions?: string[];
  scoringIntervalMinutes?: number;
  leaderboardVisible?: boolean;
  freezeLeaderboardMinutes?: number;
}

export interface LeaderboardEntry {
  rank: number;
  teamId?: string;
  participantId?: string;
  name: string;
  totalScore: number;
  problemScores: Record<string, number>;
  lastScoredAt?: string;
  trend?: 'up' | 'down' | 'same';
}

export interface Leaderboard {
  eventId: string;
  entries: LeaderboardEntry[];
  isFrozen: boolean;
  updatedAt: string;
}

// =============================================================================
// API Functions
// =============================================================================

/**
 * イベント一覧を取得
 */
export async function getEvents(options?: {
  status?: EventStatus | EventStatus[];
  type?: ProblemType;
  limit?: number;
  offset?: number;
}): Promise<{ events: Event[]; total: number }> {
  const params: Record<string, string | number | boolean | undefined> = {};

  if (options?.status) {
    params.status = Array.isArray(options.status)
      ? options.status.join(',')
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

  return get<{ events: Event[]; total: number }>('/admin/events', params);
}

/**
 * イベント詳細を取得
 */
export async function getEventDetails(
  eventId: string
): Promise<EventDetails | null> {
  try {
    return await get<EventDetails>(`/admin/events/${eventId}`);
  } catch (error) {
    if (error instanceof Error && error.message.includes('404')) {
      return null;
    }
    throw error;
  }
}

/**
 * イベントを作成
 */
export async function createEvent(input: CreateEventInput): Promise<Event> {
  return post<Event>('/admin/events', input);
}

/**
 * イベントを更新
 */
export async function updateEvent(
  eventId: string,
  input: UpdateEventInput
): Promise<Event> {
  return put<Event>(`/admin/events/${eventId}`, input);
}

/**
 * イベントを削除
 */
export async function deleteEvent(eventId: string): Promise<void> {
  await del<void>(`/admin/events/${eventId}`);
}

/**
 * イベントステータスを更新
 */
export async function updateEventStatus(
  eventId: string,
  status: EventStatus
): Promise<void> {
  await patch<void>(`/admin/events/${eventId}/status`, { status });
}

/**
 * イベントに問題を追加
 */
export async function addProblemToEvent(
  eventId: string,
  problemId: string,
  options?: { order?: number; pointMultiplier?: number }
): Promise<void> {
  await post<void>(`/admin/events/${eventId}/problems`, {
    problemId,
    ...options,
  });
}

/**
 * イベントから問題を削除
 */
export async function removeProblemFromEvent(
  eventId: string,
  problemId: string
): Promise<void> {
  await del<void>(`/admin/events/${eventId}/problems/${problemId}`);
}

/**
 * リーダーボードを取得
 */
export async function getLeaderboard(
  eventId: string
): Promise<Leaderboard | null> {
  try {
    return await get<Leaderboard>(`/admin/events/${eventId}/leaderboard`);
  } catch (error) {
    if (error instanceof Error && error.message.includes('404')) {
      return null;
    }
    throw error;
  }
}

/**
 * イベントをデプロイ（問題環境をセットアップ）
 */
export async function deployEvent(eventId: string): Promise<{ jobId: string }> {
  return post<{ jobId: string }>(`/admin/events/${eventId}/deploy`);
}

/**
 * デプロイ進捗を取得
 */
export async function getDeploymentProgress(jobId: string): Promise<{
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress: number;
  message: string;
  completedTasks: number;
  totalTasks: number;
}> {
  return get<{
    status: 'pending' | 'running' | 'completed' | 'failed';
    progress: number;
    message: string;
    completedTasks: number;
    totalTasks: number;
  }>(`/admin/deployments/${jobId}`);
}
