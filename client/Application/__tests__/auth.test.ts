import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { NextAuthConfig } from 'next-auth';

vi.mock('next-auth', () => ({
  default: vi.fn((config) => ({
    handlers: { GET: vi.fn(), POST: vi.fn() },
    signIn: vi.fn(),
    signOut: vi.fn(),
    auth: vi.fn(),
  })),
}));

vi.mock('next-auth/providers/cognito', () => ({
  default: vi.fn((options) => ({
    id: 'cognito',
    name: 'Cognito',
    type: 'oidc',
    ...options,
  })),
}));

vi.mock('@/lib/auth/is-auth-skip-enabled', () => ({
  isAuthSkipEnabled: () =>
    process.env.AUTH_SKIP === '1' && process.env.NODE_ENV !== 'production',
}));

vi.mock('@/lib/auth/roles', () => ({
  parseAuthSkipRoles: (envValue?: string) => {
    if (!envValue) return ['participant'];
    const roles = envValue
      .split(',')
      .map((role: string) => role.trim())
      .filter(Boolean);
    return roles.length > 0 ? roles : ['participant'];
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

describe('Cognito 認証設定', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env.COGNITO_CLIENT_ID = 'test-client-id';
    process.env.COGNITO_CLIENT_SECRET = 'test-client-secret';
    process.env.COGNITO_ISSUER =
      'https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_test';
    delete process.env.AUTH0_CLIENT_ID;
    delete process.env.AUTH0_CLIENT_SECRET;
    delete process.env.AUTH0_ISSUER;
    delete process.env.AUTH_SKIP;
    delete process.env.AUTH_SKIP_ROLES;
    delete process.env.SKIP_PROVIDER_VALIDATION;
    delete process.env.SKIP_AUTH0_VALIDATION;
  });

  describe('AUTH_SKIP モード', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.resetModules();
      delete process.env.COGNITO_CLIENT_ID;
      delete process.env.COGNITO_CLIENT_SECRET;
      delete process.env.COGNITO_ISSUER;
      delete process.env.AUTH0_CLIENT_ID;
      delete process.env.AUTH0_CLIENT_SECRET;
      delete process.env.AUTH0_ISSUER;
    });

    it('AUTH_SKIP=1 の場合、モックユーザー情報を返すべき', async () => {
      process.env.AUTH_SKIP = '1';

      const auth = await import('../auth');
      const session = await auth.auth();

      expect(session).toBeDefined();
      expect(session?.user?.name).toBe('Dev User');
      expect(session?.user?.email).toBe('dev@example.com');
    });

    it('AUTH_SKIP=1 の場合、デフォルトロールとテナント情報を返すべき', async () => {
      process.env.AUTH_SKIP = '1';

      const auth = await import('../auth');
      const session = await auth.auth();

      expect(session?.roles).toEqual(['participant']);
      expect(session?.tenantId).toBe('dev-tenant');
      expect(session?.teamId).toBe('team-alpha');
    });

    it('AUTH_SKIP=1 の場合、モックトークンを返すべき', async () => {
      process.env.AUTH_SKIP = '1';

      const auth = await import('../auth');
      const session = await auth.auth();

      expect(session?.accessToken).toBe('mock-access-token');
      expect(session?.idToken).toBe('mock-id-token');
    });

    it('AUTH_SKIP_ROLES を指定した場合、そのロール構成を使うべき', async () => {
      process.env.AUTH_SKIP = '1';
      process.env.AUTH_SKIP_ROLES = 'tenant-admin,participant';

      const auth = await import('../auth');
      const session = await auth.auth();

      expect(session?.roles).toEqual(['tenant-admin', 'participant']);
    });

    it('AUTH_SKIP=1 の場合、Cognito 環境変数がなくてもエラーにならないべき', async () => {
      process.env.AUTH_SKIP = '1';

      await expect(import('../auth')).resolves.toBeDefined();
    });

    it('AUTH_SKIP=1 の場合、モックセッションに tenantId/teamId が含まれるべき', async () => {
      process.env.AUTH_SKIP = '1';

      const auth = await import('../auth');
      const session = await auth.auth();

      expect(session?.tenantId).toBe('dev-tenant');
      expect(session?.teamId).toBe('team-alpha');
    });

    it('getSession() でもモックセッションを返すべき', async () => {
      process.env.AUTH_SKIP = '1';

      const auth = await import('../auth');
      const session = await auth.getSession();

      expect(session?.user?.name).toBe('Dev User');
      expect(session?.tenantId).toBe('dev-tenant');
    });
  });

  describe('isAuthSkipEnabled が例外を投げる場合', () => {
    it('catch ブロックで authSkipEnabled を false にすべき', async () => {
      vi.resetModules();
      vi.doMock('@/lib/auth/is-auth-skip-enabled', () => ({
        isAuthSkipEnabled: () => {
          throw new Error('AUTH_SKIP is not allowed in production');
        },
      }));

      process.env.COGNITO_CLIENT_ID = 'test-client-id';
      process.env.COGNITO_CLIENT_SECRET = 'test-client-secret';
      process.env.COGNITO_ISSUER =
        'https://cognito-idp.ap-northeast-1.amazonaws.com/test';

      const auth = await import('../auth');
      expect(auth.handlers).toBeDefined();
      expect(auth.auth).toBeDefined();
    });
  });

  it('必須の環境変数が欠けている場合はエラーを投げるべき', async () => {
    process.env.COGNITO_CLIENT_ID = '';
    process.env.COGNITO_CLIENT_SECRET = '';
    process.env.COGNITO_ISSUER = '';

    await expect(import('../auth')).rejects.toThrow(
      'Missing required auth environment variables',
    );
  });

  it('Auth0 環境変数へのフォールバックが動作すべき', async () => {
    delete process.env.COGNITO_CLIENT_ID;
    delete process.env.COGNITO_CLIENT_SECRET;
    delete process.env.COGNITO_ISSUER;
    process.env.AUTH0_CLIENT_ID = 'auth0-client-id';
    process.env.AUTH0_CLIENT_SECRET = 'auth0-client-secret';
    process.env.AUTH0_ISSUER = 'https://test.auth0.com';

    const Cognito = (await import('next-auth/providers/cognito')).default;
    await import('../auth');

    expect(Cognito).toHaveBeenCalledWith({
      clientId: 'auth0-client-id',
      clientSecret: 'auth0-client-secret',
      issuer: 'https://test.auth0.com',
    });
  });

  it('SKIP_PROVIDER_VALIDATION=1 の場合、環境変数なしでもエラーにならないべき', async () => {
    delete process.env.COGNITO_CLIENT_ID;
    delete process.env.COGNITO_CLIENT_SECRET;
    delete process.env.COGNITO_ISSUER;
    delete process.env.AUTH0_CLIENT_ID;
    delete process.env.AUTH0_CLIENT_SECRET;
    delete process.env.AUTH0_ISSUER;
    process.env.SKIP_PROVIDER_VALIDATION = '1';

    await expect(import('../auth')).resolves.toBeDefined();
  });

  it('handlers と auth がエクスポートされるべき', async () => {
    const auth = await import('../auth');
    expect(auth.handlers).toBeDefined();
    expect(auth.auth).toBeDefined();
  });

  it('signIn と signOut がエクスポートされるべき', async () => {
    const auth = await import('../auth');
    expect(auth.signIn).toBeDefined();
    expect(auth.signOut).toBeDefined();
  });

  it('getSession() は AUTH_SKIP 無効時に nextAuth.auth() を呼ぶべき', async () => {
    const NextAuth = (await import('next-auth')).default;
    const auth = await import('../auth');

    const session = await auth.getSession();
    // nextAuth.auth is mocked to return undefined, so session should be falsy
    expect(session).toBeUndefined();

    // Verify that nextAuth.auth was actually called
    const nextAuthInstance = vi.mocked(NextAuth).mock.results[0]?.value;
    expect(nextAuthInstance.auth).toHaveBeenCalled();
  });

  it('Cognito プロバイダが環境変数から設定されるべき', async () => {
    const Cognito = (await import('next-auth/providers/cognito')).default;
    await import('../auth');

    expect(Cognito).toHaveBeenCalledWith({
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      issuer:
        'https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_test',
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

    it('Cognito の cognito:groups からロールを取得すべき', async () => {
      const NextAuth = (await import('next-auth')).default;

      await import('../auth');
      const mockCall = vi.mocked(NextAuth).mock.calls[0][0] as NextAuthConfig;
      const jwtCallback = mockCall.callbacks?.jwt;

      if (!jwtCallback) throw new Error('JWT callback not defined');

      const token = {};
      const profile = {
        'cognito:groups': ['participant', 'team_lead'],
        'custom:tenant_id': 'tenant-cognito-123',
        'custom:team_id': 'team-cognito-456',
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
      expect(result.tenantId).toBe('tenant-cognito-123');
      expect(result.teamId).toBe('team-cognito-456');
    });

    it('Auth0 カスタムクレームにフォールバックすべき', async () => {
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

    it('profile に email/name がない場合、token の既存値を維持すべき', async () => {
      const NextAuth = (await import('next-auth')).default;

      await import('../auth');
      const mockCall = vi.mocked(NextAuth).mock.calls[0][0] as NextAuthConfig;
      const jwtCallback = mockCall.callbacks?.jwt;

      if (!jwtCallback) throw new Error('JWT callback not defined');

      const token = { email: 'existing@example.com', name: 'Existing User' };
      const profile = {
        'cognito:groups': ['participant'],
      };

      const result = (await jwtCallback({
        token,
        profile,
        user: { id: '1', name: 'Test', email: 'test@example.com' },
        trigger: 'signIn',
      } as Parameters<typeof jwtCallback>[0])) as AnyRecord;

      expect(result.email).toBe('existing@example.com');
      expect(result.name).toBe('Existing User');
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
    async function callSessionCallback() {
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

      return (await sessionCallback({
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
    }

    it('JWT からセッションにトークン情報を含めるべき', async () => {
      const result = await callSessionCallback();
      expect(result.accessToken).toBe('test-access-token');
      expect(result.idToken).toBe('test-id-token');
    });

    it('JWT からセッションにロール情報を含めるべき', async () => {
      const result = await callSessionCallback();
      expect(result.roles).toEqual(['participant']);
    });

    it('JWT からセッションにテナント・チーム情報を含めるべき', async () => {
      const result = await callSessionCallback();
      expect(result.tenantId).toBe('tenant-123');
      expect(result.teamId).toBe('team-456');
    });

    it('JWT からセッションにユーザープロフィールを含めるべき', async () => {
      const result = await callSessionCallback();
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
