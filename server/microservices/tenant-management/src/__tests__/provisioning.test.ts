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

const mockSettingRepoFunctions = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  listByCategory: vi.fn(),
  listAll: vi.fn(),
  delete: vi.fn(),
}));

const mockAuditLogRepoFunctions = vi.hoisted(() => ({
  create: vi.fn(),
  listByTenant: vi.fn(),
  listByUser: vi.fn(),
}));

const mockProvisioningPublisherFunctions = vi.hoisted(() => ({
  publishTenantOnboarding: vi.fn(),
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
  SystemSettingRepository: class MockSystemSettingRepository {
    get = mockSettingRepoFunctions.get;
    set = mockSettingRepoFunctions.set;
    listByCategory = mockSettingRepoFunctions.listByCategory;
    listAll = mockSettingRepoFunctions.listAll;
    delete = mockSettingRepoFunctions.delete;
  },
  AuditLogRepository: class MockAuditLogRepository {
    create = mockAuditLogRepoFunctions.create;
    listByTenant = mockAuditLogRepoFunctions.listByTenant;
    listByUser = mockAuditLogRepoFunctions.listByUser;
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
vi.mock('../middleware/auth', async () => {
  const actual = await vi.importActual('../middleware/auth');
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

vi.mock('../provisioning/publisher', () => ({
  TenantProvisioningPublisher: class MockTenantProvisioningPublisher {
    publishTenantOnboarding =
      mockProvisioningPublisherFunctions.publishTenantOnboarding;
  },
}));

import { app } from '../index';

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
    applicationDeploymentStatus: 'NOT_DEPLOYED' as const,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('プロビジョニング API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    // Set default mock returns
    mockTenantRepoFunctions.count.mockResolvedValue(0);
    mockTenantRepoFunctions.list.mockResolvedValue({
      tenants: [],
      lastKey: undefined,
    });
    mockTenantRepoFunctions.findBySlug.mockResolvedValue(null);
    mockProvisioningPublisherFunctions.publishTenantOnboarding.mockResolvedValue(
      undefined
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /api/tenants/:id/provision', () => {
    it('PENDING ステータスでも backend 未設定時は 503 を返すべき', async () => {
      const mockTenant = createMockTenant({ provisioningStatus: 'PENDING' });
      mockTenantRepoFunctions.findById.mockResolvedValue(mockTenant);

      const res = await app.request(`/api/tenants/${mockTenant.id}/provision`, {
        method: 'POST',
      });

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toBe('Provisioning is not configured in this environment');
    });

    it('FAILED ステータスでも backend 未設定時は 503 を返すべき', async () => {
      const mockTenant = createMockTenant({ provisioningStatus: 'FAILED' });
      mockTenantRepoFunctions.findById.mockResolvedValue(mockTenant);

      const res = await app.request(`/api/tenants/${mockTenant.id}/provision`, {
        method: 'POST',
      });

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toBe('Provisioning is not configured in this environment');
    });

    it('IN_PROGRESS ステータスで 409 エラーになるべき', async () => {
      const mockTenant = createMockTenant({
        provisioningStatus: 'IN_PROGRESS',
      });
      mockTenantRepoFunctions.findById.mockResolvedValue(mockTenant);

      const res = await app.request(`/api/tenants/${mockTenant.id}/provision`, {
        method: 'POST',
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe('Provisioning is already in progress');
    });

    it('COMPLETED ステータスで 409 エラーになるべき', async () => {
      const mockTenant = createMockTenant({
        provisioningStatus: 'COMPLETED',
        applicationDeploymentStatus: 'DEPLOYED',
      });
      mockTenantRepoFunctions.findById.mockResolvedValue(mockTenant);

      const res = await app.request(`/api/tenants/${mockTenant.id}/provision`, {
        method: 'POST',
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe('Tenant is already provisioned');
    });

    it('存在しないテナントで 404 エラーになるべき', async () => {
      mockTenantRepoFunctions.findById.mockResolvedValue(null);

      const nonExistentId = '01HJXK5K3VDXK5YPNZBKRT5XYZ';
      const res = await app.request(`/api/tenants/${nonExistentId}/provision`, {
        method: 'POST',
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Tenant not found');
    });

    it('不正なID形式で 400 エラーになるべき', async () => {
      const res = await app.request('/api/tenants/invalid@id!/provision', {
        method: 'POST',
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Invalid tenant ID');
    });

    it('backend 設定時は TenantOnboarding イベントを発行すべき', async () => {
      vi.stubEnv('PROVISIONING_ENABLED', 'true');
      const mockTenant = createMockTenant({ provisioningStatus: 'PENDING' });
      mockTenantRepoFunctions.findById.mockResolvedValue(mockTenant);
      mockTenantRepoFunctions.update.mockResolvedValue({
        ...mockTenant,
        provisioningStatus: 'IN_PROGRESS',
        applicationDeploymentStatus: 'DEPLOYING',
      });

      const res = await app.request(`/api/tenants/${mockTenant.id}/provision`, {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      expect(
        mockProvisioningPublisherFunctions.publishTenantOnboarding
      ).toHaveBeenCalledWith(mockTenant);
      expect(mockTenantRepoFunctions.update).toHaveBeenCalledWith(mockTenant.id, {
        provisioningStatus: 'IN_PROGRESS',
        applicationDeploymentStatus: 'DEPLOYING',
        provisioningError: null,
      });
    });

    it('イベント発行失敗時は FAILED に戻すべき', async () => {
      vi.stubEnv('PROVISIONING_ENABLED', 'true');
      const mockTenant = createMockTenant({ provisioningStatus: 'PENDING' });
      mockTenantRepoFunctions.findById.mockResolvedValue(mockTenant);
      mockTenantRepoFunctions.update.mockResolvedValueOnce({
        ...mockTenant,
        provisioningStatus: 'IN_PROGRESS',
        applicationDeploymentStatus: 'DEPLOYING',
        provisioningError: null,
      });
      mockTenantRepoFunctions.update.mockResolvedValueOnce({
        ...mockTenant,
        provisioningStatus: 'FAILED',
        applicationDeploymentStatus: 'FAILED',
        provisioningError: 'EventBridge publish failed: EventBridge unavailable',
      });
      mockProvisioningPublisherFunctions.publishTenantOnboarding.mockRejectedValueOnce(
        new Error('EventBridge unavailable')
      );

      const res = await app.request(`/api/tenants/${mockTenant.id}/provision`, {
        method: 'POST',
      });

      expect(res.status).toBe(500);
      expect(mockTenantRepoFunctions.update).toHaveBeenCalledTimes(2);
      expect(mockTenantRepoFunctions.update).toHaveBeenNthCalledWith(1, mockTenant.id, {
        provisioningStatus: 'IN_PROGRESS',
        applicationDeploymentStatus: 'DEPLOYING',
        provisioningError: null,
      });
      expect(mockTenantRepoFunctions.update).toHaveBeenCalledWith(mockTenant.id, {
        provisioningStatus: 'FAILED',
        applicationDeploymentStatus: 'FAILED',
        provisioningError: 'EventBridge publish failed: EventBridge unavailable',
      });
    });
  });

  describe('GET /api/tenants/:id/provision', () => {
    it('プロビジョニングステータスを取得できるべき', async () => {
      const mockTenant = createMockTenant({
        provisioningStatus: 'COMPLETED',
        applicationDeploymentStatus: 'NOT_DEPLOYED',
        provisionedResources: { s3Prefix: 'tenants/test/' },
        provisionedAt: new Date('2024-01-02T00:00:00.000Z'),
      });
      mockTenantRepoFunctions.findById.mockResolvedValue(mockTenant);

      const res = await app.request(`/api/tenants/${mockTenant.id}/provision`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tenantId).toBe(mockTenant.id);
      expect(body.provisioningStatus).toBe('COMPLETED');
      expect(body.applicationDeploymentStatus).toBe('NOT_DEPLOYED');
      expect(body.provisionedResources).toBeUndefined();
      expect(body.provisionedAt).toBe('2024-01-02T00:00:00.000Z');
      expect(body.provisioningEnabled).toBe(false); // Disabled in test env
    });

    it('applicationPlaneEndpoint をレスポンスに含めるべき', async () => {
      const mockTenant = createMockTenant({
        provisioningStatus: 'COMPLETED',
        applicationDeploymentStatus: 'DEPLOYED',
        applicationPlaneEndpoint: 'http://localhost:13001?tenant=test-organization',
      });
      mockTenantRepoFunctions.findById.mockResolvedValue(mockTenant);

      const res = await app.request(`/api/tenants/${mockTenant.id}/provision`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.applicationPlaneEndpoint).toBe(
        'http://localhost:13001?tenant=test-organization'
      );
    });

    it('applicationPlaneEndpoint が未設定の場合は undefined を返すべき', async () => {
      const mockTenant = createMockTenant({
        provisioningStatus: 'PENDING',
      });
      mockTenantRepoFunctions.findById.mockResolvedValue(mockTenant);

      const res = await app.request(`/api/tenants/${mockTenant.id}/provision`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.applicationPlaneEndpoint).toBeUndefined();
    });

    it('存在しないテナントで 404 エラーになるべき', async () => {
      mockTenantRepoFunctions.findById.mockResolvedValue(null);

      const nonExistentId = '01HJXK5K3VDXK5YPNZBKRT5XYZ';
      const res = await app.request(`/api/tenants/${nonExistentId}/provision`);

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Tenant not found');
    });

    it('不正なID形式で 400 エラーになるべき', async () => {
      const res = await app.request('/api/tenants/invalid@id!/provision');

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Invalid tenant ID');
    });
  });
});
