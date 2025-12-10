import { Hono } from 'hono';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { UserService } from '../services/user';
import { createLogger } from '../lib/logger';

const logger = createLogger('users-api');
const userService = new UserService();

const app = new Hono();

// Schemas
const createUserSchema = z.object({
  email: z.string().email('有効なメールアドレスを入力してください'),
  name: z.string().min(1, '名前は必須です'),
  role: z.enum(['TENANT_ADMIN', 'PARTICIPANT']).optional(),
});

const listUsersSchema = z.object({
  status: z.enum(['ACTIVE', 'INACTIVE', 'PENDING']).optional(),
  role: z.enum(['TENANT_ADMIN', 'PARTICIPANT']).optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
  offset: z.coerce.number().min(0).optional(),
});

const updateRoleSchema = z.object({
  role: z.enum(['TENANT_ADMIN', 'PARTICIPANT']),
});

const uuidSchema = z.string().uuid('無効なID形式です');

// Helper to extract tenant context (from auth middleware in production)
function getTenantContext(c: any): { tenantId: string; tenantSlug: string } {
  // In production, this would come from JWT claims
  const tenantId = c.req.header('X-Tenant-ID') || '';
  const tenantSlug = c.req.header('X-Tenant-Slug') || '';
  return { tenantId, tenantSlug };
}

// POST /api/users - Create user
app.post('/', async (c) => {
  try {
    const body = await c.req.json();
    const validation = createUserSchema.safeParse(body);

    if (!validation.success) {
      return c.json(
        {
          error: 'バリデーションエラー',
          details: validation.error.errors,
        },
        400
      );
    }

    const { tenantId, tenantSlug } = getTenantContext(c);
    if (!tenantId || !tenantSlug) {
      return c.json({ error: 'テナント情報が必要です' }, 400);
    }

    const result = await userService.createUser({
      tenantId,
      tenantSlug,
      ...validation.data,
    });

    return c.json(
      {
        user: {
          id: result.user.id,
          email: result.user.email,
          name: result.user.name,
          role: result.user.role,
          status: result.user.status,
          createdAt: result.user.createdAt,
        },
        temporaryPassword: result.temporaryPassword,
        message:
          'ユーザーを作成しました。一時パスワードをユーザーに送信してください。',
      },
      201
    );
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        return c.json(
          { error: 'このメールアドレスは既に登録されています' },
          409
        );
      }
    }
    logger.error({ error }, 'ユーザー作成に失敗しました');
    return c.json({ error: 'ユーザー作成に失敗しました' }, 500);
  }
});

// GET /api/users - List users
app.get('/', async (c) => {
  try {
    const query = c.req.query();
    const validation = listUsersSchema.safeParse(query);

    if (!validation.success) {
      return c.json(
        {
          error: 'バリデーションエラー',
          details: validation.error.errors,
        },
        400
      );
    }

    const { tenantId } = getTenantContext(c);
    if (!tenantId) {
      return c.json({ error: 'テナント情報が必要です' }, 400);
    }

    const result = await userService.listUsers({
      tenantId,
      ...validation.data,
    });

    return c.json({
      users: result.users.map((user) => ({
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        status: user.status,
        createdAt: user.createdAt,
      })),
      total: result.total,
      limit: validation.data.limit ?? 50,
      offset: validation.data.offset ?? 0,
    });
  } catch (error) {
    logger.error({ error }, 'ユーザー一覧取得に失敗しました');
    return c.json({ error: 'ユーザー一覧取得に失敗しました' }, 500);
  }
});

// GET /api/users/:id - Get user by ID
app.get('/:id', async (c) => {
  try {
    const userId = c.req.param('id');
    const idValidation = uuidSchema.safeParse(userId);

    if (!idValidation.success) {
      return c.json({ error: '無効なユーザーID形式です' }, 400);
    }

    const { tenantId } = getTenantContext(c);
    if (!tenantId) {
      return c.json({ error: 'テナント情報が必要です' }, 400);
    }

    const user = await userService.getUserById(tenantId, userId);

    if (!user) {
      return c.json({ error: 'ユーザーが見つかりません' }, 404);
    }

    return c.json({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      status: user.status,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    });
  } catch (error) {
    logger.error({ error }, 'ユーザー取得に失敗しました');
    return c.json({ error: 'ユーザー取得に失敗しました' }, 500);
  }
});

// PATCH /api/users/:id/role - Update user role
app.patch('/:id/role', async (c) => {
  try {
    const userId = c.req.param('id');
    const idValidation = uuidSchema.safeParse(userId);

    if (!idValidation.success) {
      return c.json({ error: '無効なユーザーID形式です' }, 400);
    }

    const body = await c.req.json();
    const validation = updateRoleSchema.safeParse(body);

    if (!validation.success) {
      return c.json(
        {
          error: 'バリデーションエラー',
          details: validation.error.errors,
        },
        400
      );
    }

    const { tenantId } = getTenantContext(c);
    if (!tenantId) {
      return c.json({ error: 'テナント情報が必要です' }, 400);
    }

    const user = await userService.updateUserRole(
      tenantId,
      userId,
      validation.data.role
    );

    return c.json({
      id: user.id,
      role: user.role,
      message: 'ロールを更新しました',
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'ユーザーが見つかりません'
    ) {
      return c.json({ error: 'ユーザーが見つかりません' }, 404);
    }
    logger.error({ error }, 'ロール更新に失敗しました');
    return c.json({ error: 'ロール更新に失敗しました' }, 500);
  }
});

// POST /api/users/:id/password-reset - Reset password
app.post('/:id/password-reset', async (c) => {
  try {
    const userId = c.req.param('id');
    const idValidation = uuidSchema.safeParse(userId);

    if (!idValidation.success) {
      return c.json({ error: '無効なユーザーID形式です' }, 400);
    }

    const { tenantId, tenantSlug } = getTenantContext(c);
    if (!tenantId || !tenantSlug) {
      return c.json({ error: 'テナント情報が必要です' }, 400);
    }

    const temporaryPassword = await userService.resetPassword(
      tenantId,
      tenantSlug,
      userId
    );

    return c.json({
      temporaryPassword,
      message:
        'パスワードをリセットしました。一時パスワードをユーザーに送信してください。',
    });
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === 'ユーザーが見つかりません') {
        return c.json({ error: 'ユーザーが見つかりません' }, 404);
      }
      if (error.message === 'Keycloakユーザーが紐付けられていません') {
        return c.json({ error: error.message }, 400);
      }
    }
    logger.error({ error }, 'パスワードリセットに失敗しました');
    return c.json({ error: 'パスワードリセットに失敗しました' }, 500);
  }
});

// DELETE /api/users/:id - Deactivate user
app.delete('/:id', async (c) => {
  try {
    const userId = c.req.param('id');
    const idValidation = uuidSchema.safeParse(userId);

    if (!idValidation.success) {
      return c.json({ error: '無効なユーザーID形式です' }, 400);
    }

    const { tenantId, tenantSlug } = getTenantContext(c);
    if (!tenantId || !tenantSlug) {
      return c.json({ error: 'テナント情報が必要です' }, 400);
    }

    const user = await userService.deactivateUser(tenantId, tenantSlug, userId);

    return c.json({
      id: user.id,
      status: user.status,
      message: 'ユーザーを無効化しました',
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'ユーザーが見つかりません'
    ) {
      return c.json({ error: 'ユーザーが見つかりません' }, 404);
    }
    logger.error({ error }, 'ユーザー無効化に失敗しました');
    return c.json({ error: 'ユーザー無効化に失敗しました' }, 500);
  }
});

export default app;
