import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { NextAuthConfig } from 'next-auth';

// Mock next-auth
vi.mock('next-auth', () => ({
  default: vi.fn((config) => ({
    handlers: { GET: vi.fn(), POST: vi.fn() },
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

describe('Auth0 認証設定', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env.AUTH0_CLIENT_ID = 'test-client-id';
    process.env.AUTH0_CLIENT_SECRET = 'test-client-secret';
    process.env.AUTH0_ISSUER = 'https://test.auth0.com';
  });

  it('handlers, signIn, signOut, auth がエクスポートされるべき', async () => {
    const auth = await import('../auth');
    expect(auth.handlers).toBeDefined();
    expect(auth.signIn).toBeDefined();
    expect(auth.signOut).toBeDefined();
    expect(auth.auth).toBeDefined();
  });

  it('Auth0 プロバイダが環境変数から設定されるべき', async () => {
    const Auth0 = (await import('next-auth/providers/auth0')).default;
    await import('../auth');

    expect(Auth0).toHaveBeenCalledWith({
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      issuer: 'https://test.auth0.com',
    });
  });

  describe('JWT コールバック', () => {
    it('アカウント情報からトークンを保存すべき', async () => {
      const NextAuth = (await import('next-auth')).default;

      await import('../auth');
      const mockCall = vi.mocked(NextAuth).mock.calls[0][0] as NextAuthConfig;
      const jwtCallback = mockCall.callbacks?.jwt;

      if (!jwtCallback) throw new Error('JWT callback not defined');

      const token = {};
      const account = {
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
        id_token: 'test-id-token',
      };

      const result = (await jwtCallback({
        token,
        account,
        user: { id: '1', name: 'Test', email: 'test@example.com' },
        trigger: 'signIn',
      } as Parameters<typeof jwtCallback>[0])) as AnyRecord;

      expect(result.accessToken).toBe('test-access-token');
      expect(result.refreshToken).toBe('test-refresh-token');
      expect(result.idToken).toBe('test-id-token');
    });

    it('Auth0 カスタムクレームからロールとテナント情報を取得すべき', async () => {
      const NextAuth = (await import('next-auth')).default;

      await import('../auth');
      const mockCall = vi.mocked(NextAuth).mock.calls[0][0] as NextAuthConfig;
      const jwtCallback = mockCall.callbacks?.jwt;

      if (!jwtCallback) throw new Error('JWT callback not defined');

      const token = {};
      const profile = {
        'https://tenkacloud.com/roles': ['participant', 'team_lead'],
        'https://tenkacloud.com/tenant_id': 'tenant-123',
        'https://tenkacloud.com/team_id': 'team-456',
        email: 'test@example.com',
        name: 'Test User',
        picture: 'https://example.com/avatar.png',
      };

      const result = (await jwtCallback({
        token,
        profile,
        user: { id: '1', name: 'Test', email: 'test@example.com' },
        trigger: 'signIn',
      } as Parameters<typeof jwtCallback>[0])) as AnyRecord;

      expect(result.roles).toEqual(['participant', 'team_lead']);
      expect(result.tenantId).toBe('tenant-123');
      expect(result.teamId).toBe('team-456');
      expect(result.email).toBe('test@example.com');
      expect(result.name).toBe('Test User');
      expect(result.picture).toBe('https://example.com/avatar.png');
    });

    it('カスタムクレームがない場合、フォールバックすべき', async () => {
      const NextAuth = (await import('next-auth')).default;

      await import('../auth');
      const mockCall = vi.mocked(NextAuth).mock.calls[0][0] as NextAuthConfig;
      const jwtCallback = mockCall.callbacks?.jwt;

      if (!jwtCallback) throw new Error('JWT callback not defined');

      const token = {};
      const profile = {
        roles: ['admin'],
        email: 'test@example.com',
        name: 'Test User',
      };

      const result = (await jwtCallback({
        token,
        profile,
        user: { id: '1', name: 'Test', email: 'test@example.com' },
        trigger: 'signIn',
      } as Parameters<typeof jwtCallback>[0])) as AnyRecord;

      expect(result.roles).toEqual(['admin']);
      expect(result.tenantId).toBeNull();
      expect(result.teamId).toBeNull();
    });

    it('ロールが存在しない場合、空配列にフォールバックすべき', async () => {
      const NextAuth = (await import('next-auth')).default;

      await import('../auth');
      const mockCall = vi.mocked(NextAuth).mock.calls[0][0] as NextAuthConfig;
      const jwtCallback = mockCall.callbacks?.jwt;

      if (!jwtCallback) throw new Error('JWT callback not defined');

      const token = {};
      const profile = {
        email: 'test@example.com',
        name: 'Test User',
      };

      const result = (await jwtCallback({
        token,
        profile,
        user: { id: '1', name: 'Test', email: 'test@example.com' },
        trigger: 'signIn',
      } as Parameters<typeof jwtCallback>[0])) as AnyRecord;

      expect(result.roles).toEqual([]);
    });
  });

  describe('Session コールバック', () => {
    it('JWT からセッションにテナント情報を含めるべき', async () => {
      const NextAuth = (await import('next-auth')).default;

      await import('../auth');
      const mockCall = vi.mocked(NextAuth).mock.calls[0][0] as NextAuthConfig;
      const sessionCallback = mockCall.callbacks?.session;

      if (!sessionCallback) throw new Error('Session callback not defined');

      const token = {
        accessToken: 'test-access-token',
        idToken: 'test-id-token',
        roles: ['participant'],
        tenantId: 'tenant-123',
        teamId: 'team-456',
        email: 'test@example.com',
        name: 'Test User',
        picture: 'https://example.com/avatar.png',
      };

      const session = {
        user: {
          id: '1',
          email: '',
          name: '',
          image: '',
          emailVerified: null,
        },
        expires: new Date().toISOString(),
        sessionToken: 'test-session-token',
        userId: '1',
      };

      const result = (await sessionCallback({
        session,
        token,
        user: {
          id: '1',
          name: 'Test',
          email: 'test@example.com',
          emailVerified: null,
        },
        trigger: 'update',
        newSession: null,
      } as unknown as Parameters<typeof sessionCallback>[0])) as AnyRecord;

      expect(result.accessToken).toBe('test-access-token');
      expect(result.idToken).toBe('test-id-token');
      expect(result.roles).toEqual(['participant']);
      expect(result.tenantId).toBe('tenant-123');
      expect(result.teamId).toBe('team-456');
      expect(result.user?.email).toBe('test@example.com');
      expect(result.user?.name).toBe('Test User');
      expect(result.user?.image).toBe('https://example.com/avatar.png');
    });

    it('session.user が存在しない場合でも正しく動作すべき', async () => {
      const NextAuth = (await import('next-auth')).default;

      await import('../auth');
      const mockCall = vi.mocked(NextAuth).mock.calls[0][0] as NextAuthConfig;
      const sessionCallback = mockCall.callbacks?.session;

      if (!sessionCallback) throw new Error('Session callback not defined');

      const token = {
        accessToken: 'test-access-token',
        idToken: 'test-id-token',
        roles: ['participant'],
        tenantId: 'tenant-123',
        teamId: 'team-456',
        email: 'test@example.com',
        name: 'Test User',
        picture: 'https://example.com/avatar.png',
      };

      const session = {
        expires: new Date().toISOString(),
        sessionToken: 'test-session-token',
        userId: '1',
      };

      const result = (await sessionCallback({
        session,
        token,
        user: {
          id: '1',
          name: 'Test',
          email: 'test@example.com',
          emailVerified: null,
        },
        trigger: 'update',
        newSession: null,
      } as unknown as Parameters<typeof sessionCallback>[0])) as AnyRecord;

      expect(result.accessToken).toBe('test-access-token');
      expect(result.idToken).toBe('test-id-token');
      expect(result.roles).toEqual(['participant']);
      expect(result.user).toBeUndefined();
    });
  });

  describe('NextAuth 設定', () => {
    it('JWT セッション戦略を使用すべき', async () => {
      const NextAuth = (await import('next-auth')).default;

      await import('../auth');
      const mockCall = vi.mocked(NextAuth).mock.calls[0][0] as NextAuthConfig;

      expect(mockCall.session?.strategy).toBe('jwt');
    });

    it('カスタムログインページを設定すべき', async () => {
      const NextAuth = (await import('next-auth')).default;

      await import('../auth');
      const mockCall = vi.mocked(NextAuth).mock.calls[0][0] as NextAuthConfig;

      expect(mockCall.pages?.signIn).toBe('/login');
    });
  });
});
