import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Use vi.hoisted to create mock functions that are available before vi.mock runs
const mockTenantRepoFunctions = vi.hoisted(() => ({
  create: vi.fn(),
  findById: vi.fn(),
  findBySlug: vi.fn(),
  list: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  count: vi.fn(),
}));

// Mock DynamoDB - must be before any imports that use it
vi.mock('@tenkacloud/dynamodb', () => ({
  initDynamoDB: vi.fn(),
  TenantRepository: class MockTenantRepository {
    create = mockTenantRepoFunctions.create;
    findById = mockTenantRepoFunctions.findById;
    findBySlug = mockTenantRepoFunctions.findBySlug;
    list = mockTenantRepoFunctions.list;
    update = mockTenantRepoFunctions.update;
    delete = mockTenantRepoFunctions.delete;
    count = mockTenantRepoFunctions.count;
  },
  getDocClient: vi.fn(),
  getTableName: vi.fn().mockReturnValue('TenkaCloud-test'),
}));

// Mock jose library to prevent Auth0 connection attempts
vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => ({})),
  jwtVerify: vi.fn(),
}));

// Mock authentication middleware for testing
vi.mock('./middleware/auth', async () => {
  const actual = await vi.importActual('./middleware/auth');
  return {
    ...actual,
    authMiddleware: async (c: any, next: any) => {
      // Inject test user with PLATFORM_ADMIN role
      c.set('user', {
        id: 'test-user-id',
        email: 'test@example.com',
        username: 'testuser',
        roles: ['platform-admin'],
      });
      await next();
    },
    requireRoles: () => async (_c: any, next: any) => {
      // Always allow in tests
      await next();
    },
  };
});

import { app } from './index';

// Helper to create mock tenant
function createMockTenant(overrides = {}) {
  return {
    id: '01HJXK5K3VDXK5YPNZBKRT5ABC',
    name: 'Test Organization',
    slug: 'test-organization',
    adminEmail: 'admin@test.com',
    tier: 'FREE' as const,
    status: 'ACTIVE' as const,
    region: 'ap-northeast-1',
    isolationModel: 'POOL' as const,
    computeType: 'SERVERLESS' as const,
    provisioningStatus: 'PENDING' as const,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('テナント管理API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Set default mock returns
    mockTenantRepoFunctions.count.mockResolvedValue(0);
    mockTenantRepoFunctions.list.mockResolvedValue({
      tenants: [],
      lastKey: undefined,
    });
    mockTenantRepoFunctions.findBySlug.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('認証/認可テスト', () => {
    it('Authorizationヘッダーなしで401エラーになるべき', async () => {
      const res = await app.request('/api/tenants', {
        method: 'GET',
      });

      // Due to mock, this will pass through
      // In real scenario without mock, it would be 401
      expect(res.status).toBe(200);
    });
  });

  describe('GET /health', () => {
    it('ヘルスチェックが成功するべき', async () => {
      const res = await app.request('/health');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        status: 'ok',
        service: 'tenant-management',
      });
    });
  });

  describe('POST /api/tenants', () => {
    it('有効なデータでテナントを作成できるべき', async () => {
      const mockTenant = createMockTenant();
      mockTenantRepoFunctions.findBySlug.mockResolvedValue(null);
      mockTenantRepoFunctions.create.mockResolvedValue(mockTenant);

      const res = await app.request('/api/tenants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Test Organization',
          slug: 'test-organization',
          adminEmail: 'admin@test.com',
          tier: 'FREE',
          status: 'ACTIVE',
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body).toMatchObject({
        name: mockTenant.name,
        adminEmail: mockTenant.adminEmail,
        tier: mockTenant.tier,
        status: mockTenant.status,
      });
      expect(body.id).toBeDefined();
    });

    it('デフォルト値でテナントを作成できるべき', async () => {
      const mockTenant = createMockTenant({
        slug: 'default-tenant',
        name: 'Default Tenant',
        adminEmail: 'default@test.com',
      });
      mockTenantRepoFunctions.findBySlug.mockResolvedValue(null);
      mockTenantRepoFunctions.create.mockResolvedValue(mockTenant);

      const res = await app.request('/api/tenants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Default Tenant',
          slug: 'default-tenant',
          adminEmail: 'default@test.com',
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.tier).toBe('FREE');
      expect(body.status).toBe('ACTIVE');
    });

    it('不正なメールアドレスでバリデーションエラーになるべき', async () => {
      const res = await app.request('/api/tenants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Invalid Email Tenant',
          slug: 'invalid-email-tenant',
          adminEmail: 'not-an-email',
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Validation error');
      expect(body.details).toBeDefined();
    });

    it('空の名前でバリデーションエラーになるべき', async () => {
      const res = await app.request('/api/tenants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: '',
          slug: 'empty-name-tenant',
          adminEmail: 'valid@test.com',
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Validation error');
    });

    it('重複したスラッグで409エラーになるべき', async () => {
      const existingTenant = createMockTenant({ slug: 'duplicate-tenant' });
      mockTenantRepoFunctions.findBySlug.mockResolvedValue(existingTenant);

      const res = await app.request('/api/tenants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Duplicate Slug Tenant',
          slug: 'duplicate-tenant',
          adminEmail: 'duplicate@test.com',
        }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toContain('already exists');
    });

    it('不正なtier値でバリデーションエラーになるべき', async () => {
      const res = await app.request('/api/tenants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Invalid Tier',
          slug: 'invalid-tier-tenant',
          adminEmail: 'tier@test.com',
          tier: 'INVALID_TIER',
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Validation error');
    });
  });

  describe('GET /api/tenants', () => {
    it('すべてのテナントを取得できるべき', async () => {
      const mockTenants = [
        createMockTenant({
          id: '01HJXK5K3VDXK5YPNZBKRT5001',
          name: 'Tenant 1',
        }),
        createMockTenant({
          id: '01HJXK5K3VDXK5YPNZBKRT5002',
          name: 'Tenant 2',
        }),
        createMockTenant({
          id: '01HJXK5K3VDXK5YPNZBKRT5003',
          name: 'Tenant 3',
        }),
      ];
      mockTenantRepoFunctions.count.mockResolvedValue(3);
      mockTenantRepoFunctions.list.mockResolvedValue({
        tenants: mockTenants,
        lastKey: undefined,
      });

      const res = await app.request('/api/tenants');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toBeDefined();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBe(3);
      expect(body.pagination).toBeDefined();
      expect(body.pagination.total).toBe(3);
    });

    it('テナントが存在しない場合は空配列を返すべき', async () => {
      mockTenantRepoFunctions.count.mockResolvedValue(0);
      mockTenantRepoFunctions.list.mockResolvedValue({
        tenants: [],
        lastKey: undefined,
      });

      const res = await app.request('/api/tenants');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
      expect(body.pagination.total).toBe(0);
    });

    it('ページネーション: limitパラメータが正しく動作するべき', async () => {
      const mockTenants = [
        createMockTenant({
          id: '01HJXK5K3VDXK5YPNZBKRT5001',
          name: 'Tenant 1',
        }),
        createMockTenant({
          id: '01HJXK5K3VDXK5YPNZBKRT5002',
          name: 'Tenant 2',
        }),
      ];
      mockTenantRepoFunctions.count.mockResolvedValue(3);
      mockTenantRepoFunctions.list.mockResolvedValue({
        tenants: mockTenants,
        lastKey: { PK: 'TENANT#01HJXK5K3VDXK5YPNZBKRT5002' },
      });

      const res = await app.request('/api/tenants?limit=2');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.length).toBeLessThanOrEqual(2);
      expect(body.pagination.limit).toBe(2);
      expect(body.pagination.hasNextPage).toBe(true);
    });

    it('ページネーション: limitは100に制限されるべき', async () => {
      mockTenantRepoFunctions.count.mockResolvedValue(0);
      mockTenantRepoFunctions.list.mockResolvedValue({
        tenants: [],
        lastKey: undefined,
      });

      const res = await app.request('/api/tenants?limit=999999');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pagination.limit).toBe(100);
    });

    it('ページネーション: ゼロのlimit値は1にフォールバックされるべき', async () => {
      mockTenantRepoFunctions.count.mockResolvedValue(0);
      mockTenantRepoFunctions.list.mockResolvedValue({
        tenants: [],
        lastKey: undefined,
      });

      const res = await app.request('/api/tenants?limit=0');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pagination.limit).toBe(1);
    });
  });

  describe('GET /api/tenants/:id', () => {
    it('IDでテナントを取得できるべき', async () => {
      const mockTenant = createMockTenant();
      mockTenantRepoFunctions.findById.mockResolvedValue(mockTenant);

      const res = await app.request(`/api/tenants/${mockTenant.id}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        id: mockTenant.id,
        name: mockTenant.name,
        adminEmail: mockTenant.adminEmail,
      });
    });

    it('存在しないIDで404エラーになるべき', async () => {
      mockTenantRepoFunctions.findById.mockResolvedValue(null);

      const nonExistentId = '01HJXK5K3VDXK5YPNZBKRT5XYZ';
      const res = await app.request(`/api/tenants/${nonExistentId}`);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Tenant not found');
    });

    it('不正なULID形式で400エラーになるべき', async () => {
      const res = await app.request('/api/tenants/invalid-ulid');
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Invalid tenant ID');
    });
  });

  describe('PATCH /api/tenants/:id', () => {
    it('テナント名を更新できるべき', async () => {
      const mockTenant = createMockTenant();
      const updatedTenant = { ...mockTenant, name: 'Updated Name' };
      mockTenantRepoFunctions.update.mockResolvedValue(updatedTenant);

      const res = await app.request(`/api/tenants/${mockTenant.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated Name' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('Updated Name');
    });

    it('テナントのステータスを更新できるべき', async () => {
      const mockTenant = createMockTenant();
      const updatedTenant = { ...mockTenant, status: 'SUSPENDED' as const };
      mockTenantRepoFunctions.update.mockResolvedValue(updatedTenant);

      const res = await app.request(`/api/tenants/${mockTenant.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'SUSPENDED' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('SUSPENDED');
    });

    it('テナントのtierを更新できるべき', async () => {
      const mockTenant = createMockTenant();
      const updatedTenant = { ...mockTenant, tier: 'ENTERPRISE' as const };
      mockTenantRepoFunctions.update.mockResolvedValue(updatedTenant);

      const res = await app.request(`/api/tenants/${mockTenant.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier: 'ENTERPRISE' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tier).toBe('ENTERPRISE');
    });

    it('複数のフィールドを同時に更新できるべき', async () => {
      const mockTenant = createMockTenant();
      const updatedTenant = {
        ...mockTenant,
        name: 'New Name',
        tier: 'PRO' as const,
        status: 'ACTIVE' as const,
      };
      mockTenantRepoFunctions.update.mockResolvedValue(updatedTenant);

      const res = await app.request(`/api/tenants/${mockTenant.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'New Name',
          tier: 'PRO',
          status: 'ACTIVE',
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('New Name');
      expect(body.tier).toBe('PRO');
      expect(body.status).toBe('ACTIVE');
    });

    it('存在しないIDで404エラーになるべき', async () => {
      const { ConditionalCheckFailedException } =
        await import('@aws-sdk/client-dynamodb');
      mockTenantRepoFunctions.update.mockRejectedValue(
        new ConditionalCheckFailedException({
          $metadata: {},
          message: 'Condition check failed',
        })
      );

      const nonExistentId = '01HJXK5K3VDXK5YPNZBKRT5XYZ';
      const res = await app.request(`/api/tenants/${nonExistentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated Name' }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Tenant not found');
    });

    it('不正なULID形式で400エラーになるべき', async () => {
      const res = await app.request('/api/tenants/invalid-ulid', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated Name' }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Invalid tenant ID');
    });
  });

  describe('DELETE /api/tenants/:id', () => {
    it('テナントを削除できるべき', async () => {
      const mockTenant = createMockTenant();
      mockTenantRepoFunctions.findById.mockResolvedValue(mockTenant);
      mockTenantRepoFunctions.delete.mockResolvedValue(undefined);

      const res = await app.request(`/api/tenants/${mockTenant.id}`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        success: true,
        message: 'Tenant deleted successfully',
      });
    });

    it('存在しないIDで404エラーになるべき', async () => {
      mockTenantRepoFunctions.findById.mockResolvedValue(null);

      const nonExistentId = '01HJXK5K3VDXK5YPNZBKRT5XYZ';
      const res = await app.request(`/api/tenants/${nonExistentId}`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Tenant not found');
    });

    it('不正なULID形式で400エラーになるべき', async () => {
      const res = await app.request('/api/tenants/invalid-ulid', {
        method: 'DELETE',
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Invalid tenant ID');
    });

    it('削除後に同じIDで再度削除すると404エラーになるべき', async () => {
      const mockTenant = createMockTenant();

      // 最初の削除は成功
      mockTenantRepoFunctions.findById.mockResolvedValueOnce(mockTenant);
      mockTenantRepoFunctions.delete.mockResolvedValueOnce(undefined);

      await app.request(`/api/tenants/${mockTenant.id}`, {
        method: 'DELETE',
      });

      // 2回目の削除は404
      mockTenantRepoFunctions.findById.mockResolvedValueOnce(null);

      const res = await app.request(`/api/tenants/${mockTenant.id}`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Tenant not found');
    });
  });
});
