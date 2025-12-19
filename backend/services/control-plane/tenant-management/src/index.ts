import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import {
  initDynamoDB,
  TenantRepository,
  type TenantStatus,
  type TenantTier,
  type IsolationModel,
  type ComputeType,
} from '@tenkacloud/dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { createLogger } from './lib/logger';
import { authMiddleware, requireRoles, UserRole } from './middleware/auth';
import { auditMiddleware } from './middleware/audit';

// Initialize DynamoDB
initDynamoDB({
  tableName: process.env.DYNAMODB_TABLE_NAME ?? 'TenkaCloud-dev',
  endpoint: process.env.DYNAMODB_ENDPOINT,
});

const tenantRepository = new TenantRepository();

const app = new Hono();
const appLogger = createLogger('tenant-api');

// CORS configuration - strict origin control
app.use(
  '*',
  cors({
    origin: [
      'http://localhost:3000',
      'http://localhost:3001',
      'http://localhost:3002',
      'http://localhost:3003',
      process.env.ALLOWED_ORIGIN || '',
    ].filter(Boolean),
    credentials: true,
    allowHeaders: ['Content-Type', 'Authorization'],
  })
);

// Audit logging for all API requests
app.use('/api/*', auditMiddleware);

// Authentication required for all tenant management operations
app.use(
  '/api/tenants*',
  authMiddleware,
  requireRoles(UserRole.PLATFORM_ADMIN, UserRole.TENANT_ADMIN)
);

// ULID format: 26 characters, uppercase alphanumeric
const idSchema = z
  .string()
  .length(26, 'Invalid ID format')
  .regex(/^[0-9A-Z]+$/, 'Invalid ID format');

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

// Pagination constants - DoS protection
const MAX_LIMIT = 100; // Maximum items per page

// Error response helper
function errorResponse(message: string, status: number, details?: unknown) {
  const response: { error: string; details?: unknown } = { error: message };
  // Only include error details in non-production environments to prevent information leakage
  if (details && process.env.NODE_ENV !== 'production') {
    response.details = details;
  }
  return response;
}

// Health check
app.get('/health', (c) => {
  return c.json({ status: 'ok', service: 'tenant-management' });
});

// List all tenants with pagination
app.get('/api/tenants', async (c) => {
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
});

// Get tenant by ID
app.get('/api/tenants/:id', async (c) => {
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
});

// Create new tenant
app.post('/api/tenants', async (c) => {
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
});

// Update tenant
app.patch('/api/tenants/:id', async (c) => {
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

    const tenant = await tenantRepository.update(idValidation.data, validated);

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
});

// Delete tenant
app.delete('/api/tenants/:id', async (c) => {
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
});

const port = 3004;

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
