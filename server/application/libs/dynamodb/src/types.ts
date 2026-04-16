/**
 * TenkaCloud DynamoDB Single Table Design Types
 *
 * Barrel file — re-exports all domain type modules for backwards compatibility.
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

// Base & Entity Types
export { EntityType } from './base-types';
export type { DynamoDBItem } from './base-types';

// Tenant & User Types
export {
  TenantStatus,
  TenantTier,
  IsolationModel,
  ComputeType,
  ProvisioningStatus,
  ApplicationDeploymentStatus,
  UserRole,
  UserStatus,
} from './tenant-types';
export type {
  TenantItem,
  UserItem,
  TenantUserItem,
  Tenant,
  TenantProvisionedService,
  TenantProvisionedResources,
  User,
  CreateTenantInput,
  CreateUserInput,
  UpdateTenantInput,
  UpdateUserInput,
} from './tenant-types';

// Battle Types
export { BattleStatus, BattleMode } from './battle-types';
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
} from './battle-types';

// Scoring Types
export {
  EvaluationCategory,
  Severity,
  EvaluationStatus,
} from './scoring-types';
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
} from './scoring-types';

// Deployment Types
export { DeploymentStatus, DeploymentType } from './deployment-types';
export type {
  DeploymentItem,
  DeploymentHistoryItem,
  Deployment,
  DeploymentHistory,
  CreateDeploymentInput,
  UpdateDeploymentInput,
  CreateDeploymentHistoryInput,
} from './deployment-types';

// System Types
export { AuditAction, AuditResourceType } from './system-types';
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
} from './system-types';

// Problem Types
export {
  ProblemType,
  ProblemCategory,
  DifficultyLevel,
  CloudProvider,
  ProblemTemplateStatus,
  TemplateType,
  ScoringFunctionType,
} from './problem-types';
export type {
  ProblemTemplateItem,
  ProblemTemplate,
  CreateProblemTemplateInput,
  UpdateProblemTemplateInput,
} from './problem-types';

// Event Types
export { EventStatus, ParticipantType, ScoringType } from './event-types';
export type {
  EventItem,
  Event,
  CreateEventInput,
  UpdateEventInput,
  EventProblemItem,
  EventProblem,
} from './event-types';
