import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { prisma } from './lib/prisma';
import { Prisma } from '@prisma/client';
import { createLogger } from './lib/logger';
import { authMiddleware, requireRoles, UserRole } from './middleware/auth';
import { auditMiddleware } from './middleware/audit';

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

// Validation schemas
const uuidSchema = z.string().uuid('Invalid UUID format');

const createTenantSchema = z.object({
  name: z.string().min(1, 'Name is required').max(255),
  adminEmail: z.string().email('Invalid email format'),
  tier: z.enum(['FREE', 'PRO', 'ENTERPRISE']).default('FREE'),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'ARCHIVED']).default('ACTIVE'),
});

const updateTenantSchema = createTenantSchema.partial();

// Error response helper
function errorResponse(message: string, status: number, details?: unknown) {
  const response: { error: string; details?: unknown } = { error: message };
  if (details) {
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
    // Parse and validate pagination parameters
    const pageParam = parseInt(c.req.query('page') || '1', 10);
    const limitParam = parseInt(c.req.query('limit') || '50', 10);

    // Ensure valid values (min 1, max 100 for limit)
    const page = Math.max(1, isNaN(pageParam) ? 1 : pageParam);
    const limit = Math.min(
      100,
      Math.max(1, isNaN(limitParam) ? 50 : limitParam)
    );
    const skip = (page - 1) * limit;

    // Parallel execution for better performance
    const [total, tenants] = await Promise.all([
      prisma.tenant.count(),
      prisma.tenant.findMany({
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    // Calculate pagination metadata
    const totalPages = Math.ceil(total / limit);
    const hasNextPage = page < totalPages;
    const hasPreviousPage = page > 1;

    appLogger.info(
      { page, limit, total, tenantsCount: tenants.length },
      'Fetched tenants'
    );

    return c.json({
      data: tenants,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage,
        hasPreviousPage,
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

  // Validate UUID
  const uuidValidation = uuidSchema.safeParse(id);
  if (!uuidValidation.success) {
    return c.json(
      errorResponse('Invalid tenant ID', 400, uuidValidation.error.errors),
      400
    );
  }

  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: uuidValidation.data },
    });

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

    const tenant = await prisma.tenant.create({
      data: validated,
    });

    return c.json(tenant, 201);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json(errorResponse('Validation error', 400, error.errors), 400);
    }

    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return c.json(
        errorResponse('Tenant with this email already exists', 409),
        409
      );
    }

    appLogger.error({ error }, 'Failed to create tenant');
    return c.json(errorResponse('Failed to create tenant', 500), 500);
  }
});

// Update tenant
app.patch('/api/tenants/:id', async (c) => {
  const id = c.req.param('id');

  // Validate UUID
  const uuidValidation = uuidSchema.safeParse(id);
  if (!uuidValidation.success) {
    return c.json(
      errorResponse('Invalid tenant ID', 400, uuidValidation.error.errors),
      400
    );
  }

  try {
    const body = await c.req.json();
    const validated = updateTenantSchema.parse(body);

    const tenant = await prisma.tenant.update({
      where: { id: uuidValidation.data },
      data: validated,
    });

    return c.json(tenant);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json(errorResponse('Validation error', 400, error.errors), 400);
    }

    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2025'
    ) {
      return c.json(errorResponse('Tenant not found', 404), 404);
    }

    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return c.json(
        errorResponse('Tenant with this email already exists', 409),
        409
      );
    }

    appLogger.error({ error, tenantId: id }, 'Failed to update tenant');
    return c.json(errorResponse('Failed to update tenant', 500), 500);
  }
});

// Delete tenant
app.delete('/api/tenants/:id', async (c) => {
  const id = c.req.param('id');

  // Validate UUID
  const uuidValidation = uuidSchema.safeParse(id);
  if (!uuidValidation.success) {
    return c.json(
      errorResponse('Invalid tenant ID', 400, uuidValidation.error.errors),
      400
    );
  }

  try {
    await prisma.tenant.delete({
      where: { id: uuidValidation.data },
    });

    return c.json({ success: true, message: 'Tenant deleted successfully' });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2025'
    ) {
      return c.json(errorResponse('Tenant not found', 404), 404);
    }

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
async function gracefulShutdown(signal: string) {
  appLogger.info({ signal }, 'Received shutdown signal, closing connections');

  try {
    await prisma.$disconnect();
    appLogger.info('Database connections closed');
    process.exit(0);
  } catch (error) {
    appLogger.error({ error }, 'Error during graceful shutdown');
    process.exit(1);
  }
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
