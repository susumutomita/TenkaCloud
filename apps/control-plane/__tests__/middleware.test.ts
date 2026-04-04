import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

// Mock auth to call the handler directly
let capturedHandler: ((req: unknown) => NextResponse) | null = null;
vi.mock('@/auth', () => ({
  auth: vi.fn((handler: (req: unknown) => NextResponse) => {
    capturedHandler = handler;
    return async (req: unknown) => handler(req);
  }),
}));

function createMockAuthReq(
  pathname: string,
  authSession: unknown = null,
  origin = 'http://localhost:13000',
) {
  const url = new URL(pathname, origin);
  return {
    auth: authSession,
    nextUrl: url,
    url: url.toString(),
  };
}

describe('Control Plane Middleware', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    capturedHandler = null;
    delete process.env.AUTH_SKIP;
  });

  describe('認証チェック', () => {
    it('未認証ユーザーは /login にリダイレクトされるべき', async () => {
      await import('../middleware');
      expect(capturedHandler).not.toBeNull();

      const result = capturedHandler!(createMockAuthReq('/dashboard'));
      expect(result.status).toBe(307);
      const location = new URL(result.headers.get('location')!);
      expect(location.pathname).toBe('/control/login');
    });

    it('リダイレクト時に callbackUrl を含むべき', async () => {
      await import('../middleware');
      expect(capturedHandler).not.toBeNull();

      const result = capturedHandler!(createMockAuthReq('/dashboard/tenants'));
      expect(result.status).toBe(307);
      const location = new URL(result.headers.get('location')!);
      expect(location.pathname).toBe('/control/login');
      expect(location.searchParams.get('callbackUrl')).toBe(
        '/dashboard/tenants',
      );
    });

    it('認証済みユーザーはダッシュボードにアクセスできるべき', async () => {
      await import('../middleware');
      expect(capturedHandler).not.toBeNull();

      const result = capturedHandler!(
        createMockAuthReq('/dashboard', { user: { name: 'Admin' } }),
      );
      expect(result.status).toBe(200);
    });

    it('認証済みユーザーがログインページにアクセスした場合はダッシュボードにリダイレクトされるべき', async () => {
      await import('../middleware');
      expect(capturedHandler).not.toBeNull();

      const result = capturedHandler!(
        createMockAuthReq('/login', { user: { name: 'Admin' } }),
      );
      expect(result.status).toBe(307);
      const location = new URL(result.headers.get('location')!);
      expect(location.pathname).toBe('/control/dashboard');
    });
  });

  describe('公開パス', () => {
    it('/api/auth ルートは認証不要でアクセスできるべき', async () => {
      await import('../middleware');
      expect(capturedHandler).not.toBeNull();

      const result = capturedHandler!(createMockAuthReq('/api/auth/callback'));
      expect(result.status).toBe(200);
    });

    it('/login は未認証でもアクセスできるべき', async () => {
      await import('../middleware');
      expect(capturedHandler).not.toBeNull();

      const result = capturedHandler!(createMockAuthReq('/login'));
      expect(result.status).toBe(200);
    });
  });

  describe('AUTH_SKIP モード', () => {
    it('AUTH_SKIP=1 の場合は認証済みとして扱われるべき', async () => {
      process.env.AUTH_SKIP = '1';
      vi.stubEnv('NODE_ENV', 'test');
      await import('../middleware');
      expect(capturedHandler).not.toBeNull();

      const result = capturedHandler!(createMockAuthReq('/dashboard'));
      expect(result.status).toBe(200);
    });

    it('AUTH_SKIP=1 かつ NODE_ENV=production の場合は認証をバイパスしないべき', async () => {
      process.env.AUTH_SKIP = '1';
      vi.stubEnv('NODE_ENV', 'production');
      vi.resetModules();
      await import('../middleware');
      expect(capturedHandler).not.toBeNull();

      const result = capturedHandler!(createMockAuthReq('/dashboard'));
      // Production mode should NOT skip auth
      expect(result.status).toBe(307);
      const location = new URL(result.headers.get('location')!);
      expect(location.pathname).toBe('/control/login');
    });
  });
});
