import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock DynamoDB - define mocks inside factory to avoid hoisting issues
vi.mock('@tenkacloud/dynamodb', () => {
  const mockUserRepoFunctions = {
    create: vi.fn(),
    findById: vi.fn(),
    findByEmail: vi.fn(),
    findByTenantAndEmail: vi.fn(),
    listByTenant: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    countByTenant: vi.fn(),
  };

  const mockTenantRepoFunctions = {
    findById: vi.fn(),
  };

  return {
    initDynamoDB: vi.fn(),
    UserRepository: vi.fn().mockImplementation(() => mockUserRepoFunctions),
    TenantRepository: vi.fn().mockImplementation(() => mockTenantRepoFunctions),
    __mockUserRepo: mockUserRepoFunctions,
    __mockTenantRepo: mockTenantRepoFunctions,
  };
});

// Mock Auth0 - define mocks inside factory
vi.mock('../lib/auth0', () => {
  const mockAuth0 = {
    createAuth0User: vi.fn(),
    resetAuth0Password: vi.fn(),
    disableAuth0User: vi.fn(),
    deleteAuth0User: vi.fn(),
  };

  return {
    ...mockAuth0,
    __mockAuth0: mockAuth0,
  };
});

// Import after mocks are set up
import { app } from '../index';
import * as dynamodbModule from '@tenkacloud/dynamodb';
import * as auth0Module from '../lib/auth0';

// Get mock references - these are now accessible after import
const mockUserRepoFunctions = (
  dynamodbModule as typeof dynamodbModule & {
    __mockUserRepo: typeof dynamodbModule.__mockUserRepo;
  }
).__mockUserRepo as {
  create: ReturnType<typeof vi.fn>;
  findById: ReturnType<typeof vi.fn>;
  findByEmail: ReturnType<typeof vi.fn>;
  findByTenantAndEmail: ReturnType<typeof vi.fn>;
  listByTenant: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  countByTenant: ReturnType<typeof vi.fn>;
};

const mockTenantRepoFunctions = (
  dynamodbModule as typeof dynamodbModule & {
    __mockTenantRepo: { findById: ReturnType<typeof vi.fn> };
  }
).__mockTenantRepo;

const mockAuth0Functions = (
  auth0Module as typeof auth0Module & {
    __mockAuth0: typeof auth0Module.__mockAuth0;
  }
).__mockAuth0 as {
  createAuth0User: ReturnType<typeof vi.fn>;
  resetAuth0Password: ReturnType<typeof vi.fn>;
  disableAuth0User: ReturnType<typeof vi.fn>;
  deleteAuth0User: ReturnType<typeof vi.fn>;
};

// ULID format test IDs (26 uppercase alphanumeric characters)
const mockTenantId = '01HY6CPMD9K2G8XNQR7VT3JHAB';
const mockTenantSlug = 'test-tenant';
const mockUserId = '01HY6CPMD9K2G8XNQR7VT3JHCD';

function createRequest(path: string, options: RequestInit = {}): Request {
  const headers = new Headers(options.headers);
  headers.set('X-Tenant-ID', mockTenantId);
  headers.set('X-Tenant-Slug', mockTenantSlug);
  return new Request(`http://localhost${path}`, {
    ...options,
    headers,
  });
}

describe('ユーザー管理API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // デフォルトでテナント検証が成功するようモック
    mockTenantRepoFunctions.findById.mockResolvedValue({
      id: mockTenantId,
      slug: mockTenantSlug,
      name: 'Test Tenant',
      status: 'ACTIVE',
      tier: 'FREE',
      adminEmail: 'admin@example.com',
      region: 'ap-northeast-1',
      isolationModel: 'POOL',
      computeType: 'SERVERLESS',
      provisioningStatus: 'COMPLETED',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Default Auth0 mock
    mockAuth0Functions.createAuth0User.mockResolvedValue({
      auth0Id: 'auth0|mock-id',
      temporaryPassword: 'TempPass123!',
    });
    mockAuth0Functions.resetAuth0Password.mockResolvedValue('NewTempPass456!');
    mockAuth0Functions.disableAuth0User.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /api/users', () => {
    it('有効なリクエストで新規ユーザーを作成すべき', async () => {
      const mockUser = {
        id: mockUserId,
        tenantId: mockTenantId,
        email: 'user@example.com',
        name: 'テストユーザー',
        role: 'PARTICIPANT' as const,
        status: 'PENDING' as const,
        auth0Id: 'auth0|mock-id',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockUserRepoFunctions.findByTenantAndEmail.mockResolvedValue(null);
      mockUserRepoFunctions.create.mockResolvedValue({
        ...mockUser,
        auth0Id: undefined,
      });
      mockUserRepoFunctions.update.mockResolvedValue(mockUser);

      const res = await app.request(
        createRequest('/api/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: 'user@example.com',
            name: 'テストユーザー',
          }),
        })
      );

      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.user.id).toBe(mockUser.id);
      expect(body.user.email).toBe('user@example.com');
      expect(body.temporaryPassword).toBe('TempPass123!');
      expect(body.message).toContain('ユーザーを作成しました');
    });

    it('TENANT_ADMINロールを指定できるべき', async () => {
      const mockUser = {
        id: mockUserId,
        tenantId: mockTenantId,
        email: 'admin@example.com',
        name: '管理者',
        role: 'TENANT_ADMIN' as const,
        status: 'PENDING' as const,
        auth0Id: 'auth0|mock-id',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockUserRepoFunctions.findByTenantAndEmail.mockResolvedValue(null);
      mockUserRepoFunctions.create.mockResolvedValue({
        ...mockUser,
        auth0Id: undefined,
      });
      mockUserRepoFunctions.update.mockResolvedValue(mockUser);

      const res = await app.request(
        createRequest('/api/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: 'admin@example.com',
            name: '管理者',
            role: 'TENANT_ADMIN',
          }),
        })
      );

      expect(res.status).toBe(201);

      expect(mockUserRepoFunctions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'TENANT_ADMIN',
        })
      );
    });

    it('メールアドレスが空の場合はバリデーションエラーを返すべき', async () => {
      const res = await app.request(
        createRequest('/api/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: '',
            name: 'テストユーザー',
          }),
        })
      );

      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toBe('バリデーションエラー');
    });

    it('無効なメールアドレスの場合はバリデーションエラーを返すべき', async () => {
      const res = await app.request(
        createRequest('/api/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: 'invalid-email',
            name: 'テストユーザー',
          }),
        })
      );

      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toBe('バリデーションエラー');
    });

    it('名前が空の場合はバリデーションエラーを返すべき', async () => {
      const res = await app.request(
        createRequest('/api/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: 'user@example.com',
            name: '',
          }),
        })
      );

      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toBe('バリデーションエラー');
    });

    it('重複するメールアドレスの場合は409エラーを返すべき', async () => {
      mockUserRepoFunctions.findByTenantAndEmail.mockResolvedValue({
        id: mockUserId,
        email: 'existing@example.com',
      });

      const res = await app.request(
        createRequest('/api/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: 'existing@example.com',
            name: '既存ユーザー',
          }),
        })
      );

      expect(res.status).toBe(409);

      const body = await res.json();
      expect(body.error).toContain('既に登録されています');
    });

    it('テナント情報がない場合は400エラーを返すべき', async () => {
      const res = await app.request('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'user@example.com',
          name: 'テストユーザー',
        }),
      });

      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toContain('テナント情報');
    });

    it('サーバーエラーの場合は500を返すべき', async () => {
      mockUserRepoFunctions.findByTenantAndEmail.mockResolvedValue(null);
      mockUserRepoFunctions.create.mockRejectedValue(
        new Error('DB connection failed')
      );

      const res = await app.request(
        createRequest('/api/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: 'user@example.com',
            name: 'テストユーザー',
          }),
        })
      );

      expect(res.status).toBe(500);

      const body = await res.json();
      expect(body.error).toContain('失敗しました');
    });

    it('DB作成失敗時にAuth0ロールバックも失敗した場合でも500を返すべき', async () => {
      mockUserRepoFunctions.findByTenantAndEmail.mockResolvedValue(null);
      mockUserRepoFunctions.create.mockRejectedValue(
        new Error('DB connection failed')
      );
      mockAuth0Functions.deleteAuth0User.mockRejectedValue(
        new Error('Auth0 delete failed')
      );

      const res = await app.request(
        createRequest('/api/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: 'user@example.com',
            name: 'テストユーザー',
          }),
        })
      );

      expect(res.status).toBe(500);

      const body = await res.json();
      expect(body.error).toContain('失敗しました');
      // Auth0 ロールバックが呼ばれたことを確認
      expect(mockAuth0Functions.deleteAuth0User).toHaveBeenCalled();
    });

    it('テナントが見つからない場合は500を返すべき', async () => {
      mockTenantRepoFunctions.findById.mockResolvedValue(null);

      const res = await app.request(
        createRequest('/api/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: 'user@example.com',
            name: 'テストユーザー',
          }),
        })
      );

      expect(res.status).toBe(500);
    });

    it('テナント slug が不一致の場合は500を返すべき（クロステナント攻撃防止）', async () => {
      // 攻撃者が X-Tenant-Slug を改ざんした場合
      mockTenantRepoFunctions.findById.mockResolvedValue({
        id: mockTenantId,
        slug: 'actual-tenant-slug', // 実際の slug は異なる
      });

      const res = await app.request(
        createRequest('/api/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: 'user@example.com',
            name: 'テストユーザー',
          }),
        })
      );

      expect(res.status).toBe(500);
    });
  });

  describe('GET /api/users', () => {
    it('テナント情報がない場合は400エラーを返すべき', async () => {
      const res = await app.request('/api/users');

      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toContain('テナント情報');
    });

    it('ユーザー一覧を取得すべき', async () => {
      const mockUsers = [
        {
          id: '01HY6CPMD9K2G8XNQR7VT3JH01',
          tenantId: mockTenantId,
          email: 'user1@example.com',
          name: 'ユーザー1',
          role: 'PARTICIPANT' as const,
          status: 'ACTIVE' as const,
          auth0Id: 'auth0|1',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: '01HY6CPMD9K2G8XNQR7VT3JH02',
          tenantId: mockTenantId,
          email: 'user2@example.com',
          name: 'ユーザー2',
          role: 'TENANT_ADMIN' as const,
          status: 'ACTIVE' as const,
          auth0Id: 'auth0|2',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      mockUserRepoFunctions.listByTenant.mockResolvedValue({
        users: mockUsers,
        lastKey: undefined,
      });
      mockUserRepoFunctions.countByTenant.mockResolvedValue(2);

      const res = await app.request(createRequest('/api/users'));

      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.users).toHaveLength(2);
      expect(body.total).toBe(2);
    });

    it('ステータスでフィルタリングできるべき', async () => {
      mockUserRepoFunctions.listByTenant.mockResolvedValue({
        users: [],
        lastKey: undefined,
      });
      mockUserRepoFunctions.countByTenant.mockResolvedValue(0);

      const res = await app.request(createRequest('/api/users?status=ACTIVE'));

      expect(res.status).toBe(200);

      expect(mockUserRepoFunctions.listByTenant).toHaveBeenCalledWith(
        mockTenantId,
        expect.objectContaining({
          status: 'ACTIVE',
        })
      );
    });

    it('ロールでフィルタリングできるべき', async () => {
      mockUserRepoFunctions.listByTenant.mockResolvedValue({
        users: [],
        lastKey: undefined,
      });
      mockUserRepoFunctions.countByTenant.mockResolvedValue(0);

      const res = await app.request(
        createRequest('/api/users?role=TENANT_ADMIN')
      );

      expect(res.status).toBe(200);

      expect(mockUserRepoFunctions.listByTenant).toHaveBeenCalledWith(
        mockTenantId,
        expect.objectContaining({
          role: 'TENANT_ADMIN',
        })
      );
    });

    it('ページネーションをサポートすべき', async () => {
      mockUserRepoFunctions.listByTenant.mockResolvedValue({
        users: [],
        lastKey: { PK: 'test', SK: 'test' },
      });
      mockUserRepoFunctions.countByTenant.mockResolvedValue(100);

      const res = await app.request(createRequest('/api/users?limit=10'));

      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.pagination.limit).toBe(10);
      expect(body.pagination.hasNextPage).toBe(true);

      expect(mockUserRepoFunctions.listByTenant).toHaveBeenCalledWith(
        mockTenantId,
        expect.objectContaining({
          limit: 10,
        })
      );
    });

    it('サーバーエラーの場合は500を返すべき', async () => {
      mockUserRepoFunctions.listByTenant.mockRejectedValue(
        new Error('DB connection failed')
      );

      const res = await app.request(createRequest('/api/users'));

      expect(res.status).toBe(500);

      const body = await res.json();
      expect(body.error).toContain('失敗しました');
    });

    it('無効なステータスの場合はバリデーションエラーを返すべき', async () => {
      const res = await app.request(
        createRequest('/api/users?status=INVALID_STATUS')
      );

      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toBe('バリデーションエラー');
    });

    it('無効なlimit値の場合はバリデーションエラーを返すべき', async () => {
      const res = await app.request(createRequest('/api/users?limit=0'));

      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toBe('バリデーションエラー');
    });

    it('無効なlastKey形式の場合は400エラーを返すべき', async () => {
      const res = await app.request(
        createRequest('/api/users?lastKey=invalid-json-format')
      );

      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toBe('無効なlastKey形式です');
    });
  });

  describe('GET /api/users/:id', () => {
    it('テナント情報がない場合は400エラーを返すべき', async () => {
      const res = await app.request(`/api/users/${mockUserId}`);

      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toContain('テナント情報');
    });

    it('ユーザー詳細を取得すべき', async () => {
      const mockUser = {
        id: mockUserId,
        tenantId: mockTenantId,
        email: 'user@example.com',
        name: 'テストユーザー',
        role: 'PARTICIPANT' as const,
        status: 'ACTIVE' as const,
        auth0Id: 'auth0|1',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockUserRepoFunctions.findById.mockResolvedValue(mockUser);

      const res = await app.request(createRequest(`/api/users/${mockUserId}`));

      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.id).toBe(mockUser.id);
      expect(body.email).toBe('user@example.com');
    });

    it('存在しないユーザーの場合は404を返すべき', async () => {
      mockUserRepoFunctions.findById.mockResolvedValue(null);

      const res = await app.request(
        createRequest('/api/users/01HY6CPMD9K2G8XNQR7VT3JHXX')
      );

      expect(res.status).toBe(404);

      const body = await res.json();
      expect(body.error).toContain('見つかりません');
    });

    it('無効なULID形式の場合は400を返すべき', async () => {
      const res = await app.request(createRequest('/api/users/invalid-ulid'));

      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toContain('無効な');
    });

    it('サーバーエラーの場合は500を返すべき', async () => {
      mockUserRepoFunctions.findById.mockRejectedValue(
        new Error('DB connection failed')
      );

      const res = await app.request(createRequest(`/api/users/${mockUserId}`));

      expect(res.status).toBe(500);

      const body = await res.json();
      expect(body.error).toContain('失敗しました');
    });
  });

  describe('PATCH /api/users/:id/role', () => {
    it('テナント情報がない場合は400エラーを返すべき', async () => {
      const res = await app.request(`/api/users/${mockUserId}/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'TENANT_ADMIN' }),
      });

      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toContain('テナント情報');
    });

    it('無効なULID形式の場合は400を返すべき', async () => {
      const res = await app.request(
        createRequest('/api/users/invalid-ulid/role', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: 'TENANT_ADMIN' }),
        })
      );

      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toContain('無効な');
    });

    it('別テナントのユーザーの場合は404を返すべき', async () => {
      // ユーザーが別のテナントに属している場合
      mockUserRepoFunctions.findById.mockResolvedValue({
        id: mockUserId,
        tenantId: '01HY6CPMD9K2G8XNQR7VT3JXXX', // Different tenant
        email: 'user@example.com',
        name: 'Test User',
        role: 'PARTICIPANT',
        status: 'ACTIVE',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const res = await app.request(
        createRequest(`/api/users/${mockUserId}/role`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: 'TENANT_ADMIN' }),
        })
      );

      expect(res.status).toBe(404);

      const body = await res.json();
      expect(body.error).toContain('見つかりません');
    });

    it('ユーザーロールを更新すべき', async () => {
      const mockUser = {
        id: mockUserId,
        tenantId: mockTenantId,
        email: 'user@example.com',
        name: 'テストユーザー',
        role: 'PARTICIPANT' as const,
        status: 'ACTIVE' as const,
        auth0Id: 'auth0|1',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const updatedUser = { ...mockUser, role: 'TENANT_ADMIN' as const };

      mockUserRepoFunctions.findById.mockResolvedValue(mockUser);
      mockUserRepoFunctions.update.mockResolvedValue(updatedUser);

      const res = await app.request(
        createRequest(`/api/users/${mockUserId}/role`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: 'TENANT_ADMIN' }),
        })
      );

      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.role).toBe('TENANT_ADMIN');
      expect(body.message).toContain('ロールを更新しました');
    });

    it('無効なロールの場合はバリデーションエラーを返すべき', async () => {
      const res = await app.request(
        createRequest(`/api/users/${mockUserId}/role`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: 'INVALID_ROLE' }),
        })
      );

      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toBe('バリデーションエラー');
    });

    it('サーバーエラーの場合は500を返すべき', async () => {
      mockUserRepoFunctions.findById.mockRejectedValue(
        new Error('DB connection failed')
      );

      const res = await app.request(
        createRequest(`/api/users/${mockUserId}/role`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: 'TENANT_ADMIN' }),
        })
      );

      expect(res.status).toBe(500);

      const body = await res.json();
      expect(body.error).toContain('失敗しました');
    });
  });

  describe('POST /api/users/:id/password-reset', () => {
    it('テナント情報がない場合は400エラーを返すべき', async () => {
      const res = await app.request(`/api/users/${mockUserId}/password-reset`, {
        method: 'POST',
      });

      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toContain('テナント情報');
    });

    it('無効なULID形式の場合は400を返すべき', async () => {
      const res = await app.request(
        createRequest('/api/users/invalid-ulid/password-reset', {
          method: 'POST',
        })
      );

      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toContain('無効な');
    });

    it('パスワードをリセットすべき', async () => {
      const mockUser = {
        id: mockUserId,
        tenantId: mockTenantId,
        email: 'user@example.com',
        name: 'テストユーザー',
        role: 'PARTICIPANT' as const,
        status: 'ACTIVE' as const,
        auth0Id: 'auth0|1',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockUserRepoFunctions.findById.mockResolvedValue(mockUser);

      const res = await app.request(
        createRequest(`/api/users/${mockUserId}/password-reset`, {
          method: 'POST',
        })
      );

      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.temporaryPassword).toBe('NewTempPass456!');
      expect(body.message).toContain('パスワードをリセットしました');
    });

    it('存在しないユーザーの場合は404を返すべき', async () => {
      mockUserRepoFunctions.findById.mockResolvedValue(null);

      const res = await app.request(
        createRequest(`/api/users/${mockUserId}/password-reset`, {
          method: 'POST',
        })
      );

      expect(res.status).toBe(404);

      const body = await res.json();
      expect(body.error).toContain('見つかりません');
    });

    it('Auth0に紐付けられていないユーザーの場合は400を返すべき', async () => {
      const mockUser = {
        id: mockUserId,
        tenantId: mockTenantId,
        email: 'user@example.com',
        name: 'テストユーザー',
        role: 'PARTICIPANT' as const,
        status: 'ACTIVE' as const,
        auth0Id: undefined,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockUserRepoFunctions.findById.mockResolvedValue(mockUser);

      const res = await app.request(
        createRequest(`/api/users/${mockUserId}/password-reset`, {
          method: 'POST',
        })
      );

      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toContain('Auth0');
    });

    it('サーバーエラーの場合は500を返すべき', async () => {
      mockUserRepoFunctions.findById.mockRejectedValue(
        new Error('DB connection failed')
      );

      const res = await app.request(
        createRequest(`/api/users/${mockUserId}/password-reset`, {
          method: 'POST',
        })
      );

      expect(res.status).toBe(500);

      const body = await res.json();
      expect(body.error).toContain('失敗しました');
    });

    it('テナント slug が不一致の場合は500を返すべき（クロステナント攻撃防止）', async () => {
      mockTenantRepoFunctions.findById.mockResolvedValue({
        id: mockTenantId,
        slug: 'different-slug',
      });

      const res = await app.request(
        createRequest(`/api/users/${mockUserId}/password-reset`, {
          method: 'POST',
        })
      );

      expect(res.status).toBe(500);
    });
  });

  describe('DELETE /api/users/:id', () => {
    it('テナント情報がない場合は400エラーを返すべき', async () => {
      const res = await app.request(`/api/users/${mockUserId}`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toContain('テナント情報');
    });

    it('無効なULID形式の場合は400を返すべき', async () => {
      const res = await app.request(
        createRequest('/api/users/invalid-ulid', {
          method: 'DELETE',
        })
      );

      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toContain('無効な');
    });

    it('ユーザーを無効化すべき', async () => {
      const mockUser = {
        id: mockUserId,
        tenantId: mockTenantId,
        email: 'user@example.com',
        name: 'テストユーザー',
        role: 'PARTICIPANT' as const,
        status: 'ACTIVE' as const,
        auth0Id: 'auth0|1',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const updatedUser = { ...mockUser, status: 'INACTIVE' as const };

      mockUserRepoFunctions.findById.mockResolvedValue(mockUser);
      mockUserRepoFunctions.update.mockResolvedValue(updatedUser);

      const res = await app.request(
        createRequest(`/api/users/${mockUserId}`, {
          method: 'DELETE',
        })
      );

      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.status).toBe('INACTIVE');
      expect(body.message).toContain('無効化しました');
    });

    it('存在しないユーザーの場合は404を返すべき', async () => {
      mockUserRepoFunctions.findById.mockResolvedValue(null);

      const res = await app.request(
        createRequest(`/api/users/${mockUserId}`, {
          method: 'DELETE',
        })
      );

      expect(res.status).toBe(404);

      const body = await res.json();
      expect(body.error).toContain('見つかりません');
    });

    it('Auth0に紐付けられていないユーザーも無効化できるべき', async () => {
      const mockUser = {
        id: mockUserId,
        tenantId: mockTenantId,
        email: 'user@example.com',
        name: 'テストユーザー',
        role: 'PARTICIPANT' as const,
        status: 'ACTIVE' as const,
        auth0Id: undefined,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const updatedUser = { ...mockUser, status: 'INACTIVE' as const };

      mockUserRepoFunctions.findById.mockResolvedValue(mockUser);
      mockUserRepoFunctions.update.mockResolvedValue(updatedUser);

      const res = await app.request(
        createRequest(`/api/users/${mockUserId}`, {
          method: 'DELETE',
        })
      );

      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.status).toBe('INACTIVE');
    });

    it('サーバーエラーの場合は500を返すべき', async () => {
      mockUserRepoFunctions.findById.mockRejectedValue(
        new Error('DB connection failed')
      );

      const res = await app.request(
        createRequest(`/api/users/${mockUserId}`, {
          method: 'DELETE',
        })
      );

      expect(res.status).toBe(500);

      const body = await res.json();
      expect(body.error).toContain('失敗しました');
    });

    it('テナント slug が不一致の場合は500を返すべき（クロステナント攻撃防止）', async () => {
      mockTenantRepoFunctions.findById.mockResolvedValue({
        id: mockTenantId,
        slug: 'different-slug',
      });

      const res = await app.request(
        createRequest(`/api/users/${mockUserId}`, {
          method: 'DELETE',
        })
      );

      expect(res.status).toBe(500);
    });
  });

  describe('GET /health', () => {
    it('ヘルスチェックエンドポイントが正常に動作すべき', async () => {
      const res = await app.request('/health');

      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.status).toBe('ok');
      expect(body.service).toBe('user-management');
    });
  });
});
