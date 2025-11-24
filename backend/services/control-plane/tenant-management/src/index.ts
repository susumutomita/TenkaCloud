import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { z } from 'zod';
import { prisma } from './lib/prisma';
import { Prisma } from '@prisma/client';

const app = new Hono();

// Logging middleware
app.use('*', logger());

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
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
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
  return {
    error: message,
    ...(details && { details }),
  };
}

// Health check
app.get('/health', (c) => {
  return c.json({ status: 'ok', service: 'tenant-management' });
});

// List all tenants
app.get('/api/tenants', async (c) => {
  try {
    const tenants = await prisma.tenant.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return c.json(tenants);
  } catch (error) {
    console.error('[GET /api/tenants] Error:', error);
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
    console.error(`[GET /api/tenants/${id}] Error:`, error);
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

    console.error('[POST /api/tenants] Error:', error);
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

    console.error(`[PATCH /api/tenants/${id}] Error:`, error);
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

    console.error(`[DELETE /api/tenants/${id}] Error:`, error);
    return c.json(errorResponse('Failed to delete tenant', 500), 500);
  }
});

const port = 3004;

// Only log when not in test environment
if (process.env.NODE_ENV !== 'test') {
  console.log(`🚀 Tenant Management API is running on port ${port}`);
}

// Export app for testing
export { app };

export default {
  port,
  fetch: app.fetch,
  hostname: '0.0.0.0',
};
