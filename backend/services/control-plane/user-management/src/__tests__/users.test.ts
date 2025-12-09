import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { app } from '../index';

// Mock Prisma
vi.mock('../lib/prisma', () => ({
  prisma: {
    user: {
      create: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
    },
    $disconnect: vi.fn(),
  },
}));

// Mock Keycloak
vi.mock('../lib/keycloak', () => ({
  getKeycloakClient: vi.fn().mockResolvedValue({
    users: { create: vi.fn().mockResolvedValue({ id: 'mock-keycloak-id' }) },
    setConfig: vi.fn(),
  }),
  createKeycloakUser: vi.fn().mockResolvedValue({
    keycloakId: 'mock-keycloak-id',
    temporaryPassword: 'TempPass123!',
  }),
  resetKeycloakPassword: vi.fn().mockResolvedValue('NewTempPass456!'),
  disableKeycloakUser: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from '../lib/prisma';

const mockTenantId = '123e4567-e89b-12d3-a456-426614174000';
const mockTenantSlug = 'test-tenant';

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
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /api/users', () => {
    it('有効なリクエストで新規ユーザーを作成すべき', async () => {
      const mockUser = {
        id: '123e4567-e89b-12d3-a456-426614174001',
        tenantId: mockTenantId,
        email: 'user@example.com',
        name: 'テストユーザー',
        role: 'PARTICIPANT' as const,
        status: 'PENDING' as const,
        keycloakId: 'mock-keycloak-id',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(prisma.user.create).mockResolvedValue(mockUser);

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
        id: '123e4567-e89b-12d3-a456-426614174002',
        tenantId: mockTenantId,
        email: 'admin@example.com',
        name: '管理者',
        role: 'TENANT_ADMIN' as const,
        status: 'PENDING' as const,
        keycloakId: 'mock-keycloak-id',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(prisma.user.create).mockResolvedValue(mockUser);

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

      expect(prisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            role: 'TENANT_ADMIN',
          }),
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
      const prismaError = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed',
        { code: 'P2002', clientVersion: '5.0.0' }
      );
      vi.mocked(prisma.user.create).mockRejectedValue(prismaError);

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
      vi.mocked(prisma.user.create).mockRejectedValue(
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
          id: '123e4567-e89b-12d3-a456-426614174001',
          tenantId: mockTenantId,
          email: 'user1@example.com',
          name: 'ユーザー1',
          role: 'PARTICIPANT' as const,
          status: 'ACTIVE' as const,
          keycloakId: 'keycloak-1',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: '123e4567-e89b-12d3-a456-426614174002',
          tenantId: mockTenantId,
          email: 'user2@example.com',
          name: 'ユーザー2',
          role: 'TENANT_ADMIN' as const,
          status: 'ACTIVE' as const,
          keycloakId: 'keycloak-2',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      vi.mocked(prisma.user.findMany).mockResolvedValue(mockUsers);
      vi.mocked(prisma.user.count).mockResolvedValue(2);

      const res = await app.request(createRequest('/api/users'));

      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.users).toHaveLength(2);
      expect(body.total).toBe(2);
    });

    it('ステータスでフィルタリングできるべき', async () => {
      vi.mocked(prisma.user.findMany).mockResolvedValue([]);
      vi.mocked(prisma.user.count).mockResolvedValue(0);

      const res = await app.request(createRequest('/api/users?status=ACTIVE'));

      expect(res.status).toBe(200);

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'ACTIVE',
          }),
        })
      );
    });

    it('ロールでフィルタリングできるべき', async () => {
      vi.mocked(prisma.user.findMany).mockResolvedValue([]);
      vi.mocked(prisma.user.count).mockResolvedValue(0);

      const res = await app.request(
        createRequest('/api/users?role=TENANT_ADMIN')
      );

      expect(res.status).toBe(200);

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            role: 'TENANT_ADMIN',
          }),
        })
      );
    });

    it('ページネーションをサポートすべき', async () => {
      vi.mocked(prisma.user.findMany).mockResolvedValue([]);
      vi.mocked(prisma.user.count).mockResolvedValue(100);

      const res = await app.request(
        createRequest('/api/users?limit=10&offset=20')
      );

      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.limit).toBe(10);
      expect(body.offset).toBe(20);

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 10,
          skip: 20,
        })
      );
    });

    it('サーバーエラーの場合は500を返すべき', async () => {
      vi.mocked(prisma.user.findMany).mockRejectedValue(
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
  });

  describe('GET /api/users/:id', () => {
    it('テナント情報がない場合は400エラーを返すべき', async () => {
      const res = await app.request(
        '/api/users/123e4567-e89b-12d3-a456-426614174001'
      );

      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toContain('テナント情報');
    });

    it('ユーザー詳細を取得すべき', async () => {
      const mockUser = {
        id: '123e4567-e89b-12d3-a456-426614174001',
        tenantId: mockTenantId,
        email: 'user@example.com',
        name: 'テストユーザー',
        role: 'PARTICIPANT' as const,
        status: 'ACTIVE' as const,
        keycloakId: 'keycloak-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(prisma.user.findFirst).mockResolvedValue(mockUser);

      const res = await app.request(
        createRequest('/api/users/123e4567-e89b-12d3-a456-426614174001')
      );

      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.id).toBe(mockUser.id);
      expect(body.email).toBe('user@example.com');
    });

    it('存在しないユーザーの場合は404を返すべき', async () => {
      vi.mocked(prisma.user.findFirst).mockResolvedValue(null);

      const res = await app.request(
        createRequest('/api/users/123e4567-e89b-12d3-a456-426614174999')
      );

      expect(res.status).toBe(404);

      const body = await res.json();
      expect(body.error).toContain('見つかりません');
    });

    it('無効なUUID形式の場合は400を返すべき', async () => {
      const res = await app.request(createRequest('/api/users/invalid-uuid'));

      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toContain('無効な');
    });

    it('サーバーエラーの場合は500を返すべき', async () => {
      vi.mocked(prisma.user.findFirst).mockRejectedValue(
        new Error('DB connection failed')
      );

      const res = await app.request(
        createRequest('/api/users/123e4567-e89b-12d3-a456-426614174001')
      );

      expect(res.status).toBe(500);

      const body = await res.json();
      expect(body.error).toContain('失敗しました');
    });
  });

  describe('PATCH /api/users/:id/role', () => {
    it('テナント情報がない場合は400エラーを返すべき', async () => {
      const res = await app.request(
        '/api/users/123e4567-e89b-12d3-a456-426614174001/role',
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: 'TENANT_ADMIN' }),
        }
      );

      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toContain('テナント情報');
    });

    it('無効なUUID形式の場合は400を返すべき', async () => {
      const res = await app.request(
        createRequest('/api/users/invalid-uuid/role', {
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
      const mockUser = {
        id: '123e4567-e89b-12d3-a456-426614174001',
        tenantId: 'different-tenant-id',
        email: 'user@example.com',
        name: 'テストユーザー',
        role: 'TENANT_ADMIN' as const,
        status: 'ACTIVE' as const,
        keycloakId: 'keycloak-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(prisma.user.update).mockResolvedValue(mockUser);

      const res = await app.request(
        createRequest('/api/users/123e4567-e89b-12d3-a456-426614174001/role', {
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
        id: '123e4567-e89b-12d3-a456-426614174001',
        tenantId: mockTenantId,
        email: 'user@example.com',
        name: 'テストユーザー',
        role: 'TENANT_ADMIN' as const,
        status: 'ACTIVE' as const,
        keycloakId: 'keycloak-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(prisma.user.update).mockResolvedValue(mockUser);

      const res = await app.request(
        createRequest('/api/users/123e4567-e89b-12d3-a456-426614174001/role', {
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
        createRequest('/api/users/123e4567-e89b-12d3-a456-426614174001/role', {
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
      vi.mocked(prisma.user.update).mockRejectedValue(
        new Error('DB connection failed')
      );

      const res = await app.request(
        createRequest('/api/users/123e4567-e89b-12d3-a456-426614174001/role', {
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
      const res = await app.request(
        '/api/users/123e4567-e89b-12d3-a456-426614174001/password-reset',
        {
          method: 'POST',
        }
      );

      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toContain('テナント情報');
    });

    it('無効なUUID形式の場合は400を返すべき', async () => {
      const res = await app.request(
        createRequest('/api/users/invalid-uuid/password-reset', {
          method: 'POST',
        })
      );

      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toContain('無効な');
    });

    it('パスワードをリセットすべき', async () => {
      const mockUser = {
        id: '123e4567-e89b-12d3-a456-426614174001',
        tenantId: mockTenantId,
        email: 'user@example.com',
        name: 'テストユーザー',
        role: 'PARTICIPANT' as const,
        status: 'ACTIVE' as const,
        keycloakId: 'keycloak-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(prisma.user.findFirst).mockResolvedValue(mockUser);

      const res = await app.request(
        createRequest(
          '/api/users/123e4567-e89b-12d3-a456-426614174001/password-reset',
          {
            method: 'POST',
          }
        )
      );

      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.temporaryPassword).toBe('NewTempPass456!');
      expect(body.message).toContain('パスワードをリセットしました');
    });

    it('存在しないユーザーの場合は404を返すべき', async () => {
      vi.mocked(prisma.user.findFirst).mockResolvedValue(null);

      const res = await app.request(
        createRequest(
          '/api/users/123e4567-e89b-12d3-a456-426614174999/password-reset',
          {
            method: 'POST',
          }
        )
      );

      expect(res.status).toBe(404);

      const body = await res.json();
      expect(body.error).toContain('見つかりません');
    });

    it('Keycloakに紐付けられていないユーザーの場合は400を返すべき', async () => {
      const mockUser = {
        id: '123e4567-e89b-12d3-a456-426614174001',
        tenantId: mockTenantId,
        email: 'user@example.com',
        name: 'テストユーザー',
        role: 'PARTICIPANT' as const,
        status: 'ACTIVE' as const,
        keycloakId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(prisma.user.findFirst).mockResolvedValue(mockUser);

      const res = await app.request(
        createRequest(
          '/api/users/123e4567-e89b-12d3-a456-426614174001/password-reset',
          {
            method: 'POST',
          }
        )
      );

      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toContain('Keycloak');
    });

    it('サーバーエラーの場合は500を返すべき', async () => {
      vi.mocked(prisma.user.findFirst).mockRejectedValue(
        new Error('DB connection failed')
      );

      const res = await app.request(
        createRequest(
          '/api/users/123e4567-e89b-12d3-a456-426614174001/password-reset',
          {
            method: 'POST',
          }
        )
      );

      expect(res.status).toBe(500);

      const body = await res.json();
      expect(body.error).toContain('失敗しました');
    });
  });

  describe('DELETE /api/users/:id', () => {
    it('テナント情報がない場合は400エラーを返すべき', async () => {
      const res = await app.request(
        '/api/users/123e4567-e89b-12d3-a456-426614174001',
        {
          method: 'DELETE',
        }
      );

      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toContain('テナント情報');
    });

    it('無効なUUID形式の場合は400を返すべき', async () => {
      const res = await app.request(
        createRequest('/api/users/invalid-uuid', {
          method: 'DELETE',
        })
      );

      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toContain('無効な');
    });

    it('ユーザーを無効化すべき', async () => {
      const mockUser = {
        id: '123e4567-e89b-12d3-a456-426614174001',
        tenantId: mockTenantId,
        email: 'user@example.com',
        name: 'テストユーザー',
        role: 'PARTICIPANT' as const,
        status: 'ACTIVE' as const,
        keycloakId: 'keycloak-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const updatedUser = { ...mockUser, status: 'INACTIVE' as const };

      vi.mocked(prisma.user.findFirst).mockResolvedValue(mockUser);
      vi.mocked(prisma.user.update).mockResolvedValue(updatedUser);

      const res = await app.request(
        createRequest('/api/users/123e4567-e89b-12d3-a456-426614174001', {
          method: 'DELETE',
        })
      );

      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.status).toBe('INACTIVE');
      expect(body.message).toContain('無効化しました');
    });

    it('存在しないユーザーの場合は404を返すべき', async () => {
      vi.mocked(prisma.user.findFirst).mockResolvedValue(null);

      const res = await app.request(
        createRequest('/api/users/123e4567-e89b-12d3-a456-426614174999', {
          method: 'DELETE',
        })
      );

      expect(res.status).toBe(404);

      const body = await res.json();
      expect(body.error).toContain('見つかりません');
    });

    it('Keycloakに紐付けられていないユーザーも無効化できるべき', async () => {
      const mockUser = {
        id: '123e4567-e89b-12d3-a456-426614174001',
        tenantId: mockTenantId,
        email: 'user@example.com',
        name: 'テストユーザー',
        role: 'PARTICIPANT' as const,
        status: 'ACTIVE' as const,
        keycloakId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const updatedUser = { ...mockUser, status: 'INACTIVE' as const };

      vi.mocked(prisma.user.findFirst).mockResolvedValue(mockUser);
      vi.mocked(prisma.user.update).mockResolvedValue(updatedUser);

      const res = await app.request(
        createRequest('/api/users/123e4567-e89b-12d3-a456-426614174001', {
          method: 'DELETE',
        })
      );

      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.status).toBe('INACTIVE');
    });

    it('サーバーエラーの場合は500を返すべき', async () => {
      vi.mocked(prisma.user.findFirst).mockRejectedValue(
        new Error('DB connection failed')
      );

      const res = await app.request(
        createRequest('/api/users/123e4567-e89b-12d3-a456-426614174001', {
          method: 'DELETE',
        })
      );

      expect(res.status).toBe(500);

      const body = await res.json();
      expect(body.error).toContain('失敗しました');
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
