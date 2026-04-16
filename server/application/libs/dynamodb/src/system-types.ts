/**
 * System Management Types
 */

import type { DynamoDBItem } from './base-types';

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
