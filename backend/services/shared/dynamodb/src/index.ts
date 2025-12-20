// Client
export { initDynamoDB, getDocClient, getTableName } from './client';
export type { DynamoDBConfig } from './client';

// Types - Constants
export {
  EntityType,
  TenantStatus,
  TenantTier,
  IsolationModel,
  ComputeType,
  ProvisioningStatus,
  UserRole,
  UserStatus,
  // Battle
  BattleStatus,
  BattleMode,
  // Scoring
  EvaluationCategory,
  Severity,
  EvaluationStatus,
  // Deployment
  DeploymentStatus,
  DeploymentType,
  // System
  AuditAction,
  AuditResourceType,
  // Problem
  ProblemType,
  ProblemCategory,
  DifficultyLevel,
  CloudProvider,
  ProblemTemplateStatus,
  TemplateType,
  ScoringFunctionType,
  // Event
  EventStatus,
  ParticipantType,
  ScoringType,
} from './types';

// Types - Tenant & User
export type {
  DynamoDBItem,
  TenantItem,
  UserItem,
  TenantUserItem,
  Tenant,
  User,
  CreateTenantInput,
  CreateUserInput,
  UpdateTenantInput,
  UpdateUserInput,
} from './types';

// Types - Battle
export type {
  BattleItem,
  BattleParticipantItem,
  BattleTeamItem,
  BattleHistoryItem,
  Battle,
  BattleParticipant,
  BattleTeam,
  BattleHistory,
  CreateBattleInput,
  UpdateBattleInput,
} from './types';

// Types - Scoring
export type {
  TerraformSnapshot,
  EvaluationItemResult,
  ScoringFeedback,
  CriteriaDetail,
  ScoringSessionItem,
  EvaluationCriteriaItem,
  ScoringSession,
  EvaluationCriteria,
  CreateScoringSessionInput,
  CreateEvaluationCriteriaInput,
  UpdateScoringSessionInput,
  UpdateEvaluationCriteriaInput,
} from './types';

// Types - Deployment
export type {
  DeploymentItem,
  DeploymentHistoryItem,
  Deployment,
  DeploymentHistory,
  CreateDeploymentInput,
  UpdateDeploymentInput,
  CreateDeploymentHistoryInput,
} from './types';

// Types - System
export type {
  AuditLogItem,
  SystemSettingItem,
  ServiceHealthItem,
  AuditLog,
  SystemSetting,
  ServiceHealth,
  CreateAuditLogInput,
  SetSystemSettingInput,
  UpdateServiceHealthInput,
} from './types';

// Types - Problem
export type {
  ProblemTemplateItem,
  ProblemTemplate,
  CreateProblemTemplateInput,
  UpdateProblemTemplateInput,
} from './types';

// Types - Event
export type {
  EventItem,
  Event,
  CreateEventInput,
  UpdateEventInput,
  EventProblemItem,
  EventProblem,
} from './types';

// Repositories
export { TenantRepository } from './tenant-repository';
export { UserRepository } from './user-repository';
export { BattleRepository } from './battle-repository';
export { DeploymentRepository } from './deployment-repository';
export {
  ScoringSessionRepository,
  EvaluationCriteriaRepository,
} from './scoring-repository';
export {
  AuditLogRepository,
  SystemSettingRepository,
  ServiceHealthRepository,
} from './system-repository';
export { ProblemTemplateRepository } from './problem-template-repository';
export { EventRepository } from './event-repository';
export type { EventFilterOptions } from './event-repository';
