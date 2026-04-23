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

describe('テナント tier 変更ビジネスロジック', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
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

  describe('PATCH /api/tenants/:id tier変更', () => {
    it('FREE→PRO変更時はisolationModelが変わらないためre-provisioningが発生しないべき', async () => {
      const mockTenant = createMockTenant({
        tier: 'FREE',
        isolationModel: 'POOL',
        provisioningStatus: 'COMPLETED',
      });
      const updatedTenant = { ...mockTenant, tier: 'PRO' as const };
      mockTenantRepoFunctions.findById.mockResolvedValue(mockTenant);
      mockTenantRepoFunctions.update.mockResolvedValue(updatedTenant);

      const res = await app.request(`/api/tenants/${mockTenant.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier: 'PRO' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tier).toBe('PRO');
      // update should NOT include isolationModel or provisioningStatus changes
      expect(mockTenantRepoFunctions.update).toHaveBeenCalledWith(
        mockTenant.id,
        expect.not.objectContaining({
          isolationModel: expect.anything(),
          provisioningStatus: expect.anything(),
        })
      );
    });

    it('PRO→FREE変更時はisolationModelが変わらないためre-provisioningが発生しないべき', async () => {
      const mockTenant = createMockTenant({
        tier: 'PRO',
        isolationModel: 'POOL',
        provisioningStatus: 'COMPLETED',
      });
      const updatedTenant = { ...mockTenant, tier: 'FREE' as const };
      mockTenantRepoFunctions.findById.mockResolvedValue(mockTenant);
      mockTenantRepoFunctions.update.mockResolvedValue(updatedTenant);

      const res = await app.request(`/api/tenants/${mockTenant.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier: 'FREE' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tier).toBe('FREE');
      expect(mockTenantRepoFunctions.update).toHaveBeenCalledWith(
        mockTenant.id,
        expect.not.objectContaining({
          isolationModel: expect.anything(),
          provisioningStatus: expect.anything(),
        })
      );
    });

    it('FREE→ENTERPRISE変更時はPOOL→SILOに変わりre-provisioningが発生すべき', async () => {
      const mockTenant = createMockTenant({
        tier: 'FREE',
        isolationModel: 'POOL',
        provisioningStatus: 'COMPLETED',
      });
      const updatedTenant = {
        ...mockTenant,
        tier: 'ENTERPRISE' as const,
        isolationModel: 'SILO' as const,
        provisioningStatus: 'PENDING' as const,
      };
      mockTenantRepoFunctions.findById.mockResolvedValue(mockTenant);
      mockTenantRepoFunctions.update.mockResolvedValue(updatedTenant);

      const res = await app.request(`/api/tenants/${mockTenant.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier: 'ENTERPRISE' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tier).toBe('ENTERPRISE');
      expect(body.isolationModel).toBe('SILO');
      expect(body.provisioningStatus).toBe('PENDING');
      expect(mockTenantRepoFunctions.update).toHaveBeenCalledWith(
        mockTenant.id,
        {
          tier: 'ENTERPRISE',
          isolationModel: 'SILO',
          provisioningStatus: 'PENDING',
        }
      );
    });

    it('PRO→ENTERPRISE変更時はPOOL→SILOに変わりre-provisioningが発生すべき', async () => {
      const mockTenant = createMockTenant({
        tier: 'PRO',
        isolationModel: 'POOL',
        provisioningStatus: 'COMPLETED',
      });
      const updatedTenant = {
        ...mockTenant,
        tier: 'ENTERPRISE' as const,
        isolationModel: 'SILO' as const,
        provisioningStatus: 'PENDING' as const,
      };
      mockTenantRepoFunctions.findById.mockResolvedValue(mockTenant);
      mockTenantRepoFunctions.update.mockResolvedValue(updatedTenant);

      const res = await app.request(`/api/tenants/${mockTenant.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier: 'ENTERPRISE' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tier).toBe('ENTERPRISE');
      expect(body.isolationModel).toBe('SILO');
      expect(body.provisioningStatus).toBe('PENDING');
      expect(mockTenantRepoFunctions.update).toHaveBeenCalledWith(
        mockTenant.id,
        {
          tier: 'ENTERPRISE',
          isolationModel: 'SILO',
          provisioningStatus: 'PENDING',
        }
      );
    });

    it('ENTERPRISE→FREE変更時はSILO→POOLに変わりre-provisioningが発生すべき', async () => {
      const mockTenant = createMockTenant({
        tier: 'ENTERPRISE',
        isolationModel: 'SILO',
        provisioningStatus: 'COMPLETED',
      });
      const updatedTenant = {
        ...mockTenant,
        tier: 'FREE' as const,
        isolationModel: 'POOL' as const,
        provisioningStatus: 'PENDING' as const,
      };
      mockTenantRepoFunctions.findById.mockResolvedValue(mockTenant);
      mockTenantRepoFunctions.update.mockResolvedValue(updatedTenant);

      const res = await app.request(`/api/tenants/${mockTenant.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier: 'FREE' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tier).toBe('FREE');
      expect(body.isolationModel).toBe('POOL');
      expect(body.provisioningStatus).toBe('PENDING');
      expect(mockTenantRepoFunctions.update).toHaveBeenCalledWith(
        mockTenant.id,
        {
          tier: 'FREE',
          isolationModel: 'POOL',
          provisioningStatus: 'PENDING',
        }
      );
    });

    it('ENTERPRISE→PRO変更時はSILO→POOLに変わりre-provisioningが発生すべき', async () => {
      const mockTenant = createMockTenant({
        tier: 'ENTERPRISE',
        isolationModel: 'SILO',
        provisioningStatus: 'COMPLETED',
      });
      const updatedTenant = {
        ...mockTenant,
        tier: 'PRO' as const,
        isolationModel: 'POOL' as const,
        provisioningStatus: 'PENDING' as const,
      };
      mockTenantRepoFunctions.findById.mockResolvedValue(mockTenant);
      mockTenantRepoFunctions.update.mockResolvedValue(updatedTenant);

      const res = await app.request(`/api/tenants/${mockTenant.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier: 'PRO' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tier).toBe('PRO');
      expect(body.isolationModel).toBe('POOL');
      expect(body.provisioningStatus).toBe('PENDING');
      expect(mockTenantRepoFunctions.update).toHaveBeenCalledWith(
        mockTenant.id,
        {
          tier: 'PRO',
          isolationModel: 'POOL',
          provisioningStatus: 'PENDING',
        }
      );
    });

    it('tier変更時に存在しないテナントは404エラーになるべき', async () => {
      mockTenantRepoFunctions.findById.mockResolvedValue(null);

      const nonExistentId = '01HJXK5K3VDXK5YPNZBKRT5XYZ';
      const res = await app.request(`/api/tenants/${nonExistentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier: 'ENTERPRISE' }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Tenant not found');
      expect(mockTenantRepoFunctions.update).not.toHaveBeenCalled();
    });

    it('tier変更とname変更を同時に行えるべき', async () => {
      const mockTenant = createMockTenant({
        tier: 'FREE',
        isolationModel: 'POOL',
        provisioningStatus: 'COMPLETED',
      });
      const updatedTenant = {
        ...mockTenant,
        name: 'Updated Enterprise Tenant',
        tier: 'ENTERPRISE' as const,
        isolationModel: 'SILO' as const,
        provisioningStatus: 'PENDING' as const,
      };
      mockTenantRepoFunctions.findById.mockResolvedValue(mockTenant);
      mockTenantRepoFunctions.update.mockResolvedValue(updatedTenant);

      const res = await app.request(`/api/tenants/${mockTenant.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Updated Enterprise Tenant',
          tier: 'ENTERPRISE',
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('Updated Enterprise Tenant');
      expect(body.tier).toBe('ENTERPRISE');
      expect(body.isolationModel).toBe('SILO');
      expect(body.provisioningStatus).toBe('PENDING');
      expect(mockTenantRepoFunctions.update).toHaveBeenCalledWith(
        mockTenant.id,
        {
          name: 'Updated Enterprise Tenant',
          tier: 'ENTERPRISE',
          isolationModel: 'SILO',
          provisioningStatus: 'PENDING',
        }
      );
    });
  });
});
