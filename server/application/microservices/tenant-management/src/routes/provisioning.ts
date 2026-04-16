import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { TenantRepository } from '@tenkacloud/dynamodb';
import { createLogger } from '../lib/logger';
import { TenantProvisioningPublisher } from '../provisioning/publisher';
import { UserRole } from '../middleware/auth';
import {
  idSchema,
  bearerAuth,
  tenantPathParam,
  validationErrorResponse,
  unauthorizedResponse,
  forbiddenResponse,
  notFoundResponse,
  errorResponse,
} from './shared';

const tenantRepository = new TenantRepository();
const logger = createLogger('tenant-api:provisioning');

function isProvisioningEnabled(): boolean {
  return process.env.PROVISIONING_ENABLED === 'true';
}

function createProvisioningPublisher(): TenantProvisioningPublisher | null {
  return isProvisioningEnabled() ? new TenantProvisioningPublisher() : null;
}

const provisioningRoutes = new Hono();

// Trigger provisioning for a tenant
provisioningRoutes.post(
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
      503: { description: 'プロビジョニング backend 未設定' },
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
    const provisioningPublisher = createProvisioningPublisher();
    if (!provisioningPublisher) {
      logger.warn(
        { tenantId: tenant.id },
        'Provisioning requested but no provisioning backend is configured'
      );
      return c.json(
        errorResponse('Provisioning is not configured in this environment', 503),
        503
      );
    }

    logger.info({ tenantId: tenant.id }, 'Publishing tenant onboarding event');

    await tenantRepository.update(tenant.id, {
      provisioningStatus: 'IN_PROGRESS',
      applicationDeploymentStatus: 'DEPLOYING',
      provisioningError: null,
    });

    try {
      await provisioningPublisher.publishTenantOnboarding(tenant);
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? `EventBridge publish failed: ${error.message}`
          : 'Unknown error during event publishing';
      logger.error({ error, tenantId: tenant.id }, errorMessage);
      await tenantRepository.update(tenant.id, {
        provisioningStatus: 'FAILED',
        applicationDeploymentStatus: 'FAILED',
        provisioningError: errorMessage,
      });
      return c.json(errorResponse('Failed to start provisioning', 500), 500);
    }

    return c.json({
      success: true,
      message: 'Provisioning started',
      provisioningStatus: 'IN_PROGRESS',
    });
  } catch (error) {
    logger.error({ error, tenantId: id }, 'Failed to start provisioning');
    return c.json(errorResponse('Failed to start provisioning', 500), 500);
  }
  }
);

provisioningRoutes.get(
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

    const user = c.get('user') as
      | { roles?: UserRole[] }
      | undefined;
    const isPlatformAdmin =
      Array.isArray(user?.roles) &&
      user.roles.includes(UserRole.PLATFORM_ADMIN);

    return c.json({
      tenantId: tenant.id,
      provisioningStatus: tenant.provisioningStatus,
      applicationDeploymentStatus:
        tenant.applicationDeploymentStatus ?? 'NOT_DEPLOYED',
      provisionedResources: isPlatformAdmin
        ? tenant.provisionedResources
        : undefined,
      provisioningError: tenant.provisioningError,
      provisionedAt: tenant.provisionedAt?.toISOString() ?? undefined,
      provisioningEnabled: isProvisioningEnabled(),
    });
  } catch (error) {
    logger.error(
      { error, tenantId: id },
      'Failed to get provisioning status'
    );
    return c.json(errorResponse('Failed to get provisioning status', 500), 500);
  }
  }
);

export { provisioningRoutes };
