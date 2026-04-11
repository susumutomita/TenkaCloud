import { z } from 'zod';
import {
  type TenantStatus,
  type TenantTier,
  type IsolationModel,
  type ComputeType,
} from '@tenkacloud/dynamodb';

// Tenant ID: ULID (26 uppercase alphanumeric) or legacy slug (lowercase alphanumeric + hyphens)
export const idSchema = z
  .string()
  .min(1, 'ID is required')
  .max(128, 'ID too long')
  .regex(/^[0-9A-Za-z-]+$/, 'Invalid ID format');

export const createTenantSchema = z.object({
  name: z.string().min(1, 'Name is required').max(255),
  slug: z
    .string()
    .min(3)
    .max(63)
    .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric and hyphens'),
  adminEmail: z.string().email('Invalid email format'),
  tier: z
    .enum(['FREE', 'PRO', 'ENTERPRISE'] as const)
    .default('FREE') as z.ZodType<TenantTier>,
  status: z
    .enum(['ACTIVE', 'SUSPENDED', 'ARCHIVED'] as const)
    .default('ACTIVE') as z.ZodType<TenantStatus>,
  region: z.string().default('ap-northeast-1'),
  isolationModel: z
    .enum(['POOL', 'SILO'] as const)
    .default('POOL') as z.ZodType<IsolationModel>,
  computeType: z
    .enum(['KUBERNETES', 'SERVERLESS'] as const)
    .default('SERVERLESS') as z.ZodType<ComputeType>,
});

export const updateTenantSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'ARCHIVED'] as const).optional(),
  tier: z.enum(['FREE', 'PRO', 'ENTERPRISE'] as const).optional(),
});

// Tier to IsolationModel mapping - defines the required isolation model for each tier
export const TIER_ISOLATION_MODEL: Record<TenantTier, IsolationModel> = {
  FREE: 'POOL',
  PRO: 'POOL',
  ENTERPRISE: 'SILO',
};

// Settings schemas
export const platformSettingsSchema = z.object({
  platformName: z.string().min(1).max(255),
  language: z.enum(['ja', 'en'] as const),
  timezone: z.string().min(1),
});

export const securitySettingsSchema = z.object({
  mfaRequired: z.boolean(),
  sessionTimeoutMinutes: z.number().min(5).max(1440),
  maxLoginAttempts: z.number().min(1).max(100),
});

export const notificationSettingsSchema = z.object({
  emailNotificationsEnabled: z.boolean(),
  systemAlertsEnabled: z.boolean(),
  maintenanceNotificationsEnabled: z.boolean(),
});

export const appearanceSettingsSchema = z.object({
  theme: z.enum(['light', 'dark', 'system'] as const),
});

export const settingsSchema = z.object({
  platform: platformSettingsSchema,
  security: securitySettingsSchema,
  notifications: notificationSettingsSchema,
  appearance: appearanceSettingsSchema,
});

// Default settings
export const DEFAULT_SETTINGS = {
  platform: {
    platformName: 'TenkaCloud',
    language: 'ja' as const,
    timezone: 'Asia/Tokyo',
  },
  security: {
    mfaRequired: false,
    sessionTimeoutMinutes: 60,
    maxLoginAttempts: 5,
  },
  notifications: {
    emailNotificationsEnabled: true,
    systemAlertsEnabled: true,
    maintenanceNotificationsEnabled: true,
  },
  appearance: {
    theme: 'system' as const,
  },
};

// Pagination constants - DoS protection
export const MAX_LIMIT = 100; // Maximum items per page

export const bearerAuth = [{ bearerAuth: [] }];

export const tenantPathParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string' },
  description: 'テナントID (ULID または legacy slug)',
} as const;

export const validationErrorResponse = { description: 'バリデーションエラー' };
export const unauthorizedResponse = { description: '認証エラー' };
export const forbiddenResponse = { description: '権限エラー' };
export const notFoundResponse = { description: '対象が見つからない' };

export const tenantSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    slug: { type: 'string' },
    adminEmail: { type: 'string', format: 'email' },
    tier: { type: 'string', enum: ['FREE', 'PRO', 'ENTERPRISE'] },
    status: { type: 'string', enum: ['ACTIVE', 'SUSPENDED', 'ARCHIVED'] },
    region: { type: 'string' },
    isolationModel: { type: 'string', enum: ['POOL', 'SILO'] },
    computeType: { type: 'string', enum: ['KUBERNETES', 'SERVERLESS'] },
    provisioningStatus: {
      type: 'string',
      enum: ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED'],
    },
    applicationDeploymentStatus: {
      type: 'string',
      enum: ['NOT_DEPLOYED', 'DEPLOYING', 'DEPLOYED', 'FAILED'],
    },
    provisioningError: { type: 'string' },
    provisionedAt: { type: 'string', format: 'date-time' },
    provisionedResources: {
      type: 'object',
      properties: {
        s3Bucket: { type: 'string' },
        s3Prefix: { type: 'string' },
        iamRoleArn: { type: 'string' },
        cloudwatchLogGroup: { type: 'string' },
        auth0OrganizationId: { type: 'string' },
        services: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              kind: { type: 'string' },
              endpoint: { type: 'string' },
            },
          },
        },
      },
    },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

export const settingsSchemaDefinition = {
  type: 'object',
  properties: {
    platform: {
      type: 'object',
      properties: {
        platformName: { type: 'string' },
        language: { type: 'string', enum: ['ja', 'en'] },
        timezone: { type: 'string' },
      },
    },
    security: {
      type: 'object',
      properties: {
        mfaRequired: { type: 'boolean' },
        sessionTimeoutMinutes: { type: 'number' },
        maxLoginAttempts: { type: 'number' },
      },
    },
    notifications: {
      type: 'object',
      properties: {
        emailNotificationsEnabled: { type: 'boolean' },
        systemAlertsEnabled: { type: 'boolean' },
        maintenanceNotificationsEnabled: { type: 'boolean' },
      },
    },
    appearance: {
      type: 'object',
      properties: {
        theme: { type: 'string', enum: ['light', 'dark', 'system'] },
      },
    },
  },
};

export function errorResponse(message: string, status: number, details?: unknown) {
  const response: { error: string; details?: unknown } = { error: message };
  // Only include error details in non-production environments to prevent information leakage
  if (details && process.env.NODE_ENV !== 'production') {
    response.details = details;
  }
  return response;
}
