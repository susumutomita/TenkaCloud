import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { apiReference } from '@scalar/hono-api-reference';
import { describeRoute, openAPIRouteHandler } from 'hono-openapi';
import { z } from 'zod';
import {
  initDynamoDB,
  TenantRepository,
  SystemSettingRepository,
  AuditLogRepository,
  type TenantStatus,
  type TenantTier,
  type IsolationModel,
  type ComputeType,
} from '@tenkacloud/dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { createLogger } from './lib/logger';
import { authMiddleware, requireRoles, UserRole } from './middleware/auth';
import { auditMiddleware } from './middleware/audit';
import { ProvisioningManager } from './provisioning/manager';

initDynamoDB({
  tableName: process.env.DYNAMODB_TABLE_NAME ?? 'TenkaCloud-dev',
  endpoint: process.env.DYNAMODB_ENDPOINT,
});

const tenantRepository = new TenantRepository();
const settingRepository = new SystemSettingRepository();
const auditLogRepository = new AuditLogRepository();

// Provisioning is optional and can be disabled for local development
const provisioningEnabled = process.env.PROVISIONING_ENABLED === 'true';
const provisioningManager = provisioningEnabled
  ? new ProvisioningManager()
  : null;

const app = new Hono();
const appLogger = createLogger('tenant-api');

// CORS configuration - strict origin control
app.use(
  '*',
  cors({
    origin: [
      'http://localhost:13000',
      'http://localhost:13001',
      'http://localhost:13002',
      'http://localhost:13003',
      'http://localhost:13004',
      process.env.ALLOWED_ORIGIN || '',
    ].filter(Boolean),
    credentials: true,
    allowHeaders: ['Content-Type', 'Authorization'],
  })
);

// Audit logging for all API requests
app.use('/api/*', auditMiddleware);

// Authentication required for tenant management and settings operations
app.use(
  '/api/tenants*',
  authMiddleware,
  requireRoles(UserRole.PLATFORM_ADMIN, UserRole.TENANT_ADMIN)
);
app.use(
  '/api/settings*',
  authMiddleware,
  requireRoles(UserRole.PLATFORM_ADMIN)
);

// Tenant ID: ULID (26 uppercase alphanumeric) or legacy slug (lowercase alphanumeric + hyphens)
const idSchema = z
  .string()
  .min(1, 'ID is required')
  .max(128, 'ID too long')
  .regex(/^[0-9A-Za-z-]+$/, 'Invalid ID format');

const createTenantSchema = z.object({
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

const updateTenantSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'ARCHIVED'] as const).optional(),
  tier: z.enum(['FREE', 'PRO', 'ENTERPRISE'] as const).optional(),
});

// Tier to IsolationModel mapping - defines the required isolation model for each tier
const TIER_ISOLATION_MODEL: Record<TenantTier, IsolationModel> = {
  FREE: 'POOL',
  PRO: 'POOL',
  ENTERPRISE: 'SILO',
};

// Settings schemas
const platformSettingsSchema = z.object({
  platformName: z.string().min(1).max(255),
  language: z.enum(['ja', 'en'] as const),
  timezone: z.string().min(1),
});

const securitySettingsSchema = z.object({
  mfaRequired: z.boolean(),
  sessionTimeoutMinutes: z.number().min(5).max(1440),
  maxLoginAttempts: z.number().min(1).max(100),
});

const notificationSettingsSchema = z.object({
  emailNotificationsEnabled: z.boolean(),
  systemAlertsEnabled: z.boolean(),
  maintenanceNotificationsEnabled: z.boolean(),
});

const appearanceSettingsSchema = z.object({
  theme: z.enum(['light', 'dark', 'system'] as const),
});

const settingsSchema = z.object({
  platform: platformSettingsSchema,
  security: securitySettingsSchema,
  notifications: notificationSettingsSchema,
  appearance: appearanceSettingsSchema,
});

// Default settings
const DEFAULT_SETTINGS = {
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
const MAX_LIMIT = 100; // Maximum items per page

const bearerAuth = [{ bearerAuth: [] }];

const tenantPathParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string' },
  description: 'テナントID (ULID または legacy slug)',
} as const;

const validationErrorResponse = { description: 'バリデーションエラー' };
const unauthorizedResponse = { description: '認証エラー' };
const forbiddenResponse = { description: '権限エラー' };
const notFoundResponse = { description: '対象が見つからない' };

const tenantSchema = {
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
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

const settingsSchemaDefinition = {
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

function errorResponse(message: string, status: number, details?: unknown) {
  const response: { error: string; details?: unknown } = { error: message };
  // Only include error details in non-production environments to prevent information leakage
  if (details && process.env.NODE_ENV !== 'production') {
    response.details = details;
  }
  return response;
}

app.get(
  '/health',
  describeRoute({
    tags: ['System'],
    summary: 'ヘルスチェック',
    description: 'tenant-management サービスの稼働状態を返します。',
    responses: {
      200: { description: 'サービス稼働中' },
    },
  }),
  (c) => {
    return c.json({ status: 'ok', service: 'tenant-management' });
  }
);

// No auth required: used for initial control-plane dashboard load
app.get(
  '/api/stats',
  describeRoute({
    tags: ['Dashboard'],
    summary: 'ダッシュボード統計取得',
    description: 'Control Plane のダッシュボード用集計値を返します。',
    responses: {
      200: { description: '統計取得成功' },
      500: { description: '統計取得失敗' },
    },
  }),
  async (c) => {
    try {
      const [totalTenants, listResult] = await Promise.all([
        tenantRepository.count(),
        tenantRepository.list({ limit: 100 }),
      ]);

    // Count active tenants
    const activeTenants = listResult.tenants.filter(
      (t) => t.status === 'ACTIVE'
    ).length;

    // Determine system status based on provisioning state
    const failedCount = listResult.tenants.filter(
      (t) => t.provisioningStatus === 'FAILED'
    ).length;
    const inProgressCount = listResult.tenants.filter(
      (t) => t.provisioningStatus === 'IN_PROGRESS'
    ).length;

    // Calculate system health:
    // - degraded: any tenant has failed provisioning
    // - healthy: all tenants completed or pending/in-progress
    const systemStatus: 'healthy' | 'degraded' | 'down' =
      failedCount > 0 ? 'degraded' : 'healthy';

    // Calculate uptime percentage based on successful provisioning
    // (tenants not in FAILED state / total tenants) * 100
    const successfulTenants = totalTenants - failedCount;
    const uptimePercentage =
      totalTenants > 0
        ? Math.round((successfulTenants / totalTenants) * 100)
        : 100;

      return c.json({
        activeTenants,
        totalTenants,
        systemStatus,
        uptimePercentage,
        // Additional context for debugging
        provisioningStats: {
          completed: listResult.tenants.filter(
            (t) => t.provisioningStatus === 'COMPLETED'
          ).length,
          inProgress: inProgressCount,
          failed: failedCount,
          pending: listResult.tenants.filter(
            (t) => t.provisioningStatus === 'PENDING'
          ).length,
        },
      });
    } catch (error) {
      appLogger.error({ error }, 'Failed to fetch stats');
      return c.json(errorResponse('Failed to fetch stats', 500), 500);
    }
  }
);

app.get(
  '/api/settings',
  describeRoute({
    tags: ['Settings'],
    summary: '設定取得',
    description: 'Control Plane の設定を取得します。',
    responses: {
      200: { description: '設定取得成功' },
      500: { description: '設定取得失敗' },
    },
  }),
  async (c) => {
    try {
      const [platform, security, notifications, appearance] = await Promise.all([
        settingRepository.get('platform'),
        settingRepository.get('security'),
        settingRepository.get('notifications'),
        settingRepository.get('appearance'),
      ]);

    const settings = {
      platform: platform?.value
        ? JSON.parse(platform.value as string)
        : DEFAULT_SETTINGS.platform,
      security: security?.value
        ? JSON.parse(security.value as string)
        : DEFAULT_SETTINGS.security,
      notifications: notifications?.value
        ? JSON.parse(notifications.value as string)
        : DEFAULT_SETTINGS.notifications,
      appearance: appearance?.value
        ? JSON.parse(appearance.value as string)
        : DEFAULT_SETTINGS.appearance,
    };

      return c.json(settings);
    } catch (error) {
      appLogger.error({ error }, 'Failed to fetch settings');
      return c.json(errorResponse('Failed to fetch settings', 500), 500);
    }
  }
);

app.put(
  '/api/settings',
  describeRoute({
    tags: ['Settings'],
    summary: '設定更新',
    description: 'Control Plane の設定を更新します。',
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: settingsSchemaDefinition as any,
        },
      },
    },
    responses: {
      200: { description: '設定更新成功' },
      400: validationErrorResponse,
      500: { description: '設定更新失敗' },
    },
  }),
  async (c) => {
    try {
      const body = await c.req.json();
      const validated = settingsSchema.parse(body);

    // Save each category as a separate key
    await Promise.all([
      settingRepository.set({
        key: 'platform',
        value: JSON.stringify(validated.platform),
        category: 'system',
        updatedBy: 'system',
      }),
      settingRepository.set({
        key: 'security',
        value: JSON.stringify(validated.security),
        category: 'system',
        updatedBy: 'system',
      }),
      settingRepository.set({
        key: 'notifications',
        value: JSON.stringify(validated.notifications),
        category: 'system',
        updatedBy: 'system',
      }),
      settingRepository.set({
        key: 'appearance',
        value: JSON.stringify(validated.appearance),
        category: 'system',
        updatedBy: 'system',
      }),
    ]);

      appLogger.info('Settings updated successfully');
      return c.json({ success: true, message: 'Settings saved successfully' });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return c.json(errorResponse('Validation error', 400, error.errors), 400);
      }

      appLogger.error({ error }, 'Failed to save settings');
      return c.json(errorResponse('Failed to save settings', 500), 500);
    }
  }
);

app.get(
  '/api/activities',
  describeRoute({
    tags: ['Audit'],
    summary: '監査アクティビティ一覧取得',
    description: 'Control Plane の最近の監査ログを取得します。',
    parameters: [
      {
        name: 'limit',
        in: 'query',
        required: false,
        schema: { type: 'integer', default: 10, minimum: 1, maximum: 50 },
        description: '取得件数',
      },
    ],
    responses: {
      200: { description: 'アクティビティ取得成功' },
      500: { description: 'アクティビティ取得失敗' },
    },
  }),
  async (c) => {
    try {
      const limitParam = parseInt(c.req.query('limit') || '10', 10);
      const limit = Math.min(
        50,
        Math.max(1, isNaN(limitParam) ? 10 : limitParam)
      );

    // Fetch system-wide activities (tenantId is empty for system events)
    const result = await auditLogRepository.listByTenant('', { limit });

    // Transform audit logs to activity format
    const activities = result.logs.map((log) => ({
      id: log.id,
      action: log.action,
      resourceType: log.resourceType,
      resourceId: log.resourceId,
      details: log.details,
      timestamp: log.createdAt.toISOString(),
    }));

      return c.json({
        data: activities,
        pagination: {
          limit,
          hasNextPage: !!result.lastKey,
        },
      });
    } catch (error) {
      appLogger.error({ error }, 'Failed to fetch activities');
      return c.json(errorResponse('Failed to fetch activities', 500), 500);
    }
  }
);

app.get(
  '/api/tenants',
  describeRoute({
    tags: ['Tenants'],
    summary: 'テナント一覧取得',
    description: 'テナント一覧をページング付きで取得します。',
    security: bearerAuth,
    parameters: [
      {
        name: 'limit',
        in: 'query',
        required: false,
        schema: { type: 'integer', default: 50, minimum: 1, maximum: 100 },
        description: '取得件数',
      },
      {
        name: 'lastKey',
        in: 'query',
        required: false,
        schema: { type: 'string' },
        description: '次ページ取得用の lastKey JSON 文字列',
      },
    ],
    responses: {
      200: { description: 'テナント一覧取得成功' },
      401: unauthorizedResponse,
      403: forbiddenResponse,
      500: { description: 'テナント一覧取得失敗' },
    },
  }),
  async (c) => {
    try {
      const limitParam = parseInt(c.req.query('limit') || '50', 10);
      const limit = Math.min(
        MAX_LIMIT,
        Math.max(1, isNaN(limitParam) ? 50 : limitParam)
      );

    // Get lastKey from query if provided
    const lastKeyParam = c.req.query('lastKey');
    const lastKey = lastKeyParam ? JSON.parse(lastKeyParam) : undefined;

    const [countResult, listResult] = await Promise.all([
      tenantRepository.count(),
      tenantRepository.list({ limit, lastKey }),
    ]);

    const total = countResult;
    const tenants = listResult.tenants;

    appLogger.info(
      { limit, total, tenantsCount: tenants.length },
      'Fetched tenants'
    );

      return c.json({
        data: tenants,
        pagination: {
          limit,
          total,
          hasNextPage: !!listResult.lastKey,
          lastKey: listResult.lastKey,
        },
      });
    } catch (error) {
      appLogger.error({ error }, 'Failed to fetch tenants');
      return c.json(errorResponse('Failed to fetch tenants', 500), 500);
    }
  }
);

// Get tenant by ID
app.get(
  '/api/tenants/:id',
  describeRoute({
    tags: ['Tenants'],
    summary: 'テナント詳細取得',
    description: '指定テナントの詳細を取得します。',
    security: bearerAuth,
    parameters: [tenantPathParam],
    responses: {
      200: { description: 'テナント詳細取得成功' },
      400: validationErrorResponse,
      401: unauthorizedResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
      500: { description: 'テナント取得失敗' },
    },
  }),
  async (c) => {
    const id = c.req.param('id');

    // Validate ULID
    const idValidation = idSchema.safeParse(id);
    if (!idValidation.success) {
      return c.json(
        errorResponse('Invalid tenant ID', 400, idValidation.error.errors),
        400
      );
    }

    try {
      const tenant = await tenantRepository.findById(idValidation.data);

      if (!tenant) {
        return c.json(errorResponse('Tenant not found', 404), 404);
      }

      return c.json(tenant);
    } catch (error) {
      appLogger.error({ error, tenantId: id }, 'Failed to fetch tenant');
      return c.json(errorResponse('Failed to fetch tenant', 500), 500);
    }
  }
);

app.post(
  '/api/tenants',
  describeRoute({
    tags: ['Tenants'],
    summary: 'テナント作成',
    description: '新しいテナントを作成します。',
    security: bearerAuth,
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['name', 'slug', 'adminEmail'],
            properties: {
              name: { type: 'string' },
              slug: { type: 'string' },
              adminEmail: { type: 'string', format: 'email' },
              tier: { type: 'string', enum: ['FREE', 'PRO', 'ENTERPRISE'] },
              status: { type: 'string', enum: ['ACTIVE', 'SUSPENDED', 'ARCHIVED'] },
              region: { type: 'string' },
              isolationModel: { type: 'string', enum: ['POOL', 'SILO'] },
              computeType: {
                type: 'string',
                enum: ['KUBERNETES', 'SERVERLESS'],
              },
            },
          },
        },
      },
    },
    responses: {
      201: { description: 'テナント作成成功' },
      400: validationErrorResponse,
      401: unauthorizedResponse,
      403: forbiddenResponse,
      409: { description: 'slug 重複' },
      500: { description: 'テナント作成失敗' },
    },
  }),
  async (c) => {
    try {
      const body = await c.req.json();
      const validated = createTenantSchema.parse(body);

    // Check if slug already exists
    const existingTenant = await tenantRepository.findBySlug(validated.slug);
    if (existingTenant) {
      return c.json(
        errorResponse('Tenant with this slug already exists', 409),
        409
      );
    }

      const tenant = await tenantRepository.create({
        name: validated.name,
        slug: validated.slug,
        adminEmail: validated.adminEmail,
        tier: validated.tier,
        region: validated.region,
        isolationModel: validated.isolationModel,
        computeType: validated.computeType,
      });

      return c.json(tenant, 201);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return c.json(errorResponse('Validation error', 400, error.errors), 400);
      }

      appLogger.error({ error }, 'Failed to create tenant');
      return c.json(errorResponse('Failed to create tenant', 500), 500);
    }
  }
);

app.patch(
  '/api/tenants/:id',
  describeRoute({
    tags: ['Tenants'],
    summary: 'テナント更新',
    description: 'テナントの基本情報や tier/status を更新します。',
    security: bearerAuth,
    parameters: [tenantPathParam],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              status: { type: 'string', enum: ['ACTIVE', 'SUSPENDED', 'ARCHIVED'] },
              tier: { type: 'string', enum: ['FREE', 'PRO', 'ENTERPRISE'] },
            },
          },
        },
      },
    },
    responses: {
      200: { description: 'テナント更新成功' },
      400: validationErrorResponse,
      401: unauthorizedResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
      500: { description: 'テナント更新失敗' },
    },
  }),
  async (c) => {
    const id = c.req.param('id');

    // Validate ULID
    const idValidation = idSchema.safeParse(id);
    if (!idValidation.success) {
      return c.json(
        errorResponse('Invalid tenant ID', 400, idValidation.error.errors),
        400
      );
    }

  try {
    const body = await c.req.json();
    const validated = updateTenantSchema.parse(body);

    // Build update input with tier change business logic
    const updateInput: {
      name?: string;
      status?: TenantStatus;
      tier?: TenantTier;
      isolationModel?: IsolationModel;
      provisioningStatus?: 'PENDING';
    } = { ...validated };

    // If tier is being changed, check if isolationModel needs to change
    if (validated.tier) {
      // Get current tenant to check current isolationModel
      const currentTenant = await tenantRepository.findById(idValidation.data);
      if (!currentTenant) {
        return c.json(errorResponse('Tenant not found', 404), 404);
      }

      const requiredIsolationModel = TIER_ISOLATION_MODEL[validated.tier];

      // If isolationModel needs to change, update it and trigger re-provisioning
      if (currentTenant.isolationModel !== requiredIsolationModel) {
        updateInput.isolationModel = requiredIsolationModel;
        updateInput.provisioningStatus = 'PENDING';

        appLogger.info(
          {
            tenantId: id,
            tierChange: `${currentTenant.tier} -> ${validated.tier}`,
            isolationModelChange: `${currentTenant.isolationModel} -> ${requiredIsolationModel}`,
          },
          'Tier change requires re-provisioning'
        );
      }
    }

    const tenant = await tenantRepository.update(
      idValidation.data,
      updateInput
    );

    return c.json(tenant);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json(errorResponse('Validation error', 400, error.errors), 400);
    }

    // ConditionalCheckFailedException means item doesn't exist
    if (error instanceof ConditionalCheckFailedException) {
      return c.json(errorResponse('Tenant not found', 404), 404);
    }

    appLogger.error({ error, tenantId: id }, 'Failed to update tenant');
    return c.json(errorResponse('Failed to update tenant', 500), 500);
  }
  }
);

app.delete(
  '/api/tenants/:id',
  describeRoute({
    tags: ['Tenants'],
    summary: 'テナント削除',
    description: '指定テナントを削除します。',
    security: bearerAuth,
    parameters: [tenantPathParam],
    responses: {
      200: { description: 'テナント削除成功' },
      400: validationErrorResponse,
      401: unauthorizedResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
      500: { description: 'テナント削除失敗' },
    },
  }),
  async (c) => {
    const id = c.req.param('id');

    // Validate ULID
    const idValidation = idSchema.safeParse(id);
    if (!idValidation.success) {
      return c.json(
        errorResponse('Invalid tenant ID', 400, idValidation.error.errors),
        400
      );
    }

  try {
    // First check if tenant exists
    const tenant = await tenantRepository.findById(idValidation.data);
    if (!tenant) {
      return c.json(errorResponse('Tenant not found', 404), 404);
    }

    await tenantRepository.delete(idValidation.data);

    return c.json({ success: true, message: 'Tenant deleted successfully' });
  } catch (error) {
    appLogger.error({ error, tenantId: id }, 'Failed to delete tenant');
    return c.json(errorResponse('Failed to delete tenant', 500), 500);
  }
  }
);

// Trigger provisioning for a tenant
app.post(
  '/api/tenants/:id/provision',
  describeRoute({
    tags: ['Provisioning'],
    summary: 'テナントプロビジョニング開始',
    description: '指定テナントのプロビジョニングを開始します。',
    security: bearerAuth,
    parameters: [tenantPathParam],
    responses: {
      200: { description: 'プロビジョニング開始成功' },
      400: validationErrorResponse,
      401: unauthorizedResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
      409: { description: 'すでに進行中または完了済み' },
      500: { description: 'プロビジョニング開始失敗' },
    },
  }),
  async (c) => {
    const id = c.req.param('id');

    // Validate ULID
    const idValidation = idSchema.safeParse(id);
    if (!idValidation.success) {
      return c.json(
        errorResponse('Invalid tenant ID', 400, idValidation.error.errors),
        400
      );
    }

  try {
    // Find tenant
    const tenant = await tenantRepository.findById(idValidation.data);
    if (!tenant) {
      return c.json(errorResponse('Tenant not found', 404), 404);
    }

    // Check if provisioning is already in progress or completed
    if (tenant.provisioningStatus === 'IN_PROGRESS') {
      return c.json(
        errorResponse('Provisioning is already in progress', 409),
        409
      );
    }

    if (tenant.provisioningStatus === 'COMPLETED') {
      return c.json(errorResponse('Tenant is already provisioned', 409), 409);
    }

    // Check if provisioning is enabled
    if (!provisioningManager) {
      // Simulate provisioning in development mode
      appLogger.info(
        { tenantId: tenant.id },
        'Provisioning disabled, marking as completed'
      );
      await tenantRepository.update(tenant.id, {
        provisioningStatus: 'COMPLETED',
      });
      return c.json({
        success: true,
        message: 'Provisioning skipped (disabled in this environment)',
        provisioningStatus: 'COMPLETED',
      });
    }

    // Start async provisioning
    appLogger.info({ tenantId: tenant.id }, 'Starting provisioning');

    // Fire and forget - don't await
    provisioningManager.provisionTenant(tenant).catch((error) => {
      appLogger.error(
        { error, tenantId: tenant.id },
        'Background provisioning failed'
      );
    });

    return c.json({
      success: true,
      message: 'Provisioning started',
      provisioningStatus: 'IN_PROGRESS',
    });
  } catch (error) {
    appLogger.error({ error, tenantId: id }, 'Failed to start provisioning');
    return c.json(errorResponse('Failed to start provisioning', 500), 500);
  }
  }
);

app.get(
  '/api/tenants/:id/provision',
  describeRoute({
    tags: ['Provisioning'],
    summary: 'テナントプロビジョニング状態取得',
    description: '指定テナントのプロビジョニング状態を返します。',
    security: bearerAuth,
    parameters: [tenantPathParam],
    responses: {
      200: { description: '状態取得成功' },
      400: validationErrorResponse,
      401: unauthorizedResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
      500: { description: '状態取得失敗' },
    },
  }),
  async (c) => {
    const id = c.req.param('id');

    // Validate ULID
    const idValidation = idSchema.safeParse(id);
    if (!idValidation.success) {
      return c.json(
        errorResponse('Invalid tenant ID', 400, idValidation.error.errors),
        400
      );
    }

  try {
    const tenant = await tenantRepository.findById(idValidation.data);
    if (!tenant) {
      return c.json(errorResponse('Tenant not found', 404), 404);
    }

    return c.json({
      tenantId: tenant.id,
      provisioningStatus: tenant.provisioningStatus,
      provisioningEnabled,
    });
  } catch (error) {
    appLogger.error(
      { error, tenantId: id },
      'Failed to get provisioning status'
    );
    return c.json(errorResponse('Failed to get provisioning status', 500), 500);
  }
  }
);

// OpenAPI docs available only in non-production environments
if (process.env.NODE_ENV !== 'production') {
app.get(
  '/openapi.json',
  openAPIRouteHandler(app, {
    documentation: {
      info: {
        title: 'TenkaCloud Tenant Management API',
        version: '1.0.0',
        description:
          'Control Plane の tenant-management サービス。テナント管理、設定管理、監査アクティビティ、プロビジョニング開始 API を提供します。',
      },
      tags: [
        { name: 'System', description: 'ヘルスチェック' },
        { name: 'Dashboard', description: 'ダッシュボード統計' },
        { name: 'Settings', description: 'Control Plane 設定管理' },
        { name: 'Audit', description: '監査アクティビティ' },
        { name: 'Tenants', description: 'テナント CRUD' },
        { name: 'Provisioning', description: 'テナントプロビジョニング' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: 'Authorization ヘッダーに Auth0 JWT を指定',
          },
        },
        schemas: {
          Tenant: tenantSchema as any,
          Settings: settingsSchemaDefinition as any,
        },
      },
    },
  })
);

app.get(
  '/docs',
  apiReference({
    url: '/openapi.json',
    pageTitle: 'TenkaCloud Tenant Management API',
    theme: 'default',
  })
);
}

const port = 13004;

// Only log when not in test environment
if (process.env.NODE_ENV !== 'test') {
  appLogger.info({ port }, 'Tenant Management API is running');
}

// Graceful shutdown handlers
function gracefulShutdown(signal: string) {
  appLogger.info({ signal }, 'Received shutdown signal');
  process.exit(0);
}

// Only register shutdown handlers when not in test environment
if (process.env.NODE_ENV !== 'test') {
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

// Export app for testing
export { app };

export default {
  port,
  fetch: app.fetch,
  hostname: '0.0.0.0',
};
