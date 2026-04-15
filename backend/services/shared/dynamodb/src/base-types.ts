/**
 * TenkaCloud DynamoDB Base & Entity Types
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
