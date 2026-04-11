import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Mock @/auth module
const mockHandlersGET = vi.fn();
const mockHandlersPOST = vi.fn();
vi.mock('next-auth', () => ({
  default: vi.fn(() => ({
    handlers: { GET: mockHandlersGET, POST: mockHandlersPOST },
    signIn: vi.fn(),
    signOut: vi.fn(),
    auth: vi.fn(),
  })),
}));

vi.mock('next-auth/providers/auth0', () => ({
  default: vi.fn((options) => ({
    id: 'auth0',
    name: 'Auth0',
    type: 'oauth',
    ...options,
  })),
}));

function createRequest(pathname: string): NextRequest {
  return new NextRequest(new URL(pathname, 'http://localhost:3000'));
}

describe('NextAuth route handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    delete process.env.AUTH_SKIP;
    delete process.env.AUTH_SKIP_ROLES;
    delete process.env.AUTH0_CLIENT_ID;
    delete process.env.AUTH0_CLIENT_SECRET;
    delete process.env.AUTH0_ISSUER;
  });

  describe('AUTH_SKIP モード', () => {
    beforeEach(() => {
      process.env.AUTH_SKIP = '1';
    });

    it('AUTH_SKIP モードで /api/auth/session に対してモックセッションを返すべき', async () => {
      const { GET } = await import('../route');
      const request = createRequest('/api/auth/session');
      const response = await GET(request);

      expect(response).toBeDefined();
      const body = await response.json();
      expect(body.user.name).toBe('Dev User');
      expect(body.user.email).toBe('dev@example.com');
      expect(body.accessToken).toBe('mock-access-token');
      expect(body.idToken).toBe('mock-id-token');
      expect(body.roles).toEqual(['participant']);
      expect(body.tenantId).toBe('dev-tenant');
      expect(body.teamId).toBe('team-alpha');
      // handlers.GET should NOT be called for session path
      expect(mockHandlersGET).not.toHaveBeenCalled();
    });

    it('AUTH_SKIP モードで他のパスは handlers.GET に委譲すべき', async () => {
      mockHandlersGET.mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

      const { GET } = await import('../route');
      const request = createRequest('/api/auth/signin');
      await GET(request);

      expect(mockHandlersGET).toHaveBeenCalledWith(request);
    });
  });

  describe('AUTH_SKIP 無効', () => {
    it('AUTH_SKIP が無効の場合は通常の handlers を使用すべき', async () => {
      process.env.AUTH0_CLIENT_ID = 'test-client-id';
      process.env.AUTH0_CLIENT_SECRET = 'test-client-secret';
      process.env.AUTH0_ISSUER = 'https://test.auth0.com';

      mockHandlersGET.mockResolvedValue(
        new Response(JSON.stringify({ session: null }), { status: 200 }),
      );

      const { GET } = await import('../route');
      const request = createRequest('/api/auth/session');
      await GET(request);

      // Should delegate to handlers.GET even for /api/auth/session
      expect(mockHandlersGET).toHaveBeenCalledWith(request);
    });
  });
});
