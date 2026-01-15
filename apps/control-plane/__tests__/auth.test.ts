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
    delete process.env.AUTH_SKIP;
    delete process.env.SKIP_AUTH0_VALIDATION;
  });

  describe('AUTH_SKIP モード', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.resetModules();
      delete process.env.AUTH0_CLIENT_ID;
      delete process.env.AUTH0_CLIENT_SECRET;
      delete process.env.AUTH0_ISSUER;
    });

    it('AUTH_SKIP=1 の場合、モックセッションを返すべき', async () => {
      process.env.AUTH_SKIP = '1';

      const auth = await import('../auth');
      const session = await auth.getSession();

      expect(session).toBeDefined();
      expect(session?.user?.name).toBe('Dev User');
      expect(session?.user?.email).toBe('dev@example.com');
      expect(session?.roles).toEqual(['admin']);
      expect(session?.accessToken).toBe('mock-access-token');
      expect(session?.idToken).toBe('mock-id-token');
    });

    it('AUTH_SKIP=1 の場合、Auth0 環境変数がなくてもエラーにならないべき', async () => {
      process.env.AUTH_SKIP = '1';

      await expect(import('../auth')).resolves.toBeDefined();
    });

    it('AUTH_SKIP=1 の場合、モックセッションに tenantId/teamId が含まれないべき（Control Plane は全テナント管理者向け）', async () => {
      process.env.AUTH_SKIP = '1';

      const auth = await import('../auth');
      const session = await auth.getSession();

      // Control Plane はテナント横断の管理画面のため、
      // 特定のテナントに紐付かない
      const sessionRecord = session as AnyRecord;
      expect(sessionRecord?.tenantId).toBeUndefined();
      expect(sessionRecord?.teamId).toBeUndefined();
    });
  });

  describe('SKIP_AUTH0_VALIDATION モード', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.resetModules();
      delete process.env.AUTH0_CLIENT_ID;
      delete process.env.AUTH0_CLIENT_SECRET;
      delete process.env.AUTH0_ISSUER;
    });

    it('SKIP_AUTH0_VALIDATION=1 の場合、Auth0 環境変数がなくてもエラーにならないべき', async () => {
      process.env.SKIP_AUTH0_VALIDATION = '1';

      await expect(import('../auth')).resolves.toBeDefined();
    });
  });

  it('必須の環境変数が欠けている場合はエラーを投げるべき', async () => {
    process.env.AUTH0_CLIENT_ID = '';
    process.env.AUTH0_CLIENT_SECRET = '';
    process.env.AUTH0_ISSUER = '';

    await expect(import('../auth')).rejects.toThrow(
      'Missing required Auth0 environment variables'
    );
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

    it('Auth0 カスタムクレームからロールを取得すべき', async () => {
      const NextAuth = (await import('next-auth')).default;

      await import('../auth');
      const mockCall = vi.mocked(NextAuth).mock.calls[0][0] as NextAuthConfig;
      const jwtCallback = mockCall.callbacks?.jwt;

      if (!jwtCallback) throw new Error('JWT callback not defined');

      const token = {};
      const profile = {
        'https://tenkacloud.com/roles': ['admin', 'super_admin'],
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

      expect(result.roles).toEqual(['admin', 'super_admin']);
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
    it('JWT からセッションにロール情報を含めるべき', async () => {
      const NextAuth = (await import('next-auth')).default;

      await import('../auth');
      const mockCall = vi.mocked(NextAuth).mock.calls[0][0] as NextAuthConfig;
      const sessionCallback = mockCall.callbacks?.session;

      if (!sessionCallback) throw new Error('Session callback not defined');

      const token = {
        accessToken: 'test-access-token',
        idToken: 'test-id-token',
        roles: ['admin'],
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
      expect(result.roles).toEqual(['admin']);
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
        roles: ['admin'],
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
      expect(result.roles).toEqual(['admin']);
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
