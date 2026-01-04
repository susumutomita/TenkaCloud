/**
 * TenkaCloud DynamoDB Single Table Design Types
 *
 * PK/SK Pattern:
 * - TENANT#<id> | METADATA           -> Tenant info
 * - TENANT#<id> | USER#<id>          -> Tenant-User membership
 * - USER#<id>   | METADATA           -> User info
 * - EVENT#<id>  | METADATA           -> Event info
 * - EVENT#<id>  | PROBLEM#<id>       -> Event-Problem mapping
 * - EVENT#<id>  | TEAM#<id>          -> Team info
 * - EVENT#<id>  | SCORE#<team>#<prob>-> Score record
 */

// Entity Types
export const EntityType = {
  TENANT: 'TENANT',
  USER: 'USER',
  EVENT: 'EVENT',
  EVENT_PROBLEM: 'EVENT_PROBLEM',
  PROBLEM: 'PROBLEM',
  PROBLEM_TEMPLATE: 'PROBLEM_TEMPLATE',
  TEAM: 'TEAM',
  SCORE: 'SCORE',
  BATTLE: 'BATTLE',
  BATTLE_PARTICIPANT: 'BATTLE_PARTICIPANT',
  BATTLE_TEAM: 'BATTLE_TEAM',
  BATTLE_HISTORY: 'BATTLE_HISTORY',
  SCORING_SESSION: 'SCORING_SESSION',
  EVALUATION_CRITERIA: 'EVALUATION_CRITERIA',
  DEPLOYMENT: 'DEPLOYMENT',
  DEPLOYMENT_HISTORY: 'DEPLOYMENT_HISTORY',
  AUDIT_LOG: 'AUDIT_LOG',
  SYSTEM_SETTING: 'SYSTEM_SETTING',
  SERVICE_HEALTH: 'SERVICE_HEALTH',
} as const;

export type EntityType = (typeof EntityType)[keyof typeof EntityType];

// Tenant Status
export const TenantStatus = {
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  ARCHIVED: 'ARCHIVED',
} as const;

export type TenantStatus = (typeof TenantStatus)[keyof typeof TenantStatus];

// Tenant Tier
export const TenantTier = {
  FREE: 'FREE',
  PRO: 'PRO',
  ENTERPRISE: 'ENTERPRISE',
} as const;

export type TenantTier = (typeof TenantTier)[keyof typeof TenantTier];

// Isolation Model
export const IsolationModel = {
  POOL: 'POOL',
  SILO: 'SILO',
} as const;

export type IsolationModel =
  (typeof IsolationModel)[keyof typeof IsolationModel];

// Compute Type
export const ComputeType = {
  SERVERLESS: 'SERVERLESS',
  KUBERNETES: 'KUBERNETES',
} as const;

export type ComputeType = (typeof ComputeType)[keyof typeof ComputeType];

// Provisioning Status
export const ProvisioningStatus = {
  PENDING: 'PENDING',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const;

export type ProvisioningStatus =
  (typeof ProvisioningStatus)[keyof typeof ProvisioningStatus];

// User Role
export const UserRole = {
  TENANT_ADMIN: 'TENANT_ADMIN',
  PARTICIPANT: 'PARTICIPANT',
} as const;

export type UserRole = (typeof UserRole)[keyof typeof UserRole];

// User Status
export const UserStatus = {
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
  PENDING: 'PENDING',
} as const;

export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

// Base DynamoDB Item
export interface DynamoDBItem {
  PK: string;
  SK: string;
  GSI1PK?: string;
  GSI1SK?: string;
  EntityType: EntityType;
  CreatedAt: string;
  UpdatedAt: string;
  TTL?: number;
}

// Tenant Entity
export interface TenantItem extends DynamoDBItem {
  EntityType: 'TENANT';
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  tier: TenantTier;
  adminEmail: string;
  adminName?: string;
  region: string;
  isolationModel: IsolationModel;
  computeType: ComputeType;
  provisioningStatus: ProvisioningStatus;
  auth0OrgId?: string;
}

// User Entity
export interface UserItem extends DynamoDBItem {
  EntityType: 'USER';
  id: string;
  tenantId: string;
  email: string;
  name: string;
  role: UserRole;
  status: UserStatus;
  auth0Id?: string;
}

// Tenant-User Membership (for querying users in a tenant)
export interface TenantUserItem extends DynamoDBItem {
  EntityType: 'USER';
  tenantId: string;
  userId: string;
  email: string;
  name: string;
  role: UserRole;
  status: UserStatus;
}

// Domain types (without DynamoDB keys)
export interface Tenant {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  tier: TenantTier;
  adminEmail: string;
  adminName?: string;
  region: string;
  isolationModel: IsolationModel;
  computeType: ComputeType;
  provisioningStatus: ProvisioningStatus;
  auth0OrgId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface User {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  role: UserRole;
  status: UserStatus;
  auth0Id?: string;
  createdAt: Date;
  updatedAt: Date;
}

// Input types for creating entities
export interface CreateTenantInput {
  name: string;
  slug: string;
  tier?: TenantTier;
  adminEmail: string;
  adminName?: string;
  region?: string;
  isolationModel?: IsolationModel;
  computeType?: ComputeType;
}

export interface CreateUserInput {
  tenantId: string;
  email: string;
  name: string;
  role?: UserRole;
}

export interface UpdateTenantInput {
  name?: string;
  status?: TenantStatus;
  tier?: TenantTier;
  isolationModel?: IsolationModel;
  provisioningStatus?: ProvisioningStatus;
  auth0OrgId?: string;
}

export interface UpdateUserInput {
  name?: string;
  role?: UserRole;
  status?: UserStatus;
  auth0Id?: string;
}

// =============================================================================
// Battle Service Types
// =============================================================================

// Battle Status
export const BattleStatus = {
  WAITING: 'WAITING',
  IN_PROGRESS: 'IN_PROGRESS',
  FINISHED: 'FINISHED',
  CANCELLED: 'CANCELLED',
} as const;

export type BattleStatus = (typeof BattleStatus)[keyof typeof BattleStatus];

// Battle Mode
export const BattleMode = {
  INDIVIDUAL: 'INDIVIDUAL',
  TEAM: 'TEAM',
} as const;

export type BattleMode = (typeof BattleMode)[keyof typeof BattleMode];

// Battle Entity Item
export interface BattleItem extends DynamoDBItem {
  EntityType: 'BATTLE';
  id: string;
  tenantId: string;
  title: string;
  description?: string;
  mode: BattleMode;
  status: BattleStatus;
  maxParticipants: number;
  timeLimit: number;
  startedAt?: string;
  endedAt?: string;
}

// Battle Participant Item
export interface BattleParticipantItem extends DynamoDBItem {
  EntityType: 'BATTLE_PARTICIPANT';
  id: string;
  battleId: string;
  userId: string;
  teamId?: string;
  score: number;
  rank?: number;
  joinedAt: string;
  leftAt?: string;
}

// Battle Team Item
export interface BattleTeamItem extends DynamoDBItem {
  EntityType: 'BATTLE_TEAM';
  id: string;
  battleId: string;
  name: string;
  score: number;
}

// Battle History Item
export interface BattleHistoryItem extends DynamoDBItem {
  EntityType: 'BATTLE_HISTORY';
  id: string;
  battleId: string;
  eventType: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

// Battle Domain Types
export interface Battle {
  id: string;
  tenantId: string;
  title: string;
  description?: string;
  mode: BattleMode;
  status: BattleStatus;
  maxParticipants: number;
  timeLimit: number;
  startedAt?: Date;
  endedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface BattleParticipant {
  id: string;
  battleId: string;
  userId: string;
  teamId?: string;
  score: number;
  rank?: number;
  joinedAt: Date;
  leftAt?: Date;
}

export interface BattleTeam {
  id: string;
  battleId: string;
  name: string;
  score: number;
  createdAt: Date;
}

export interface BattleHistory {
  id: string;
  battleId: string;
  eventType: string;
  payload: Record<string, unknown>;
  timestamp: Date;
}

// Battle Input Types
export interface CreateBattleInput {
  tenantId: string;
  title: string;
  description?: string;
  mode: BattleMode;
  maxParticipants?: number;
  timeLimit?: number;
}

export interface UpdateBattleInput {
  title?: string;
  description?: string;
  maxParticipants?: number;
  timeLimit?: number;
  status?: BattleStatus;
  startedAt?: Date;
  endedAt?: Date;
}

// =============================================================================
// Scoring Service Types
// =============================================================================

// Evaluation Category
export const EvaluationCategory = {
  INFRASTRUCTURE: 'INFRASTRUCTURE',
  COST: 'COST',
  SECURITY: 'SECURITY',
  PERFORMANCE: 'PERFORMANCE',
  RELIABILITY: 'RELIABILITY',
} as const;

export type EvaluationCategory =
  (typeof EvaluationCategory)[keyof typeof EvaluationCategory];

// Severity
export const Severity = {
  CRITICAL: 'CRITICAL',
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
  INFO: 'INFO',
} as const;

export type Severity = (typeof Severity)[keyof typeof Severity];

// Evaluation Status
export const EvaluationStatus = {
  PENDING: 'PENDING',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const;

export type EvaluationStatus =
  (typeof EvaluationStatus)[keyof typeof EvaluationStatus];

// Terraform Snapshot (stored as JSON in ScoringSession)
export interface TerraformSnapshot {
  stateVersion: number;
  resourceCount: number;
  stateData: unknown;
}

// Evaluation Item Result (stored as JSON in ScoringSession)
export interface EvaluationItemResult {
  criteriaId: string;
  score: number;
  maxScore: number;
  passed: boolean;
  actualValue?: string;
  expectedValue?: string;
  details?: Record<string, unknown>;
}

// Feedback (stored as JSON in ScoringSession)
export interface ScoringFeedback {
  category: EvaluationCategory;
  severity: Severity;
  title: string;
  message: string;
  suggestion?: string;
  resourceRef?: string;
}

// Criteria Detail (stored as JSON in EvaluationCriteria)
export interface CriteriaDetail {
  ruleKey: string;
  ruleValue: string;
  points: number;
  severity: Severity;
  description?: string;
}

// Scoring Session Item
export interface ScoringSessionItem extends DynamoDBItem {
  EntityType: 'SCORING_SESSION';
  id: string;
  tenantId: string;
  battleId?: string;
  participantId: string;
  status: EvaluationStatus;
  totalScore: number;
  maxPossibleScore: number;
  submittedAt?: string;
  evaluatedAt?: string;
  terraformSnapshot?: TerraformSnapshot;
  evaluationItems?: EvaluationItemResult[];
  feedbacks?: ScoringFeedback[];
}

// Evaluation Criteria Item
export interface EvaluationCriteriaItem extends DynamoDBItem {
  EntityType: 'EVALUATION_CRITERIA';
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  category: EvaluationCategory;
  weight: number;
  maxScore: number;
  isActive: boolean;
  criteriaDetails?: CriteriaDetail[];
}

// Scoring Domain Types
export interface ScoringSession {
  id: string;
  tenantId: string;
  battleId?: string;
  participantId: string;
  status: EvaluationStatus;
  totalScore: number;
  maxPossibleScore: number;
  submittedAt?: Date;
  evaluatedAt?: Date;
  terraformSnapshot?: TerraformSnapshot;
  evaluationItems?: EvaluationItemResult[];
  feedbacks?: ScoringFeedback[];
  createdAt: Date;
  updatedAt: Date;
}

export interface EvaluationCriteria {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  category: EvaluationCategory;
  weight: number;
  maxScore: number;
  isActive: boolean;
  criteriaDetails?: CriteriaDetail[];
  createdAt: Date;
  updatedAt: Date;
}

// Scoring Input Types
export interface CreateScoringSessionInput {
  tenantId: string;
  battleId?: string;
  participantId: string;
}

export interface CreateEvaluationCriteriaInput {
  tenantId: string;
  name: string;
  description?: string;
  category: EvaluationCategory;
  weight?: number;
  maxScore?: number;
  criteriaDetails?: CriteriaDetail[];
}

export interface UpdateScoringSessionInput {
  status?: EvaluationStatus;
  totalScore?: number;
  maxPossibleScore?: number;
  submittedAt?: Date;
  evaluatedAt?: Date;
  terraformSnapshot?: TerraformSnapshot;
  evaluationItems?: EvaluationItemResult[];
  feedbacks?: ScoringFeedback[];
}

export interface UpdateEvaluationCriteriaInput {
  name?: string;
  description?: string;
  category?: EvaluationCategory;
  weight?: number;
  maxScore?: number;
  isActive?: boolean;
  criteriaDetails?: CriteriaDetail[];
}

// =============================================================================
// Deployment Management Types
// =============================================================================

// Deployment Status
export const DeploymentStatus = {
  PENDING: 'PENDING',
  IN_PROGRESS: 'IN_PROGRESS',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  ROLLED_BACK: 'ROLLED_BACK',
} as const;

export type DeploymentStatus =
  (typeof DeploymentStatus)[keyof typeof DeploymentStatus];

// Deployment Type
export const DeploymentType = {
  CREATE: 'CREATE',
  UPDATE: 'UPDATE',
  ROLLBACK: 'ROLLBACK',
} as const;

export type DeploymentType =
  (typeof DeploymentType)[keyof typeof DeploymentType];

// Deployment Item
export interface DeploymentItem extends DynamoDBItem {
  EntityType: 'DEPLOYMENT';
  id: string;
  tenantId: string;
  tenantSlug: string;
  namespace: string;
  serviceName: string;
  image: string;
  version: string;
  replicas: number;
  status: DeploymentStatus;
  type: DeploymentType;
  previousImage?: string;
  errorMessage?: string;
  startedAt?: string;
  completedAt?: string;
}

// Deployment Domain Types
export interface Deployment {
  id: string;
  tenantId: string;
  tenantSlug: string;
  namespace: string;
  serviceName: string;
  image: string;
  version: string;
  replicas: number;
  status: DeploymentStatus;
  type: DeploymentType;
  previousImage?: string;
  errorMessage?: string;
  startedAt?: Date;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

// Deployment Input Types
export interface CreateDeploymentInput {
  tenantId: string;
  tenantSlug: string;
  namespace: string;
  serviceName: string;
  image: string;
  version: string;
  replicas?: number;
  type?: DeploymentType;
}

export interface UpdateDeploymentInput {
  status?: DeploymentStatus;
  errorMessage?: string;
  startedAt?: Date;
  completedAt?: Date;
}

// Deployment History Item
export interface DeploymentHistoryItem extends DynamoDBItem {
  EntityType: 'DEPLOYMENT_HISTORY';
  id: string;
  deploymentId: string;
  status: DeploymentStatus;
  message?: string;
}

// Deployment History Domain Type
export interface DeploymentHistory {
  id: string;
  deploymentId: string;
  status: DeploymentStatus;
  message?: string;
  createdAt: Date;
}

// Deployment History Input Type
export interface CreateDeploymentHistoryInput {
  deploymentId: string;
  status: DeploymentStatus;
  message?: string;
}

// =============================================================================
// System Management Types
// =============================================================================

// Audit Action
export const AuditAction = {
  CREATE: 'CREATE',
  UPDATE: 'UPDATE',
  DELETE: 'DELETE',
  LOGIN: 'LOGIN',
  LOGOUT: 'LOGOUT',
  ACCESS: 'ACCESS',
} as const;

export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

// Audit Resource Type
export const AuditResourceType = {
  USER: 'USER',
  TENANT: 'TENANT',
  BATTLE: 'BATTLE',
  PROBLEM: 'PROBLEM',
  SETTING: 'SETTING',
  SYSTEM: 'SYSTEM',
} as const;

export type AuditResourceType =
  (typeof AuditResourceType)[keyof typeof AuditResourceType];

// Audit Log Item
export interface AuditLogItem extends DynamoDBItem {
  EntityType: 'AUDIT_LOG';
  id: string;
  tenantId?: string;
  userId?: string;
  action: AuditAction;
  resourceType: AuditResourceType;
  resourceId?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

// System Setting Item
export interface SystemSettingItem extends DynamoDBItem {
  EntityType: 'SYSTEM_SETTING';
  key: string;
  value: unknown;
  category: string;
  updatedBy?: string;
}

// Service Health Item
export interface ServiceHealthItem extends DynamoDBItem {
  EntityType: 'SERVICE_HEALTH';
  id: string;
  serviceName: string;
  status: string;
  lastCheck: string;
  details?: Record<string, unknown>;
}

// System Domain Types
export interface AuditLog {
  id: string;
  tenantId?: string;
  userId?: string;
  action: AuditAction;
  resourceType: AuditResourceType;
  resourceId?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  createdAt: Date;
}

export interface SystemSetting {
  key: string;
  value: unknown;
  category: string;
  updatedBy?: string;
  updatedAt: Date;
}

export interface ServiceHealth {
  id: string;
  serviceName: string;
  status: string;
  lastCheck: Date;
  details?: Record<string, unknown>;
}

// System Input Types
export interface CreateAuditLogInput {
  tenantId?: string;
  userId?: string;
  action: AuditAction;
  resourceType: AuditResourceType;
  resourceId?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

export interface SetSystemSettingInput {
  key: string;
  value: unknown;
  category: string;
  updatedBy?: string;
}

export interface UpdateServiceHealthInput {
  serviceName: string;
  status: string;
  details?: Record<string, unknown>;
}

// =============================================================================
// Problem Service Types
// =============================================================================

// Problem Type
export const ProblemType = {
  GAMEDAY: 'GAMEDAY',
  JAM: 'JAM',
} as const;

export type ProblemType = (typeof ProblemType)[keyof typeof ProblemType];

// Problem Category
export const ProblemCategory = {
  ARCHITECTURE: 'ARCHITECTURE',
  SECURITY: 'SECURITY',
  COST: 'COST',
  PERFORMANCE: 'PERFORMANCE',
  RELIABILITY: 'RELIABILITY',
  OPERATIONS: 'OPERATIONS',
} as const;

export type ProblemCategory =
  (typeof ProblemCategory)[keyof typeof ProblemCategory];

// Difficulty Level
export const DifficultyLevel = {
  EASY: 'EASY',
  MEDIUM: 'MEDIUM',
  HARD: 'HARD',
  EXPERT: 'EXPERT',
} as const;

export type DifficultyLevel =
  (typeof DifficultyLevel)[keyof typeof DifficultyLevel];

// Cloud Provider
export const CloudProvider = {
  AWS: 'AWS',
  GCP: 'GCP',
  AZURE: 'AZURE',
  LOCAL: 'LOCAL',
} as const;

export type CloudProvider = (typeof CloudProvider)[keyof typeof CloudProvider];

// Problem Template Status
export const ProblemTemplateStatus = {
  DRAFT: 'DRAFT',
  PUBLISHED: 'PUBLISHED',
  ARCHIVED: 'ARCHIVED',
} as const;

export type ProblemTemplateStatus =
  (typeof ProblemTemplateStatus)[keyof typeof ProblemTemplateStatus];

// Template Type
export const TemplateType = {
  CLOUDFORMATION: 'CLOUDFORMATION',
  SAM: 'SAM',
  CDK: 'CDK',
  TERRAFORM: 'TERRAFORM',
  DEPLOYMENT_MANAGER: 'DEPLOYMENT_MANAGER',
  ARM: 'ARM',
  DOCKER_COMPOSE: 'DOCKER_COMPOSE',
} as const;

export type TemplateType = (typeof TemplateType)[keyof typeof TemplateType];

// Scoring Function Type
export const ScoringFunctionType = {
  LAMBDA: 'LAMBDA',
  CONTAINER: 'CONTAINER',
  API: 'API',
  MANUAL: 'MANUAL',
} as const;

export type ScoringFunctionType =
  (typeof ScoringFunctionType)[keyof typeof ScoringFunctionType];

// Problem Template Item
export interface ProblemTemplateItem extends DynamoDBItem {
  EntityType: 'PROBLEM_TEMPLATE';
  id: string;
  name: string;
  description: string;
  type: ProblemType;
  category: ProblemCategory;
  difficulty: DifficultyLevel;
  status: ProblemTemplateStatus;
  variables: unknown[];
  overviewTemplate: string;
  objectivesTemplate: string[];
  hintsTemplate: string[];
  prerequisites: string[];
  estimatedTimeMinutes?: number;
  providers: CloudProvider[];
  templateType: TemplateType;
  templateContent: string;
  regions: Record<string, string[]>;
  deploymentTimeout: number;
  scoringType: ScoringFunctionType;
  criteriaTemplate: unknown[];
  scoringTimeout: number;
  tags: string[];
  author: string;
  version: string;
  usageCount: number;
}

// Problem Template Domain Type
export interface ProblemTemplate {
  id: string;
  name: string;
  description: string;
  type: ProblemType;
  category: ProblemCategory;
  difficulty: DifficultyLevel;
  status: ProblemTemplateStatus;
  variables: unknown[];
  overviewTemplate: string;
  objectivesTemplate: string[];
  hintsTemplate: string[];
  prerequisites: string[];
  estimatedTimeMinutes?: number;
  providers: CloudProvider[];
  templateType: TemplateType;
  templateContent: string;
  regions: Record<string, string[]>;
  deploymentTimeout: number;
  scoringType: ScoringFunctionType;
  criteriaTemplate: unknown[];
  scoringTimeout: number;
  tags: string[];
  author: string;
  version: string;
  usageCount: number;
  createdAt: Date;
  updatedAt: Date;
}

// Problem Template Input Types
export interface CreateProblemTemplateInput {
  name: string;
  description: string;
  type: ProblemType;
  category: ProblemCategory;
  difficulty: DifficultyLevel;
  overviewTemplate: string;
  objectivesTemplate?: string[];
  hintsTemplate?: string[];
  prerequisites?: string[];
  estimatedTimeMinutes?: number;
  providers: CloudProvider[];
  templateType: TemplateType;
  templateContent: string;
  regions?: Record<string, string[]>;
  deploymentTimeout?: number;
  scoringType: ScoringFunctionType;
  criteriaTemplate?: unknown[];
  scoringTimeout?: number;
  tags?: string[];
  author: string;
}

export interface UpdateProblemTemplateInput {
  name?: string;
  description?: string;
  status?: ProblemTemplateStatus;
  overviewTemplate?: string;
  objectivesTemplate?: string[];
  hintsTemplate?: string[];
  templateContent?: string;
  criteriaTemplate?: unknown[];
  tags?: string[];
}

// =============================================================================
// Event Types
// =============================================================================

// Event Status
export const EventStatus = {
  DRAFT: 'DRAFT',
  SCHEDULED: 'SCHEDULED',
  ACTIVE: 'ACTIVE',
  PAUSED: 'PAUSED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
} as const;

export type EventStatus = (typeof EventStatus)[keyof typeof EventStatus];

// Participant Type
export const ParticipantType = {
  INDIVIDUAL: 'INDIVIDUAL',
  TEAM: 'TEAM',
} as const;

export type ParticipantType =
  (typeof ParticipantType)[keyof typeof ParticipantType];

// Scoring Type
export const ScoringType = {
  REALTIME: 'REALTIME',
  BATCH: 'BATCH',
} as const;

export type ScoringType = (typeof ScoringType)[keyof typeof ScoringType];

// Event Item (DynamoDB)
export interface EventItem extends DynamoDBItem {
  EntityType: 'EVENT';
  id: string;
  externalId: string;
  tenantId: string;
  name: string;
  type: ProblemType;
  status: EventStatus;
  startTime: string;
  endTime: string;
  timezone: string;
  participantType: ParticipantType;
  maxParticipants: number;
  minTeamSize?: number;
  maxTeamSize?: number;
  registrationDeadline?: string;
  cloudProvider: CloudProvider;
  regions: string[];
  scoringType: ScoringType;
  scoringIntervalMinutes: number;
  leaderboardVisible: boolean;
  freezeLeaderboardMinutes?: number;
  createdBy?: string;
}

// Event Domain Type
export interface Event {
  id: string;
  externalId: string;
  tenantId: string;
  name: string;
  type: ProblemType;
  status: EventStatus;
  startTime: Date;
  endTime: Date;
  timezone: string;
  participantType: ParticipantType;
  maxParticipants: number;
  minTeamSize?: number;
  maxTeamSize?: number;
  registrationDeadline?: Date;
  cloudProvider: CloudProvider;
  regions: string[];
  scoringType: ScoringType;
  scoringIntervalMinutes: number;
  leaderboardVisible: boolean;
  freezeLeaderboardMinutes?: number;
  createdBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

// Event Input Types
export interface CreateEventInput {
  externalId?: string;
  tenantId: string;
  name: string;
  type: ProblemType;
  status?: EventStatus;
  startTime: Date;
  endTime: Date;
  timezone?: string;
  participantType: ParticipantType;
  maxParticipants: number;
  minTeamSize?: number;
  maxTeamSize?: number;
  registrationDeadline?: Date;
  cloudProvider: CloudProvider;
  regions: string[];
  scoringType: ScoringType;
  scoringIntervalMinutes: number;
  leaderboardVisible?: boolean;
  freezeLeaderboardMinutes?: number;
  createdBy?: string;
}

export interface UpdateEventInput {
  name?: string;
  status?: EventStatus;
  startTime?: Date;
  endTime?: Date;
  timezone?: string;
  participantType?: ParticipantType;
  maxParticipants?: number;
  minTeamSize?: number;
  maxTeamSize?: number;
  registrationDeadline?: Date;
  cloudProvider?: CloudProvider;
  regions?: string[];
  scoringType?: ScoringType;
  scoringIntervalMinutes?: number;
  leaderboardVisible?: boolean;
  freezeLeaderboardMinutes?: number;
}

// EventProblem Item (DynamoDB)
export interface EventProblemItem extends DynamoDBItem {
  EntityType: 'EVENT_PROBLEM';
  eventId: string;
  problemId: string;
  order: number;
  unlockTime?: string;
  pointMultiplier: number;
}

// EventProblem Domain Type
export interface EventProblem {
  eventId: string;
  problemId: string;
  order: number;
  unlockTime?: Date;
  pointMultiplier: number;
}
