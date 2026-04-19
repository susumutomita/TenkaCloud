/**
 * Tenant & User Domain Types
 */

import type { DynamoDBItem } from './base-types';

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

export const ApplicationDeploymentStatus = {
  NOT_DEPLOYED: 'NOT_DEPLOYED',
  DEPLOYING: 'DEPLOYING',
  DEPLOYED: 'DEPLOYED',
  FAILED: 'FAILED',
} as const;

export type ApplicationDeploymentStatus =
  (typeof ApplicationDeploymentStatus)[keyof typeof ApplicationDeploymentStatus];

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
  applicationDeploymentStatus?: ApplicationDeploymentStatus;
  applicationPlaneEndpoint?: string;
  provisionedResources?: TenantProvisionedResources;
  provisioningError?: string | null;
  provisionedAt?: string;
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
  applicationDeploymentStatus?: ApplicationDeploymentStatus;
  applicationPlaneEndpoint?: string;
  provisionedResources?: TenantProvisionedResources;
  provisioningError?: string | null;
  provisionedAt?: Date;
  auth0OrgId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface TenantProvisionedService {
  name: string;
  kind?: 'ui' | 'api' | 'worker' | 'storage' | 'identity' | 'observability';
  endpoint?: string;
}

export interface TenantProvisionedResources {
  s3Bucket?: string;
  s3Prefix?: string;
  iamRoleArn?: string;
  cloudwatchLogGroup?: string;
  auth0OrganizationId?: string;
  services?: TenantProvisionedService[];
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
  applicationDeploymentStatus?: ApplicationDeploymentStatus;
  applicationPlaneEndpoint?: string;
  provisionedResources?: TenantProvisionedResources;
  provisioningError?: string | null;
  provisionedAt?: Date;
  auth0OrgId?: string;
}

export interface UpdateUserInput {
  name?: string;
  role?: UserRole;
  status?: UserStatus;
  auth0Id?: string;
}
