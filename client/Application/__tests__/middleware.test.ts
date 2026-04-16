import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Mock auth module
const mockAuth = vi.fn();
vi.mock('@/auth', () => ({
  auth: (...args: unknown[]) => mockAuth(...args),
}));

// Mock tenant identification
vi.mock('@/lib/tenant/identification', () => ({
  getTenantSlugFromUrl: vi.fn(() => null),
  buildApplicationPlaneUrl: vi.fn(),
}));

function createRequest(path: string, origin = 'http://localhost:13001') {
  return new NextRequest(new URL(path, origin));
}

describe('Application Plane Middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('公開パス', () => {
    it('/login は認証不要でアクセスできるべき', async () => {
      mockAuth.mockResolvedValue(null);
      const { proxy: middleware } = await import('../proxy');

      const response = await middleware(createRequest('/login'));
      expect(response.status).toBe(200);
    });

    it('/signup は認証不要でアクセスできるべき', async () => {
      mockAuth.mockResolvedValue(null);
      const { proxy: middleware } = await import('../proxy');

      const response = await middleware(createRequest('/signup'));
      expect(response.status).toBe(200);
    });

    it('/api/auth/callback は認証不要でアクセスできるべき', async () => {
      mockAuth.mockResolvedValue(null);
      const { proxy: middleware } = await import('../proxy');

      const response = await middleware(createRequest('/api/auth/callback'));
      expect(response.status).toBe(200);
    });
  });

  describe('認証が必要なパス', () => {
    it('/gameday にアクセスする未認証ユーザーは /login にリダイレクトされるべき', async () => {
      mockAuth.mockResolvedValue(null);
      const { proxy: middleware } = await import('../proxy');

      const response = await middleware(createRequest('/gameday'));
      expect(response.status).toBe(307);
      const location = new URL(response.headers.get('location')!);
      expect(location.pathname).toBe('/login');
      expect(location.searchParams.get('callbackUrl')).toBe('/gameday');
    });

    it('/events にアクセスする未認証ユーザーは /login にリダイレクトされるべき', async () => {
      mockAuth.mockResolvedValue(null);
      const { proxy: middleware } = await import('../proxy');

      const response = await middleware(createRequest('/events'));
      expect(response.status).toBe(307);
      const location = new URL(response.headers.get('location')!);
      expect(location.pathname).toBe('/login');
      expect(location.searchParams.get('callbackUrl')).toBe('/events');
    });

    it('/profile にアクセスする未認証ユーザーは /login にリダイレクトされるべき', async () => {
      mockAuth.mockResolvedValue(null);
      const { proxy: middleware } = await import('../proxy');

      const response = await middleware(createRequest('/profile'));
      expect(response.status).toBe(307);
      const location = new URL(response.headers.get('location')!);
      expect(location.pathname).toBe('/login');
      expect(location.searchParams.get('callbackUrl')).toBe('/profile');
    });

    it('/dashboard にアクセスする未認証ユーザーは /login にリダイレクトされるべき', async () => {
      mockAuth.mockResolvedValue(null);
      const { proxy: middleware } = await import('../proxy');

      const response = await middleware(createRequest('/dashboard'));
      expect(response.status).toBe(307);
      const location = new URL(response.headers.get('location')!);
      expect(location.pathname).toBe('/login');
      expect(location.searchParams.get('callbackUrl')).toBe('/dashboard');
    });

    it('認証済みユーザーは保護されたパスにアクセスできるべき', async () => {
      mockAuth.mockResolvedValue({
        user: { name: 'Test' },
        roles: ['participant'],
        tenantId: 'test-tenant',
      });
      const { proxy: middleware } = await import('../proxy');

      const response = await middleware(createRequest('/gameday'));
      expect(response.status).toBe(200);
    });

    it('リダイレクト時にクエリパラメータ付きの callbackUrl を含むべき', async () => {
      mockAuth.mockResolvedValue(null);
      const { proxy: middleware } = await import('../proxy');

      const response = await middleware(createRequest('/events?tab=upcoming'));
      expect(response.status).toBe(307);
      const location = new URL(response.headers.get('location')!);
      expect(location.pathname).toBe('/login');
      expect(location.searchParams.get('callbackUrl')).toBe(
        '/events?tab=upcoming',
      );
    });
  });

  describe('管理者ロールチェック', () => {
    it('/admin にアクセスする admin ロール持ちユーザーは通過できるべき', async () => {
      mockAuth.mockResolvedValue({
        user: { name: 'Admin' },
        roles: ['admin'],
        tenantId: 'test-tenant',
      });
      const { proxy: middleware } = await import('../proxy');

      const response = await middleware(createRequest('/admin'));
      expect(response.status).toBe(200);
    });

    it('/admin/settings にアクセスする admin ロール持ちユーザーは通過できるべき', async () => {
      mockAuth.mockResolvedValue({
        user: { name: 'Admin' },
        roles: ['admin'],
        tenantId: 'test-tenant',
      });
      const { proxy: middleware } = await import('../proxy');

      const response = await middleware(createRequest('/admin/settings'));
      expect(response.status).toBe(200);
    });

    it('/admin にアクセスする participant ロールのみのユーザーは /dashboard にリダイレクトされるべき', async () => {
      mockAuth.mockResolvedValue({
        user: { name: 'Participant' },
        roles: ['participant'],
        tenantId: 'test-tenant',
      });
      const { proxy: middleware } = await import('../proxy');

      const response = await middleware(createRequest('/admin'));
      expect(response.status).toBe(307);
      const location = new URL(response.headers.get('location')!);
      expect(location.pathname).toBe('/dashboard');
    });

    it('/admin にアクセスするロールなしユーザーは /dashboard にリダイレクトされるべき', async () => {
      mockAuth.mockResolvedValue({
        user: { name: 'NoRole' },
        roles: [],
        tenantId: 'test-tenant',
      });
      const { proxy: middleware } = await import('../proxy');

      const response = await middleware(createRequest('/admin'));
      expect(response.status).toBe(307);
      const location = new URL(response.headers.get('location')!);
      expect(location.pathname).toBe('/dashboard');
    });

    it('/admin にアクセスする未認証ユーザーは /login にリダイレクトされるべき', async () => {
      mockAuth.mockResolvedValue(null);
      const { proxy: middleware } = await import('../proxy');

      const response = await middleware(createRequest('/admin'));
      expect(response.status).toBe(307);
      const location = new URL(response.headers.get('location')!);
      expect(location.pathname).toBe('/login');
    });
  });
});
