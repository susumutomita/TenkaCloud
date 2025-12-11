import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import * as deploymentServiceModule from '../services/deployment';
import type { AuthenticatedUser } from '../middleware/auth';

vi.mock('../services/deployment');

// テスト用モックユーザー
const createMockUser = (
  overrides: Partial<AuthenticatedUser> = {}
): AuthenticatedUser => ({
  id: 'user-1',
  email: 'user@example.com',
  username: 'testuser',
  tenantId: '550e8400-e29b-41d4-a716-446655440000',
  roles: ['user'],
  ...overrides,
});

// テスト用許可されたイメージ
const ALLOWED_IMAGE = 'ghcr.io/tenkacloud/app:v1';
const ALLOWED_IMAGE_V2 = 'ghcr.io/tenkacloud/app:v2';

describe('Deployments API', () => {
  let app: Hono<{ Variables: { user: AuthenticatedUser } }>;
  let mockCreateDeployment: ReturnType<typeof vi.fn>;
  let mockGetDeploymentById: ReturnType<typeof vi.fn>;
  let mockGetDeploymentStatus: ReturnType<typeof vi.fn>;
  let mockGetDeploymentHistory: ReturnType<typeof vi.fn>;
  let mockListDeployments: ReturnType<typeof vi.fn>;
  let mockUpdateDeployment: ReturnType<typeof vi.fn>;
  let mockRollbackDeployment: ReturnType<typeof vi.fn>;
  let mockUser: AuthenticatedUser;

  beforeEach(async () => {
    vi.resetModules();

    mockCreateDeployment = vi.fn();
    mockGetDeploymentById = vi.fn();
    mockGetDeploymentStatus = vi.fn();
    mockGetDeploymentHistory = vi.fn();
    mockListDeployments = vi.fn();
    mockUpdateDeployment = vi.fn();
    mockRollbackDeployment = vi.fn();
    mockUser = createMockUser();

    vi.mocked(deploymentServiceModule.DeploymentService).mockImplementation(
      () =>
        ({
          createDeployment: mockCreateDeployment,
          getDeploymentById: mockGetDeploymentById,
          getDeploymentStatus: mockGetDeploymentStatus,
          getDeploymentHistory: mockGetDeploymentHistory,
          listDeployments: mockListDeployments,
          updateDeployment: mockUpdateDeployment,
          rollbackDeployment: mockRollbackDeployment,
        }) as unknown as deploymentServiceModule.DeploymentService
    );

    const { deploymentsRoutes } = await import('./deployments');
    app = new Hono<{ Variables: { user: AuthenticatedUser } }>();
    // ユーザーコンテキストを設定するミドルウェア
    app.use('/*', async (c, next) => {
      c.set('user', mockUser);
      await next();
    });
    app.route('/', deploymentsRoutes);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /deployments', () => {
    it('デプロイメントを作成すべき', async () => {
      const mockDeployment = {
        id: 'deploy-1',
        tenantId: '550e8400-e29b-41d4-a716-446655440000',
        tenantSlug: 'test-tenant',
        namespace: 'tenant-test-tenant',
        serviceName: 'app-service',
        image: ALLOWED_IMAGE,
        version: 'v1',
        replicas: 2,
        status: 'PENDING',
      };

      mockCreateDeployment.mockResolvedValue(mockDeployment);

      const res = await app.request('/deployments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId: '550e8400-e29b-41d4-a716-446655440000',
          tenantSlug: 'test-tenant',
          serviceName: 'app-service',
          image: ALLOWED_IMAGE,
          version: 'v1',
          replicas: 2,
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe('deploy-1');
    });

    it('許可されていないレジストリの場合、400を返すべき', async () => {
      const res = await app.request('/deployments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId: '550e8400-e29b-41d4-a716-446655440000',
          tenantSlug: 'test-tenant',
          serviceName: 'app-service',
          image: 'evil.registry.io/malicious:latest',
          version: 'v1',
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('バリデーションエラー');
      expect(body.details[0].message).toContain('許可されていないレジストリ');
    });

    it('別テナントへのデプロイは403を返すべき', async () => {
      const res = await app.request('/deployments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId: '11111111-1111-1111-1111-111111111111', // 別テナント
          tenantSlug: 'other-tenant',
          serviceName: 'app-service',
          image: ALLOWED_IMAGE,
          version: 'v1',
        }),
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain('権限エラー');
    });

    it('プラットフォーム管理者は任意のテナントにデプロイ可能', async () => {
      // tenantIdがないユーザー（プラットフォーム管理者）
      mockUser = createMockUser({
        tenantId: undefined,
        roles: ['platform-admin'],
      });

      const mockDeployment = {
        id: 'deploy-1',
        tenantId: '11111111-1111-1111-1111-111111111111',
        tenantSlug: 'other-tenant',
        status: 'PENDING',
      };
      mockCreateDeployment.mockResolvedValue(mockDeployment);

      const res = await app.request('/deployments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId: '11111111-1111-1111-1111-111111111111',
          tenantSlug: 'other-tenant',
          serviceName: 'app-service',
          image: ALLOWED_IMAGE,
          version: 'v1',
        }),
      });

      expect(res.status).toBe(201);
    });

    it('無効な JSON の場合、400を返すべき', async () => {
      const res = await app.request('/deployments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid json {',
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('無効な JSON 形式です');
    });

    it('無効なtenantIdの場合、400を返すべき', async () => {
      const res = await app.request('/deployments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId: 'invalid-uuid',
          tenantSlug: 'test-tenant',
          serviceName: 'app-service',
          image: ALLOWED_IMAGE,
          version: 'v1',
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('バリデーションエラー');
    });

    it('空のserviceNameの場合、400を返すべき', async () => {
      const res = await app.request('/deployments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId: '550e8400-e29b-41d4-a716-446655440000',
          tenantSlug: 'test-tenant',
          serviceName: '',
          image: ALLOWED_IMAGE,
          version: 'v1',
        }),
      });

      expect(res.status).toBe(400);
    });

    it('サービスエラーの場合、500を返すべき', async () => {
      mockCreateDeployment.mockRejectedValue(new Error('K8s error'));

      const res = await app.request('/deployments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId: '550e8400-e29b-41d4-a716-446655440000',
          tenantSlug: 'test-tenant',
          serviceName: 'app-service',
          image: ALLOWED_IMAGE,
          version: 'v1',
        }),
      });

      expect(res.status).toBe(500);
    });
  });

  describe('GET /deployments', () => {
    it('デプロイメント一覧を返すべき', async () => {
      const mockResult = {
        deployments: [
          {
            id: 'deploy-1',
            tenantId: '550e8400-e29b-41d4-a716-446655440000',
            tenantSlug: 'test-tenant',
            status: 'SUCCEEDED',
          },
        ],
        total: 1,
      };

      mockListDeployments.mockResolvedValue(mockResult);

      const res = await app.request(
        '/deployments?tenantId=550e8400-e29b-41d4-a716-446655440000'
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deployments).toHaveLength(1);
    });

    it('ユーザーのテナントIDでフィルタされるべき', async () => {
      mockListDeployments.mockResolvedValue({ deployments: [], total: 0 });

      await app.request('/deployments');

      // ユーザーのテナントIDが強制的に適用される
      expect(mockListDeployments).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: '550e8400-e29b-41d4-a716-446655440000',
        })
      );
    });

    it('無効なクエリパラメータの場合、400を返すべき', async () => {
      const res = await app.request('/deployments?limit=0');

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('バリデーションエラー');
    });

    it('ステータスでフィルタすべき', async () => {
      mockListDeployments.mockResolvedValue({ deployments: [], total: 0 });

      await app.request('/deployments?status=SUCCEEDED');

      expect(mockListDeployments).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'SUCCEEDED' })
      );
    });

    it('プラットフォーム管理者はクエリのtenantIdを使用すべき', async () => {
      // tenantIdがないユーザー（プラットフォーム管理者）
      mockUser = createMockUser({
        tenantId: undefined,
        roles: ['platform-admin'],
      });

      mockListDeployments.mockResolvedValue({ deployments: [], total: 0 });

      await app.request(
        '/deployments?tenantId=11111111-1111-1111-1111-111111111111'
      );

      // ユーザーのtenantIdがないので、クエリパラメータのtenantIdが使用される
      expect(mockListDeployments).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: '11111111-1111-1111-1111-111111111111',
        })
      );
    });
  });

  describe('GET /deployments/:id', () => {
    it('デプロイメントを取得すべき', async () => {
      const mockDeployment = {
        id: 'deploy-1',
        tenantId: '550e8400-e29b-41d4-a716-446655440000',
        tenantSlug: 'test-tenant',
        status: 'SUCCEEDED',
      };

      mockGetDeploymentById.mockResolvedValue(mockDeployment);

      const res = await app.request('/deployments/deploy-1');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe('deploy-1');
    });

    it('別テナントのデプロイメントは404を返すべき', async () => {
      const mockDeployment = {
        id: 'deploy-1',
        tenantId: '11111111-1111-1111-1111-111111111111', // 別テナント
        tenantSlug: 'other-tenant',
        status: 'SUCCEEDED',
      };

      mockGetDeploymentById.mockResolvedValue(mockDeployment);

      const res = await app.request('/deployments/deploy-1');

      expect(res.status).toBe(404);
    });

    it('存在しないIDの場合、404を返すべき', async () => {
      mockGetDeploymentById.mockResolvedValue(null);

      const res = await app.request('/deployments/non-existent');

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('デプロイメントが見つかりません');
    });
  });

  describe('GET /deployments/:id/status', () => {
    it('デプロイメントステータスを取得すべき', async () => {
      const mockDeployment = {
        id: 'deploy-1',
        tenantId: '550e8400-e29b-41d4-a716-446655440000',
        status: 'SUCCEEDED',
      };
      const mockStatus = {
        deployment: { id: 'deploy-1', status: 'SUCCEEDED' },
        kubernetes: {
          availableReplicas: 2,
          readyReplicas: 2,
          replicas: 2,
          updatedReplicas: 2,
        },
      };

      mockGetDeploymentById.mockResolvedValue(mockDeployment);
      mockGetDeploymentStatus.mockResolvedValue(mockStatus);

      const res = await app.request('/deployments/deploy-1/status');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deployment.id).toBe('deploy-1');
      expect(body.kubernetes.availableReplicas).toBe(2);
    });

    it('存在しないIDの場合、404を返すべき', async () => {
      mockGetDeploymentById.mockResolvedValue(null);

      const res = await app.request('/deployments/non-existent/status');

      expect(res.status).toBe(404);
    });

    it('別テナントのデプロイメントは404を返すべき', async () => {
      const mockDeployment = {
        id: 'deploy-1',
        tenantId: '11111111-1111-1111-1111-111111111111', // 別テナント
      };
      mockGetDeploymentById.mockResolvedValue(mockDeployment);

      const res = await app.request('/deployments/deploy-1/status');

      expect(res.status).toBe(404);
    });

    it('getDeploymentStatusがnullを返す場合、404を返すべき', async () => {
      const mockDeployment = {
        id: 'deploy-1',
        tenantId: '550e8400-e29b-41d4-a716-446655440000',
      };
      mockGetDeploymentById.mockResolvedValue(mockDeployment);
      mockGetDeploymentStatus.mockResolvedValue(null);

      const res = await app.request('/deployments/deploy-1/status');

      expect(res.status).toBe(404);
    });
  });

  describe('GET /deployments/:id/history', () => {
    it('デプロイメント履歴を取得すべき', async () => {
      const mockDeployment = {
        id: 'deploy-1',
        tenantId: '550e8400-e29b-41d4-a716-446655440000',
      };
      const mockHistory = [
        { id: 'history-1', status: 'PENDING', message: 'Created' },
        { id: 'history-2', status: 'SUCCEEDED', message: null },
      ];

      mockGetDeploymentById.mockResolvedValue(mockDeployment);
      mockGetDeploymentHistory.mockResolvedValue(mockHistory);

      const res = await app.request('/deployments/deploy-1/history');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.history).toHaveLength(2);
    });

    it('存在しないIDの場合、404を返すべき', async () => {
      mockGetDeploymentById.mockResolvedValue(null);

      const res = await app.request('/deployments/non-existent/history');

      expect(res.status).toBe(404);
    });

    it('別テナントのデプロイメントは404を返すべき', async () => {
      const mockDeployment = {
        id: 'deploy-1',
        tenantId: '11111111-1111-1111-1111-111111111111', // 別テナント
      };
      mockGetDeploymentById.mockResolvedValue(mockDeployment);

      const res = await app.request('/deployments/deploy-1/history');

      expect(res.status).toBe(404);
    });
  });

  describe('PUT /deployments/:id', () => {
    it('ローリングアップデートを実行すべき', async () => {
      const mockExisting = {
        id: 'deploy-1',
        tenantId: '550e8400-e29b-41d4-a716-446655440000',
        status: 'SUCCEEDED',
      };
      const mockDeployment = {
        id: 'deploy-2',
        image: ALLOWED_IMAGE_V2,
        version: 'v2',
        status: 'SUCCEEDED',
      };

      mockGetDeploymentById.mockResolvedValue(mockExisting);
      mockUpdateDeployment.mockResolvedValue(mockDeployment);

      const res = await app.request('/deployments/deploy-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: ALLOWED_IMAGE_V2,
          version: 'v2',
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.image).toBe(ALLOWED_IMAGE_V2);
    });

    it('許可されていないレジストリの場合、400を返すべき', async () => {
      const mockExisting = {
        id: 'deploy-1',
        tenantId: '550e8400-e29b-41d4-a716-446655440000',
      };
      mockGetDeploymentById.mockResolvedValue(mockExisting);

      const res = await app.request('/deployments/deploy-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: 'evil.registry.io/malicious:latest',
          version: 'v2',
        }),
      });

      expect(res.status).toBe(400);
    });

    it('無効な JSON の場合、400を返すべき', async () => {
      const mockExisting = {
        id: 'deploy-1',
        tenantId: '550e8400-e29b-41d4-a716-446655440000',
      };
      mockGetDeploymentById.mockResolvedValue(mockExisting);

      const res = await app.request('/deployments/deploy-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid json {',
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('無効な JSON 形式です');
    });

    it('無効なボディの場合、400を返すべき', async () => {
      const mockExisting = {
        id: 'deploy-1',
        tenantId: '550e8400-e29b-41d4-a716-446655440000',
      };
      mockGetDeploymentById.mockResolvedValue(mockExisting);

      const res = await app.request('/deployments/deploy-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: '',
          version: 'v2',
        }),
      });

      expect(res.status).toBe(400);
    });

    it('存在しないIDの場合、404を返すべき', async () => {
      mockGetDeploymentById.mockResolvedValue(null);

      const res = await app.request('/deployments/non-existent', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: ALLOWED_IMAGE_V2,
          version: 'v2',
        }),
      });

      expect(res.status).toBe(404);
    });

    it('別テナントのデプロイメントは404を返すべき', async () => {
      const mockExisting = {
        id: 'deploy-1',
        tenantId: '11111111-1111-1111-1111-111111111111', // 別テナント
      };
      mockGetDeploymentById.mockResolvedValue(mockExisting);

      const res = await app.request('/deployments/deploy-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: ALLOWED_IMAGE_V2,
          version: 'v2',
        }),
      });

      expect(res.status).toBe(404);
    });

    it('updateDeploymentがnullを返す場合、404を返すべき', async () => {
      const mockExisting = {
        id: 'deploy-1',
        tenantId: '550e8400-e29b-41d4-a716-446655440000',
      };
      mockGetDeploymentById.mockResolvedValue(mockExisting);
      mockUpdateDeployment.mockResolvedValue(null);

      const res = await app.request('/deployments/deploy-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: ALLOWED_IMAGE_V2,
          version: 'v2',
        }),
      });

      expect(res.status).toBe(404);
    });

    it('サービスエラーの場合、500を返すべき', async () => {
      const mockExisting = {
        id: 'deploy-1',
        tenantId: '550e8400-e29b-41d4-a716-446655440000',
      };
      mockGetDeploymentById.mockResolvedValue(mockExisting);
      mockUpdateDeployment.mockRejectedValue(new Error('K8s error'));

      const res = await app.request('/deployments/deploy-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: ALLOWED_IMAGE_V2,
          version: 'v2',
        }),
      });

      expect(res.status).toBe(500);
    });
  });

  describe('POST /deployments/:id/rollback', () => {
    it('ロールバックを実行すべき', async () => {
      const mockExisting = {
        id: 'deploy-2',
        tenantId: '550e8400-e29b-41d4-a716-446655440000',
      };
      const mockDeployment = {
        id: 'deploy-3',
        image: ALLOWED_IMAGE,
        version: 'rollback-from-v2',
        type: 'ROLLBACK',
        status: 'SUCCEEDED',
      };

      mockGetDeploymentById.mockResolvedValue(mockExisting);
      mockRollbackDeployment.mockResolvedValue(mockDeployment);

      const res = await app.request('/deployments/deploy-2/rollback', {
        method: 'POST',
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.type).toBe('ROLLBACK');
    });

    it('存在しないIDの場合、404を返すべき', async () => {
      mockGetDeploymentById.mockResolvedValue(null);

      const res = await app.request('/deployments/non-existent/rollback', {
        method: 'POST',
      });

      expect(res.status).toBe(404);
    });

    it('別テナントのデプロイメントへのロールバックは404を返すべき', async () => {
      const mockExisting = {
        id: 'deploy-1',
        tenantId: '11111111-1111-1111-1111-111111111111', // 別テナント
      };
      mockGetDeploymentById.mockResolvedValue(mockExisting);

      const res = await app.request('/deployments/deploy-1/rollback', {
        method: 'POST',
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('デプロイメントが見つかりません');
    });

    it('rollbackDeploymentがnullを返す場合、404を返すべき', async () => {
      const mockExisting = {
        id: 'deploy-1',
        tenantId: '550e8400-e29b-41d4-a716-446655440000',
      };
      mockGetDeploymentById.mockResolvedValue(mockExisting);
      mockRollbackDeployment.mockResolvedValue(null);

      const res = await app.request('/deployments/deploy-1/rollback', {
        method: 'POST',
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('デプロイメントが見つかりません');
    });

    it('previousImageがない場合、400を返すべき', async () => {
      const mockExisting = {
        id: 'deploy-1',
        tenantId: '550e8400-e29b-41d4-a716-446655440000',
      };
      mockGetDeploymentById.mockResolvedValue(mockExisting);
      mockRollbackDeployment.mockRejectedValue(
        new Error('ロールバック先のイメージがありません')
      );

      const res = await app.request('/deployments/deploy-1/rollback', {
        method: 'POST',
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('ロールバック先のイメージがありません');
    });

    it('サービスエラーの場合、500を返すべき', async () => {
      const mockExisting = {
        id: 'deploy-1',
        tenantId: '550e8400-e29b-41d4-a716-446655440000',
      };
      mockGetDeploymentById.mockResolvedValue(mockExisting);
      mockRollbackDeployment.mockRejectedValue(new Error('K8s error'));

      const res = await app.request('/deployments/deploy-1/rollback', {
        method: 'POST',
      });

      expect(res.status).toBe(500);
    });
  });
});
