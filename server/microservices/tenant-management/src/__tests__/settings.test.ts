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

describe('Settings & Activities API', () => {
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

  describe('GET /api/settings', () => {
    it('デフォルト設定を返すべき（設定が未保存の場合）', async () => {
      mockSettingRepoFunctions.get.mockResolvedValue(null);

      const res = await app.request('/api/settings');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        platform: {
          platformName: 'TenkaCloud',
          language: 'ja',
          timezone: 'Asia/Tokyo',
        },
        security: {
          mfaRequired: false,
          sessionTimeoutMinutes: 60,
          maxLoginAttempts: 5,
        },
        notifications: {
          emailNotificationsEnabled: true,
          systemAlertsEnabled: true,
          maintenanceNotificationsEnabled: true,
        },
        appearance: {
          theme: 'system',
        },
      });
    });

    it('保存された設定を返すべき', async () => {
      const savedSettings = {
        platform: {
          platformName: 'Custom Platform',
          language: 'en',
          timezone: 'UTC',
        },
        security: {
          mfaRequired: true,
          sessionTimeoutMinutes: 30,
          maxLoginAttempts: 3,
        },
        notifications: {
          emailNotificationsEnabled: false,
          systemAlertsEnabled: true,
          maintenanceNotificationsEnabled: false,
        },
        appearance: { theme: 'dark' },
      };

      mockSettingRepoFunctions.get.mockImplementation(async (key: string) => {
        const categoryMap: Record<string, unknown> = {
          platform: savedSettings.platform,
          security: savedSettings.security,
          notifications: savedSettings.notifications,
          appearance: savedSettings.appearance,
        };
        return categoryMap[key]
          ? { key, value: JSON.stringify(categoryMap[key]), category: 'system' }
          : null;
      });

      const res = await app.request('/api/settings');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual(savedSettings);
    });
  });

  describe('PUT /api/settings', () => {
    it('設定を保存できるべき', async () => {
      mockSettingRepoFunctions.set.mockResolvedValue({});

      const newSettings = {
        platform: {
          platformName: 'My Platform',
          language: 'en',
          timezone: 'America/New_York',
        },
        security: {
          mfaRequired: true,
          sessionTimeoutMinutes: 120,
          maxLoginAttempts: 10,
        },
        notifications: {
          emailNotificationsEnabled: true,
          systemAlertsEnabled: false,
          maintenanceNotificationsEnabled: true,
        },
        appearance: {
          theme: 'dark',
        },
      };

      const res = await app.request('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newSettings),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        success: true,
        message: 'Settings saved successfully',
      });
      expect(mockSettingRepoFunctions.set).toHaveBeenCalledTimes(4);
    });

    it('不正な言語設定でバリデーションエラーになるべき', async () => {
      const invalidSettings = {
        platform: {
          platformName: 'Test',
          language: 'invalid',
          timezone: 'Asia/Tokyo',
        },
        security: {
          mfaRequired: false,
          sessionTimeoutMinutes: 60,
          maxLoginAttempts: 5,
        },
        notifications: {
          emailNotificationsEnabled: true,
          systemAlertsEnabled: true,
          maintenanceNotificationsEnabled: true,
        },
        appearance: {
          theme: 'system',
        },
      };

      const res = await app.request('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(invalidSettings),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Validation error');
    });

    it('不正なテーマ設定でバリデーションエラーになるべき', async () => {
      const invalidSettings = {
        platform: {
          platformName: 'Test',
          language: 'ja',
          timezone: 'Asia/Tokyo',
        },
        security: {
          mfaRequired: false,
          sessionTimeoutMinutes: 60,
          maxLoginAttempts: 5,
        },
        notifications: {
          emailNotificationsEnabled: true,
          systemAlertsEnabled: true,
          maintenanceNotificationsEnabled: true,
        },
        appearance: {
          theme: 'invalid-theme',
        },
      };

      const res = await app.request('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(invalidSettings),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Validation error');
    });

    it('セッションタイムアウトが範囲外でバリデーションエラーになるべき', async () => {
      const invalidSettings = {
        platform: {
          platformName: 'Test',
          language: 'ja',
          timezone: 'Asia/Tokyo',
        },
        security: {
          mfaRequired: false,
          sessionTimeoutMinutes: 2, // min is 5
          maxLoginAttempts: 5,
        },
        notifications: {
          emailNotificationsEnabled: true,
          systemAlertsEnabled: true,
          maintenanceNotificationsEnabled: true,
        },
        appearance: {
          theme: 'system',
        },
      };

      const res = await app.request('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(invalidSettings),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Validation error');
    });
  });

  describe('GET /api/activities', () => {
    it('最近のアクティビティを取得できるべき', async () => {
      const mockLogs = [
        {
          id: '01HJXK5K3VDXK5YPNZBKRT5001',
          tenantId: '',
          userId: 'user-123',
          action: 'CREATE',
          resourceType: 'TENANT',
          resourceId: 'tenant-001',
          details: { name: 'Test Tenant' },
          createdAt: new Date('2024-01-15T10:00:00.000Z'),
        },
        {
          id: '01HJXK5K3VDXK5YPNZBKRT5002',
          tenantId: '',
          userId: 'user-456',
          action: 'UPDATE',
          resourceType: 'SETTING',
          resourceId: 'setting-001',
          details: {},
          createdAt: new Date('2024-01-15T09:00:00.000Z'),
        },
      ];
      mockAuditLogRepoFunctions.listByTenant.mockResolvedValue({
        logs: mockLogs,
        lastKey: undefined,
      });

      const res = await app.request('/api/activities');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.data[0]).toMatchObject({
        id: '01HJXK5K3VDXK5YPNZBKRT5001',
        action: 'CREATE',
        resourceType: 'TENANT',
        resourceId: 'tenant-001',
        details: { name: 'Test Tenant' },
      });
      expect(body.pagination).toEqual({
        limit: 10,
        hasNextPage: false,
      });
    });

    it('空のアクティビティリストを返すべき', async () => {
      mockAuditLogRepoFunctions.listByTenant.mockResolvedValue({
        logs: [],
        lastKey: undefined,
      });

      const res = await app.request('/api/activities');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
      expect(body.pagination).toEqual({
        limit: 10,
        hasNextPage: false,
      });
    });

    it('カスタム limit パラメータが動作すべき', async () => {
      mockAuditLogRepoFunctions.listByTenant.mockResolvedValue({
        logs: [],
        lastKey: undefined,
      });

      const res = await app.request('/api/activities?limit=5');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pagination.limit).toBe(5);
      expect(mockAuditLogRepoFunctions.listByTenant).toHaveBeenCalledWith('', {
        limit: 5,
      });
    });

    it('limit は 50 に制限されるべき', async () => {
      mockAuditLogRepoFunctions.listByTenant.mockResolvedValue({
        logs: [],
        lastKey: undefined,
      });

      const res = await app.request('/api/activities?limit=999');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pagination.limit).toBe(50);
    });

    it('不正な limit は 10 にフォールバックすべき', async () => {
      mockAuditLogRepoFunctions.listByTenant.mockResolvedValue({
        logs: [],
        lastKey: undefined,
      });

      const res = await app.request('/api/activities?limit=invalid');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pagination.limit).toBe(10);
    });

    it('hasNextPage が正しく設定されるべき', async () => {
      mockAuditLogRepoFunctions.listByTenant.mockResolvedValue({
        logs: [
          {
            id: '01HJXK5K3VDXK5YPNZBKRT5001',
            tenantId: '',
            userId: 'user-123',
            action: 'CREATE',
            resourceType: 'TENANT',
            createdAt: new Date(),
          },
        ],
        lastKey: { PK: 'AUDIT#', SK: 'LOG#2024-01-15T10:00:00.000Z#01HJXK' },
      });

      const res = await app.request('/api/activities?limit=1');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pagination.hasNextPage).toBe(true);
    });

    it('API エラー時は 500 エラーを返すべき', async () => {
      mockAuditLogRepoFunctions.listByTenant.mockRejectedValue(
        new Error('DynamoDB error')
      );

      const res = await app.request('/api/activities');
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('Failed to fetch activities');
    });
  });
});
