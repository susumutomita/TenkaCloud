import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { apiReference } from '@scalar/hono-api-reference';
import { describeRoute, openAPIRouteHandler } from 'hono-openapi';
import {
  initDynamoDB,
  TenantRepository,
} from '@tenkacloud/dynamodb';
import { createLogger } from './lib/logger';
import { authMiddleware, requireRoles, UserRole } from './middleware/auth';
import { auditMiddleware } from './middleware/audit';
import { settingsRoutes } from './routes/settings';
import { tenantsRoutes } from './routes/tenants';
import { provisioningRoutes } from './routes/provisioning';
import {
  tenantSchema,
  settingsSchemaDefinition,
  errorResponse,
} from './routes/shared';

if (
  process.env.NODE_ENV === 'production' &&
  !process.env.DYNAMODB_TABLE_NAME
) {
  throw new Error(
    'DYNAMODB_TABLE_NAME must be set in production — refusing to fall back to TenkaCloud-dev.',
  );
}

initDynamoDB({
  tableName: process.env.DYNAMODB_TABLE_NAME ?? 'TenkaCloud-dev',
  endpoint: process.env.DYNAMODB_ENDPOINT,
});

const tenantRepository = new TenantRepository();

export const app = new Hono();
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
      // Paginate through all tenants so counters and totalTenants use the same scope
      const allTenants: Awaited<ReturnType<typeof tenantRepository.list>>['tenants'] = [];
      let lastKey: Record<string, unknown> | undefined;
      do {
        const page = await tenantRepository.list({ limit: 500, lastKey });
        allTenants.push(...page.tenants);
        lastKey = page.lastKey;
      } while (lastKey);

    const totalTenants = allTenants.length;
    let activeTenants = 0;
    let failedCount = 0;
    let inProgressCount = 0;
    let completedCount = 0;
    let pendingCount = 0;
    for (const t of allTenants) {
      if (t.status === 'ACTIVE') activeTenants++;
      if (t.provisioningStatus === 'FAILED') failedCount++;
      else if (t.provisioningStatus === 'IN_PROGRESS') inProgressCount++;
      else if (t.provisioningStatus === 'COMPLETED') completedCount++;
      else if (t.provisioningStatus === 'PENDING') pendingCount++;
    }

    const systemStatus: 'healthy' | 'degraded' | 'down' =
      failedCount > 0 ? 'degraded' : 'healthy';
    const uptimePercentage =
      totalTenants > 0
        ? Math.round(((totalTenants - failedCount) / totalTenants) * 100)
        : 100;

      return c.json({
        activeTenants,
        totalTenants,
        systemStatus,
        uptimePercentage,
        provisioningStats: {
          completed: completedCount,
          inProgress: inProgressCount,
          failed: failedCount,
          pending: pendingCount,
        },
      });
    } catch (error) {
      appLogger.error({ error }, 'Failed to fetch stats');
      return c.json(errorResponse('Failed to fetch stats', 500), 500);
    }
  }
);

// Mount route modules
app.route('/', settingsRoutes);
app.route('/', tenantsRoutes);
app.route('/', provisioningRoutes);

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
