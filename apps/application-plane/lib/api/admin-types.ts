/**
 * Admin API Types
 *
 * 管理者向け API の型定義
 *
 * 参加者向け types.ts を拡張し、Admin 固有のフィールドを追加
 */

import type {
  EventStatus,
  ParticipantEvent,
  TeamInfo,
  TeamMember,
  ProblemType,
} from './types';

// Re-export common types for convenience
export type { EventStatus, ProblemType };

// =============================================================================
// Admin Event Types
// =============================================================================

/**
 * Admin 用イベント型
 *
 * ParticipantEvent を拡張し、管理者向けフィールドを追加
 */
export interface AdminEvent extends ParticipantEvent {
  /** イベントの最大参加者数 */
  maxParticipants: number;
  /** イベントの説明 */
  description?: string;
  /** URL スラッグ */
  slug: string;
}

/**
 * イベント作成リクエスト型
 */
export interface CreateEventRequest {
  name: string;
  slug: string;
  description?: string;
  organizer?: string;
  eventDate: string;
  startTime?: string;
  endTime?: string;
  status?: EventStatus;
  imageUrl?: string;
  maxParticipants?: number;
  type?: ProblemType;
}

/**
 * イベント更新リクエスト型
 */
export interface UpdateEventRequest extends Partial<CreateEventRequest> {
  id: string;
}

/**
 * イベントフィルター型
 */
export interface AdminEventFilters {
  status?: EventStatus;
  search?: string;
  type?: ProblemType;
}

// =============================================================================
// Admin Team Types
// =============================================================================

/**
 * Admin 用チーム型
 *
 * TeamInfo を拡張し、集計情報を追加
 */
export interface AdminTeam extends TeamInfo {
  /** 現在のメンバー数 */
  memberCount: number;
  /** 最大メンバー数 */
  maxMembers: number;
  /** 参加イベント数 */
  eventsCount: number;
  /** 累計スコア */
  totalScore: number;
  /** 作成日時 */
  createdAt: string;
}

/**
 * Admin 用チームメンバー型（TeamMember の alias）
 */
export type AdminTeamMember = TeamMember;

/**
 * チーム作成リクエスト型
 */
export interface CreateTeamRequest {
  name: string;
  eventId: string;
  captainId?: string;
  memberIds?: string[];
  maxMembers?: number;
}

/**
 * チーム更新リクエスト型
 */
export interface UpdateTeamRequest extends Partial<
  Omit<CreateTeamRequest, 'eventId'>
> {
  id: string;
}

/**
 * チームフィルター型
 */
export interface AdminTeamFilters {
  eventId?: string;
  search?: string;
}

// =============================================================================
// Admin Participant Types
// =============================================================================

/**
 * 参加者のロール
 */
export type ParticipantRole = 'participant' | 'admin';

/**
 * 参加者のステータス
 */
export type ParticipantStatus = 'active' | 'inactive' | 'banned';

/**
 * Admin 用参加者型
 *
 * 管理画面で表示する参加者情報
 */
export interface AdminParticipant {
  /** 参加者 ID */
  id: string;
  /** ユーザー ID（認証システムでの ID） */
  userId: string;
  /** 表示名 */
  displayName: string;
  /** メールアドレス */
  email: string;
  /** ロール */
  role: ParticipantRole;
  /** 所属チーム ID */
  teamId?: string;
  /** 所属チーム名 */
  teamName?: string;
  /** 参加日時 */
  joinedAt: string;
  /** ステータス */
  status: ParticipantStatus;
  /** 参加イベント数 */
  eventsCount?: number;
  /** 累計スコア */
  totalScore?: number;
}

/**
 * 参加者追加リクエスト型
 */
export interface AddParticipantRequest {
  email: string;
  name?: string;
  eventId?: string;
  teamId?: string;
  role?: ParticipantRole;
}

/**
 * 参加者更新リクエスト型
 */
export interface UpdateParticipantRequest {
  id: string;
  displayName?: string;
  role?: ParticipantRole;
  status?: ParticipantStatus;
  teamId?: string | null;
}

/**
 * 参加者フィルター型
 */
export interface AdminParticipantFilters {
  eventId?: string;
  teamId?: string;
  search?: string;
  status?: ParticipantStatus;
  role?: ParticipantRole;
}

// =============================================================================
// Admin API Response Types
// =============================================================================

/**
 * Admin リスト API の汎用レスポンス型
 *
 * @template T - リストアイテムの型
 */
export interface AdminListResponse<T> {
  /** アイテムのリスト */
  items: T[];
  /** 総件数 */
  total: number;
  /** 現在のページ番号 (1-indexed) */
  page: number;
  /** 1 ページあたりの件数 */
  limit: number;
  /** 次のページが存在するか */
  hasMore: boolean;
}

/**
 * イベント一覧レスポンス型
 *
 * @deprecated AdminListResponse<AdminEvent> を使用してください
 */
export interface AdminEventListResponse {
  events: AdminEvent[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * チーム一覧レスポンス型
 *
 * @deprecated AdminListResponse<AdminTeam> を使用してください
 */
export interface AdminTeamListResponse {
  teams: AdminTeam[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * 参加者一覧レスポンス型
 *
 * @deprecated AdminListResponse<AdminParticipant> を使用してください
 */
export interface AdminParticipantListResponse {
  participants: AdminParticipant[];
  total: number;
  page: number;
  pageSize: number;
}

// =============================================================================
// Admin Challenge Types (for future use)
// =============================================================================

/**
 * Admin 用チャレンジ型（将来の拡張用）
 */
export interface AdminChallenge {
  id: string;
  eventId: string;
  title: string;
  description: string;
  difficulty: 'easy' | 'medium' | 'hard' | 'expert';
  maxScore: number;
  order: number;
  isPublished: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * チャレンジフィルター型
 */
export interface AdminChallengeFilters {
  eventId?: string;
  difficulty?: AdminChallenge['difficulty'];
  isPublished?: boolean;
  search?: string;
}
