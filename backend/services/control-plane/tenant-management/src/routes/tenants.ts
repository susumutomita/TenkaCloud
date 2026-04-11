import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { TenantRepository } from '@tenkacloud/dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { createLogger } from '../lib/logger';
import {
  idSchema,
  createTenantSchema,
  updateTenantSchema,
  TIER_ISOLATION_MODEL,
  MAX_LIMIT,
  bearerAuth,
  tenantPathParam,
  validationErrorResponse,
  unauthorizedResponse,
  forbiddenResponse,
  notFoundResponse,
  errorResponse,
} from './shared';

const tenantRepository = new TenantRepository();
const logger = createLogger('tenant-api:tenants');

const tenantsRoutes = new Hono();

tenantsRoutes.get(
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

    logger.info(
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
      logger.error({ error }, 'Failed to fetch tenants');
      return c.json(errorResponse('Failed to fetch tenants', 500), 500);
    }
  }
);

// Get tenant by ID
tenantsRoutes.get(
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
      logger.error({ error, tenantId: id }, 'Failed to fetch tenant');
      return c.json(errorResponse('Failed to fetch tenant', 500), 500);
    }
  }
);

tenantsRoutes.post(
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

      logger.error({ error }, 'Failed to create tenant');
      return c.json(errorResponse('Failed to create tenant', 500), 500);
    }
  }
);

tenantsRoutes.patch(
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
      status?: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
      tier?: 'FREE' | 'PRO' | 'ENTERPRISE';
      isolationModel?: 'POOL' | 'SILO';
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

        logger.info(
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

    logger.error({ error, tenantId: id }, 'Failed to update tenant');
    return c.json(errorResponse('Failed to update tenant', 500), 500);
  }
  }
);

tenantsRoutes.delete(
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
    logger.error({ error, tenantId: id }, 'Failed to delete tenant');
    return c.json(errorResponse('Failed to delete tenant', 500), 500);
  }
  }
);

export { tenantsRoutes };
