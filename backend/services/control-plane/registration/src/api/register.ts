import { Hono } from 'hono';
import { z } from 'zod';
import {
  initDynamoDB,
  TenantRepository,
  type ProvisioningStatus,
} from '@tenkacloud/dynamodb';
import { RegistrationService } from '../services/registration';
import { createLogger } from '../lib/logger';

// Initialize DynamoDB
initDynamoDB({
  tableName: process.env.DYNAMODB_TABLE_NAME ?? 'TenkaCloud-dev',
  endpoint: process.env.DYNAMODB_ENDPOINT,
});

const tenantRepository = new TenantRepository();

const logger = createLogger('register-api');

const registerApp = new Hono();

// Validation schema
const registerSchema = z.object({
  organizationName: z
    .string()
    .min(1, '組織名は必須です')
    .max(255, '組織名は255文字以内で入力してください'),
  adminEmail: z.string().email('有効なメールアドレスを入力してください'),
  adminName: z
    .string()
    .min(1, '管理者名は必須です')
    .max(100, '管理者名は100文字以内で入力してください'),
  tier: z.enum(['FREE', 'PRO', 'ENTERPRISE']).default('FREE'),
});

// ULID format: 26 characters, uppercase alphanumeric
const idSchema = z
  .string()
  .length(26, '無効なID形式です')
  .regex(/^[0-9A-Z]+$/, '無効なID形式です');

// Error response helper
function errorResponse(message: string, status: number, details?: unknown) {
  const response: { error: string; details?: unknown } = { error: message };
  if (details && process.env.NODE_ENV !== 'production') {
    response.details = details;
  }
  return response;
}

// POST /api/register - Create new tenant registration
registerApp.post('/', async (c) => {
  try {
    const body = await c.req.json();
    const validated = registerSchema.parse(body);

    const registrationService = new RegistrationService();
    const result = await registrationService.register(validated);

    logger.info(
      { tenantId: result.tenantId },
      '登録リクエストを受け付けました'
    );

    return c.json(result, 201);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json(
        errorResponse('バリデーションエラー', 400, error.errors),
        400
      );
    }

    // Check for duplicate email/slug constraint violation
    if (error instanceof Error && error.message.includes('既に存在します')) {
      return c.json(
        errorResponse('このメールアドレスは既に登録されています', 409),
        409
      );
    }

    logger.error({ error }, '登録処理中にエラーが発生しました');
    return c.json(errorResponse('登録処理に失敗しました', 500), 500);
  }
});

// GET /api/register/:tenantId/status - Get registration status
registerApp.get('/:tenantId/status', async (c) => {
  const tenantId = c.req.param('tenantId');

  // Validate ID format (ULID)
  const idValidation = idSchema.safeParse(tenantId);
  if (!idValidation.success) {
    return c.json(
      errorResponse('無効なテナントIDです', 400, idValidation.error.errors),
      400
    );
  }

  try {
    const tenant = await tenantRepository.findById(idValidation.data);

    if (!tenant) {
      return c.json(errorResponse('テナントが見つかりません', 404), 404);
    }

    return c.json({
      tenantId: tenant.id,
      organizationName: tenant.name,
      provisioningStatus: tenant.provisioningStatus,
      createdAt: tenant.createdAt,
      completedAt:
        tenant.provisioningStatus === 'COMPLETED' ? tenant.updatedAt : null,
    });
  } catch (error) {
    logger.error({ error, tenantId }, 'ステータス取得中にエラーが発生しました');
    return c.json(errorResponse('ステータスの取得に失敗しました', 500), 500);
  }
});

export default registerApp;
