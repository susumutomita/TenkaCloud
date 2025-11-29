/**
 * Problem Management Service - Core Types
 *
 * 統一問題フォーマットとクラウドプロバイダー抽象化の型定義
 */

// =============================================================================
// Cloud Provider Types
// =============================================================================

export type CloudProvider = 'aws' | 'gcp' | 'azure' | 'local';

export type DeploymentTemplateType =
  | 'cloudformation'
  | 'sam'
  | 'cdk'
  | 'terraform'
  | 'deployment-manager'
  | 'arm'
  | 'docker-compose';

export interface CloudCredentials {
  provider: CloudProvider;
  accountId: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  roleArn?: string;
  region: string;
}

export interface DeploymentResult {
  success: boolean;
  stackId?: string;
  stackName?: string;
  outputs?: Record<string, string>;
  resources?: DeployedResource[];
  error?: string;
  startedAt: Date;
  completedAt?: Date;
}

export interface DeployedResource {
  logicalId: string;
  physicalId: string;
  type: string;
  status:
    | 'CREATE_COMPLETE'
    | 'CREATE_FAILED'
    | 'DELETE_COMPLETE'
    | 'DELETE_FAILED';
}

export interface StackStatus {
  stackName: string;
  stackId: string;
  status:
    | 'CREATE_IN_PROGRESS'
    | 'CREATE_COMPLETE'
    | 'CREATE_FAILED'
    | 'DELETE_IN_PROGRESS'
    | 'DELETE_COMPLETE'
    | 'DELETE_FAILED'
    | 'UPDATE_IN_PROGRESS'
    | 'UPDATE_COMPLETE'
    | 'UPDATE_FAILED'
    | 'ROLLBACK_IN_PROGRESS'
    | 'ROLLBACK_COMPLETE';
  statusReason?: string;
  outputs?: Record<string, string>;
  lastUpdatedTime?: Date;
}

// =============================================================================
// Problem Types
// =============================================================================

export type ProblemType = 'gameday' | 'jam';

export type ProblemCategory =
  | 'architecture'
  | 'security'
  | 'cost'
  | 'performance'
  | 'reliability'
  | 'operations';

export type DifficultyLevel = 'easy' | 'medium' | 'hard' | 'expert';

export interface ProblemMetadata {
  author: string;
  version: string;
  createdAt: string;
  updatedAt?: string;
  tags?: string[];
  license?: string;
}

export interface ProblemDescription {
  overview: string;
  objectives: string[];
  hints: string[];
  prerequisites?: string[];
  estimatedTime?: number; // minutes
}

export interface DeploymentTemplate {
  type: DeploymentTemplateType;
  path: string;
  parameters?: Record<string, string>;
}

export interface ProblemDeployment {
  providers: CloudProvider[];
  templates: Partial<Record<CloudProvider, DeploymentTemplate>>;
  regions: Partial<Record<CloudProvider, string[]>>;
  timeout?: number; // minutes
}

export interface ScoringCriterion {
  name: string;
  weight: number;
  maxPoints: number;
  description?: string;
  /** 検証タイプ (ec2-instance, s3-bucket, lambda-function, etc.) */
  validationType?: string;
  /** 検証設定 */
  validationConfig?: Record<string, unknown>;
}

export interface ProblemScoring {
  type: 'lambda' | 'container' | 'api' | 'manual';
  path: string;
  criteria: ScoringCriterion[];
  timeoutMinutes: number;
  intervalMinutes?: number; // for periodic scoring
}

export interface ProblemResources {
  static?: {
    path: string;
    destination: string;
  }[];
  documentation?: {
    path: string;
  }[];
}

export interface Problem {
  id: string;
  title: string;
  type: ProblemType;
  category: ProblemCategory;
  difficulty: DifficultyLevel;
  metadata: ProblemMetadata;
  description: ProblemDescription;
  deployment: ProblemDeployment;
  scoring: ProblemScoring;
  resources?: ProblemResources;
}

// =============================================================================
// Event Types
// =============================================================================

export type EventType = 'gameday' | 'jam';

export type EventStatus =
  | 'draft'
  | 'scheduled'
  | 'active'
  | 'paused'
  | 'completed'
  | 'cancelled';

export type ParticipantType = 'individual' | 'team';

export interface EventParticipantConfig {
  type: ParticipantType;
  maxCount: number;
  minTeamSize?: number;
  maxTeamSize?: number;
  registrationDeadline?: Date;
}

export interface EventProblemConfig {
  problemId: string;
  order: number;
  unlockTime?: Date; // for JAM-style progressive unlock
  pointMultiplier?: number;
}

export interface CompetitorAccount {
  id: string;
  name: string;
  provider: CloudProvider;
  accountId: string;
  region: string;
  credentials?: CloudCredentials;
  status: 'pending' | 'ready' | 'in_use' | 'cleanup' | 'error';
}

export interface EventCloudConfig {
  provider: CloudProvider;
  regions: string[];
  competitorAccounts: CompetitorAccount[];
}

export interface EventScoringConfig {
  type: 'realtime' | 'batch';
  intervalMinutes: number;
  leaderboardVisible: boolean;
  freezeLeaderboardMinutes?: number; // freeze before end
}

/**
 * Event (フラット構造 - Admin API / Prisma 互換)
 */
export interface Event {
  id: string;
  externalId?: string;
  name: string;
  type: EventType;
  status: EventStatus;
  tenantId: string;
  startTime: Date;
  endTime: Date;
  timezone: string;
  // フラット化された参加者設定
  participantType: ParticipantType;
  maxParticipants: number;
  minTeamSize?: number;
  maxTeamSize?: number;
  registrationDeadline?: Date;
  // フラット化されたクラウド設定
  cloudProvider: CloudProvider;
  regions: string[];
  // フラット化された採点設定
  scoringType: 'realtime' | 'batch';
  scoringIntervalMinutes: number;
  leaderboardVisible: boolean;
  freezeLeaderboardMinutes?: number;
  // タイムスタンプ
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
}

/**
 * EventLegacy (ネスト構造 - 後方互換性)
 */
export interface EventLegacy {
  id: string;
  name: string;
  type: EventType;
  status: EventStatus;
  tenantId: string;
  startTime: Date;
  endTime: Date;
  timezone: string;
  participants: EventParticipantConfig;
  problems: EventProblemConfig[];
  cloudConfig: EventCloudConfig;
  scoringConfig: EventScoringConfig;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
}

// =============================================================================
// Deployment Job Types
// =============================================================================

export type DeploymentJobStatus =
  | 'pending'
  | 'queued'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'rollback_in_progress'
  | 'rolled_back';

export interface DeploymentJob {
  id: string;
  eventId: string;
  problemId: string;
  competitorAccountId: string;
  provider: CloudProvider;
  region: string;
  status: DeploymentJobStatus;
  stackName?: string;
  stackId?: string;
  result?: DeploymentResult;
  retryCount: number;
  maxRetries: number;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
}

// =============================================================================
// Scoring Types
// =============================================================================

export interface ScoringResult {
  eventId: string;
  problemId: string;
  competitorAccountId: string;
  teamId?: string;
  scores: {
    criterion: string;
    score: number;
    maxScore: number;
    details?: string;
  }[];
  totalScore: number;
  maxTotalScore: number;
  percentage: number;
  scoredAt: Date;
}

export interface LeaderboardEntry {
  rank: number;
  teamId?: string;
  participantId?: string;
  name: string;
  totalScore: number;
  problemScores: Record<string, number>;
  lastScoredAt: Date;
  trend?: 'up' | 'down' | 'same';
}

export interface Leaderboard {
  eventId: string;
  entries: LeaderboardEntry[];
  updatedAt: Date;
  isFrozen: boolean;
}

// =============================================================================
// Marketplace Types
// =============================================================================

export type MarketplaceProblemStatus =
  | 'draft'
  | 'published'
  | 'deprecated'
  | 'archived';

export interface MarketplaceProblem extends Problem {
  marketplaceId: string;
  status: MarketplaceProblemStatus;
  publishedAt?: Date;
  downloadCount: number;
  rating?: number;
  reviews?: MarketplaceReview[];
}

export interface MarketplaceReview {
  id: string;
  userId: string;
  userName: string;
  rating: number;
  comment: string;
  createdAt: Date;
}

export interface MarketplaceSearchQuery {
  query?: string;
  type?: ProblemType;
  category?: ProblemCategory;
  difficulty?: DifficultyLevel;
  provider?: CloudProvider;
  tags?: string[];
  sortBy?: 'relevance' | 'rating' | 'downloads' | 'newest';
  page?: number;
  limit?: number;
}

export interface MarketplaceSearchResult {
  problems: MarketplaceProblem[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}
