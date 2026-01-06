/**
 * Middleware テスト
 */

import { describe, expect, it, vi, beforeEach, type Mock } from 'vitest';
import { NextRequest } from 'next/server';

// モックの設定
vi.mock('@/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/tenant/identification', () => ({
  getTenantSlugFromUrl: vi.fn(),
  buildApplicationPlaneUrl: vi.fn(),
}));

// モック後にインポート
import { middleware } from '../../../middleware';
import { auth } from '@/auth';
import { getTenantSlugFromUrl } from '@/lib/tenant/identification';

// 型安全なモック関数取得
const mockAuth = auth as unknown as Mock;
const mockGetTenantSlugFromUrl = getTenantSlugFromUrl as Mock;

// NextRequest のモックファクトリ
function createMockRequest(
  url: string,
  headers: Record<string, string> = {}
): NextRequest {
  const request = new NextRequest(url, {
    headers: new Headers(headers),
  });
  return request;
}

describe('Middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('公開パス', () => {
    it('/login は認証なしでアクセス可能にすべき', async () => {
      mockAuth.mockResolvedValue(null);
      mockGetTenantSlugFromUrl.mockReturnValue(null);

      const req = createMockRequest('http://localhost:13001/login');
      const response = await middleware(req);

      expect(response.status).toBe(200);
    });

    it('/api/auth/* は認証なしでアクセス可能にすべき', async () => {
      mockAuth.mockResolvedValue(null);
      mockGetTenantSlugFromUrl.mockReturnValue(null);

      const req = createMockRequest(
        'http://localhost:13001/api/auth/callback/auth0'
      );
      const response = await middleware(req);

      expect(response.status).toBe(200);
    });

    it('/_next/* は認証なしでアクセス可能にすべき', async () => {
      mockAuth.mockResolvedValue(null);
      mockGetTenantSlugFromUrl.mockReturnValue(null);

      const req = createMockRequest('http://localhost:13001/_next/webpack-hmr');
      const response = await middleware(req);

      expect(response.status).toBe(200);
    });
  });

  describe('認証チェック', () => {
    it('未認証ユーザーを /login にリダイレクトすべき', async () => {
      mockAuth.mockResolvedValue(null);
      mockGetTenantSlugFromUrl.mockReturnValue('acme');

      const req = createMockRequest('http://localhost:13001/dashboard');
      const response = await middleware(req);

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toContain('/login');
      expect(response.headers.get('location')).toContain(
        'callbackUrl=%2Fdashboard'
      );
    });

    it('認証済みユーザーはダッシュボードにアクセス可能にすべき', async () => {
      mockAuth.mockResolvedValue({
        user: { name: 'Test User', email: 'test@example.com' },
        expires: new Date(Date.now() + 86400000).toISOString(),
        roles: ['participant'],
        tenantId: 'acme',
      });
      mockGetTenantSlugFromUrl.mockReturnValue('acme');

      const req = createMockRequest('http://localhost:13001/dashboard');
      const response = await middleware(req);

      expect(response.status).toBe(200);
    });
  });

  describe('管理者ルーティング', () => {
    it('admin ロールを持つユーザーは /admin にアクセス可能にすべき', async () => {
      mockAuth.mockResolvedValue({
        user: { name: 'Admin User', email: 'admin@example.com' },
        expires: new Date(Date.now() + 86400000).toISOString(),
        roles: ['admin', 'participant'],
        tenantId: 'acme',
      });
      mockGetTenantSlugFromUrl.mockReturnValue('acme');

      const req = createMockRequest('http://localhost:13001/admin');
      const response = await middleware(req);

      expect(response.status).toBe(200);
    });

    it('participant ロールのみのユーザーは /admin から /dashboard にリダイレクトすべき', async () => {
      mockAuth.mockResolvedValue({
        user: { name: 'Participant User', email: 'participant@example.com' },
        expires: new Date(Date.now() + 86400000).toISOString(),
        roles: ['participant'],
        tenantId: 'acme',
      });
      mockGetTenantSlugFromUrl.mockReturnValue('acme');

      const req = createMockRequest('http://localhost:13001/admin');
      const response = await middleware(req);

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toContain('/dashboard');
    });

    it('/admin/events にも同じルールを適用すべき', async () => {
      mockAuth.mockResolvedValue({
        user: { name: 'Participant User', email: 'participant@example.com' },
        expires: new Date(Date.now() + 86400000).toISOString(),
        roles: ['participant'],
        tenantId: 'acme',
      });
      mockGetTenantSlugFromUrl.mockReturnValue('acme');

      const req = createMockRequest('http://localhost:13001/admin/events');
      const response = await middleware(req);

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toContain('/dashboard');
    });
  });

  describe('テナント識別', () => {
    it('テナントスラッグをヘッダーに設定すべき', async () => {
      mockAuth.mockResolvedValue({
        user: { name: 'Test User', email: 'test@example.com' },
        expires: new Date(Date.now() + 86400000).toISOString(),
        roles: ['participant'],
        tenantId: 'session-tenant',
      });
      mockGetTenantSlugFromUrl.mockReturnValue('url-tenant');

      const req = createMockRequest('http://localhost:13001/dashboard');
      const response = await middleware(req);

      expect(response.headers.get('x-tenant-slug')).toBe('url-tenant');
    });

    it('URL にテナントがない場合はセッションから取得すべき', async () => {
      mockAuth.mockResolvedValue({
        user: { name: 'Test User', email: 'test@example.com' },
        expires: new Date(Date.now() + 86400000).toISOString(),
        roles: ['participant'],
        tenantId: 'session-tenant',
      });
      mockGetTenantSlugFromUrl.mockReturnValue(null);

      const req = createMockRequest('http://localhost:13001/dashboard');
      const response = await middleware(req);

      expect(response.headers.get('x-tenant-slug')).toBe('session-tenant');
    });

    it('URL にもセッションにもテナントがない場合はヘッダーを設定しないべき', async () => {
      mockAuth.mockResolvedValue({
        user: { name: 'Test User', email: 'test@example.com' },
        expires: new Date(Date.now() + 86400000).toISOString(),
        roles: ['participant'],
        // tenantId を省略
      });
      mockGetTenantSlugFromUrl.mockReturnValue(null);

      const req = createMockRequest('http://localhost:13001/dashboard');
      const response = await middleware(req);

      expect(response.headers.get('x-tenant-slug')).toBeNull();
    });
  });
});
