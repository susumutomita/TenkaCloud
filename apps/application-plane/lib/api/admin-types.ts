/**
 * Admin API Types
 *
 * 管理者向け API の型定義
 *
 * 参加者向け types.ts を拡張し、Admin 固有のフィールドを追加
 */

import type {
  CloudProvider,
  DifficultyLevel,
  EventStatus,
  ParticipantEvent,
  ProblemCategory,
  ProblemType,
  TeamInfo,
  TeamMember,
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

// =============================================================================
// Admin Problem Types
// =============================================================================

/**
 * 問題の説明
 */
export interface ProblemDescription {
  overview: string;
  objectives: string[];
  hints: string[];
  prerequisites: string[];
  estimatedTime?: number;
}

/**
 * 問題のメタデータ
 */
export interface ProblemMetadata {
  author: string;
  version: string;
  tags: string[];
  license?: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * デプロイメントテンプレート
 */
export interface DeploymentTemplate {
  type:
    | 'cloudformation'
    | 'sam'
    | 'cdk'
    | 'terraform'
    | 'deployment-manager'
    | 'arm'
    | 'docker-compose';
  path: string;
  parameters?: Record<string, string>;
}

/**
 * 問題のデプロイメント設定
 */
export interface ProblemDeployment {
  providers: CloudProvider[];
  timeout?: number;
  templates: Record<string, DeploymentTemplate>;
  regions: Record<string, string[]>;
}

/**
 * 問題の採点基準
 */
export interface ProblemScoringCriterion {
  name: string;
  description?: string;
  weight: number;
  maxPoints: number;
}

/**
 * 問題の採点設定
 */
export interface ProblemScoring {
  type: 'lambda' | 'container' | 'api' | 'manual';
  path: string;
  timeoutMinutes: number;
  intervalMinutes?: number;
  criteria: ProblemScoringCriterion[];
}

/**
 * Admin 用問題型
 */
export interface AdminProblem {
  id: string;
  title: string;
  type: ProblemType;
  category: ProblemCategory;
  difficulty: DifficultyLevel;
  description: ProblemDescription;
  metadata: ProblemMetadata;
  deployment: ProblemDeployment;
  scoring: ProblemScoring;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * 問題作成リクエスト型
 */
export interface CreateProblemRequest {
  title: string;
  type: ProblemType;
  category: ProblemCategory;
  difficulty: DifficultyLevel;
  description: ProblemDescription;
  metadata: Omit<ProblemMetadata, 'createdAt' | 'updatedAt'>;
  deployment: ProblemDeployment;
  scoring: ProblemScoring;
}

/**
 * 問題更新リクエスト型
 */
export type UpdateProblemRequest = Partial<CreateProblemRequest>;

/**
 * 問題フィルター型
 */
export interface AdminProblemFilters {
  type?: ProblemType;
  category?: ProblemCategory;
  difficulty?: DifficultyLevel;
  search?: string;
}

/**
 * 問題一覧レスポンス型
 */
export interface AdminProblemListResponse {
  problems: AdminProblem[];
  total: number;
}

// =============================================================================
// Admin Problem Deployment Types
// =============================================================================

/**
 * デプロイリクエスト型
 */
export interface DeployProblemRequest {
  region: string;
  stackName?: string;
  parameters?: Record<string, string>;
  tags?: Record<string, string>;
  dryRun?: boolean;
  credentials?: {
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
    accountId?: string;
    roleArn?: string;
  };
}

/**
 * デプロイレスポンス型
 */
export interface DeployProblemResponse {
  message: string;
  stackName: string;
  stackId?: string;
  outputs?: Record<string, string>;
  startedAt?: string;
  completedAt?: string;
}

/**
 * デプロイステータス型
 */
export interface DeploymentStatus {
  stackName: string;
  stackId?: string;
  status: string;
  statusReason?: string;
  outputs?: Record<string, string>;
  lastUpdatedTime?: string;
}

/**
 * AWS リージョン情報
 */
export interface AWSRegion {
  code: string;
  name: string;
}
