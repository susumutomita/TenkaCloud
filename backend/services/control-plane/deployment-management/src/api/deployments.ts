import { Hono } from 'hono';
import { z } from 'zod';
import type { DeploymentStatus } from '@prisma/client';
import { DeploymentService } from '../services/deployment';
import { createLogger } from '../lib/logger';
import type { AuthenticatedUser } from '../middleware/auth';

const logger = createLogger('deployments-api');
const deploymentsRoutes = new Hono<{
  Variables: { user: AuthenticatedUser };
}>();
const deploymentService = new DeploymentService();

// 許可されたコンテナレジストリのホワイトリスト
const ALLOWED_REGISTRIES = (
  process.env.ALLOWED_REGISTRIES ??
  'ghcr.io/tenkacloud,docker.io/tenkacloud,registry.tenkacloud.io'
).split(',');

// イメージがホワイトリストに含まれるか検証
function isAllowedImage(image: string): boolean {
  return ALLOWED_REGISTRIES.some(
    (registry) => image.startsWith(registry) || image.startsWith(`${registry}/`)
  );
}

// イメージ検証スキーマ
const imageSchema = z
  .string()
  .min(1)
  .refine(isAllowedImage, {
    message: `許可されていないレジストリです。許可: ${ALLOWED_REGISTRIES.join(', ')}`,
  });

const createDeploymentSchema = z.object({
  tenantId: z.string().uuid(),
  tenantSlug: z.string().min(1).max(63),
  serviceName: z.string().min(1).max(253),
  image: imageSchema,
  version: z.string().min(1),
  replicas: z.number().int().min(1).max(10).optional(),
});

const updateDeploymentSchema = z.object({
  image: imageSchema,
  version: z.string().min(1),
  replicas: z.number().int().min(1).max(10).optional(),
});

const listDeploymentsSchema = z.object({
  tenantId: z.string().uuid().optional(),
  tenantSlug: z.string().optional(),
  status: z
    .enum(['PENDING', 'IN_PROGRESS', 'SUCCEEDED', 'FAILED', 'ROLLED_BACK'])
    .optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
  offset: z.coerce.number().min(0).optional(),
});

// デプロイメント作成
deploymentsRoutes.post('/deployments', async (c) => {
  const user = c.get('user');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: '無効な JSON 形式です' }, 400);
  }

  const parsed = createDeploymentSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'バリデーションエラー', details: parsed.error.issues },
      400
    );
  }

  // テナント認可チェック: ユーザーのテナントIDと一致するか確認
  if (user.tenantId && user.tenantId !== parsed.data.tenantId) {
    logger.warn(
      {
        userId: user.id,
        userTenantId: user.tenantId,
        requestTenantId: parsed.data.tenantId,
      },
      'テナント認可エラー: 別テナントへのデプロイ試行'
    );
    return c.json(
      { error: '権限エラー: 指定されたテナントへのアクセス権がありません' },
      403
    );
  }

  try {
    const deployment = await deploymentService.createDeployment(parsed.data);
    return c.json(deployment, 201);
  } catch (error) {
    logger.error({ error }, 'デプロイメント作成エラー');
    throw error;
  }
});

// デプロイメント一覧
deploymentsRoutes.get('/deployments', async (c) => {
  const user = c.get('user');
  const query = c.req.query();
  const parsed = listDeploymentsSchema.safeParse(query);

  if (!parsed.success) {
    return c.json(
      { error: 'バリデーションエラー', details: parsed.error.issues },
      400
    );
  }

  // テナントスコープでフィルタリング（ユーザーが所属するテナントのみ）
  const filters = {
    ...parsed.data,
    // ユーザーのテナントIDがある場合は強制的にそのテナントでフィルタ
    tenantId: user.tenantId ?? parsed.data.tenantId,
  } as {
    tenantId?: string;
    tenantSlug?: string;
    status?: DeploymentStatus;
    limit?: number;
    offset?: number;
  };

  const result = await deploymentService.listDeployments(filters);
  return c.json(result);
});

// デプロイメント詳細
deploymentsRoutes.get('/deployments/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const deployment = await deploymentService.getDeploymentById(id);

  if (!deployment) {
    return c.json({ error: 'デプロイメントが見つかりません' }, 404);
  }

  // テナント認可チェック
  if (user.tenantId && user.tenantId !== deployment.tenantId) {
    return c.json({ error: 'デプロイメントが見つかりません' }, 404);
  }

  return c.json(deployment);
});

// デプロイメントステータス（K8s含む）
deploymentsRoutes.get('/deployments/:id/status', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');

  // 先にデプロイメントを取得してテナント認可チェック
  const deployment = await deploymentService.getDeploymentById(id);
  if (!deployment) {
    return c.json({ error: 'デプロイメントが見つかりません' }, 404);
  }
  if (user.tenantId && user.tenantId !== deployment.tenantId) {
    return c.json({ error: 'デプロイメントが見つかりません' }, 404);
  }

  const status = await deploymentService.getDeploymentStatus(id);
  if (!status) {
    return c.json({ error: 'デプロイメントが見つかりません' }, 404);
  }

  return c.json(status);
});

// デプロイメント履歴
deploymentsRoutes.get('/deployments/:id/history', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const deployment = await deploymentService.getDeploymentById(id);

  if (!deployment) {
    return c.json({ error: 'デプロイメントが見つかりません' }, 404);
  }

  // テナント認可チェック
  if (user.tenantId && user.tenantId !== deployment.tenantId) {
    return c.json({ error: 'デプロイメントが見つかりません' }, 404);
  }

  const history = await deploymentService.getDeploymentHistory(id);
  return c.json({ history });
});

// ローリングアップデート
deploymentsRoutes.put('/deployments/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');

  // 先にデプロイメントを取得してテナント認可チェック
  const existing = await deploymentService.getDeploymentById(id);
  if (!existing) {
    return c.json({ error: 'デプロイメントが見つかりません' }, 404);
  }
  if (user.tenantId && user.tenantId !== existing.tenantId) {
    return c.json({ error: 'デプロイメントが見つかりません' }, 404);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: '無効な JSON 形式です' }, 400);
  }

  const parsed = updateDeploymentSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'バリデーションエラー', details: parsed.error.issues },
      400
    );
  }

  try {
    const deployment = await deploymentService.updateDeployment(
      id,
      parsed.data
    );
    if (!deployment) {
      return c.json({ error: 'デプロイメントが見つかりません' }, 404);
    }
    return c.json(deployment);
  } catch (error) {
    logger.error({ error }, 'デプロイメント更新エラー');
    throw error;
  }
});

// ロールバック
deploymentsRoutes.post('/deployments/:id/rollback', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');

  // 先にデプロイメントを取得してテナント認可チェック
  const existing = await deploymentService.getDeploymentById(id);
  if (!existing) {
    return c.json({ error: 'デプロイメントが見つかりません' }, 404);
  }
  if (user.tenantId && user.tenantId !== existing.tenantId) {
    return c.json({ error: 'デプロイメントが見つかりません' }, 404);
  }

  try {
    const deployment = await deploymentService.rollbackDeployment(id);
    if (!deployment) {
      return c.json({ error: 'デプロイメントが見つかりません' }, 404);
    }
    return c.json(deployment, 201);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'ロールバック先のイメージがありません'
    ) {
      return c.json({ error: error.message }, 400);
    }
    logger.error({ error }, 'ロールバックエラー');
    throw error;
  }
});

export { deploymentsRoutes };
