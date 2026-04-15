/**
 * Deployment Management Types
 */

import type { DynamoDBItem } from './base-types';

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
