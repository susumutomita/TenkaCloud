// Client
export { initDynamoDB, getDocClient, getTableName } from './client';
export type { DynamoDBConfig } from './client';

// Types
export {
  EntityType,
  TenantStatus,
  TenantTier,
  IsolationModel,
  ComputeType,
  ProvisioningStatus,
  UserRole,
  UserStatus,
} from './types';

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

// Repositories
export { TenantRepository } from './tenant-repository';
export { UserRepository } from './user-repository';
