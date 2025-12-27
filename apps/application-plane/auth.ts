import NextAuth from 'next-auth';
import type { Session } from 'next-auth';
import Auth0 from 'next-auth/providers/auth0';

const getEnv = (key: string) => process.env[key];
const authSkipEnabled = getEnv('AUTH_SKIP') === '1';

/**
 * モックセッション（AUTH_SKIP=1 の場合に使用）
 *
 * Application Plane は特定テナントのビジネスロジックを実行するため、
 * tenantId と teamId を含む。開発時はデフォルト値を使用。
 */
const mockSession: Session = {
  user: {
    name: 'Dev User',
    email: 'dev@example.com',
    image: undefined,
  },
  expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  accessToken: 'mock-access-token',
  idToken: 'mock-id-token',
  roles: ['participant'],
  tenantId: 'dev-tenant',
  teamId: 'dev-team',
};

// AUTH_SKIP モードの警告
/* v8 ignore start -- Development-only warning */
if (authSkipEnabled && typeof console !== 'undefined') {
  console.warn(
    '\x1b[33m⚠️  AUTH_SKIP mode is enabled. Authentication is bypassed with a mock session.\x1b[0m'
  );
  console.warn(
    '\x1b[33m   This should only be used for local development.\x1b[0m'
  );
}
/* v8 ignore stop */

// Auth0 設定のバリデーション
/* v8 ignore start -- Stub config only used when AUTH_SKIP=1 */
const stubConfig = authSkipEnabled
  ? {
      clientId: 'stub-client-id',
      clientSecret: 'stub-client-secret',
      issuer: 'https://example.com',
    }
  : { clientId: undefined, clientSecret: undefined, issuer: undefined };
/* v8 ignore stop */

const auth0Config = {
  clientId: getEnv('AUTH0_CLIENT_ID') ?? stubConfig.clientId,
  clientSecret: getEnv('AUTH0_CLIENT_SECRET') ?? stubConfig.clientSecret,
  issuer: getEnv('AUTH0_ISSUER') ?? stubConfig.issuer,
};

/* v8 ignore start -- Module-level validation tested in auth.test.ts */
if (
  !authSkipEnabled &&
  (!auth0Config.clientId || !auth0Config.clientSecret || !auth0Config.issuer)
) {
  throw new Error(
    'Missing required Auth0 environment variables: AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET, AUTH0_ISSUER'
  );
}
/* v8 ignore stop */

const nextAuth = NextAuth({
  providers: [Auth0(auth0Config)],
  callbacks: {
    async jwt({ token, account, profile }) {
      // アクセストークンとリフレッシュトークンを JWT に保存
      if (account) {
        token.accessToken = account.access_token;
        token.refreshToken = account.refresh_token;
        token.idToken = account.id_token;
      }

      // Auth0 のユーザー情報を JWT に保存
      if (profile) {
        // Auth0 のカスタムクレームからロールとテナント情報を取得
        const namespace = 'https://tenkacloud.com';
        token.roles =
          (profile[`${namespace}/roles`] as string[]) ||
          (profile.roles as string[]) ||
          [];
        token.tenantId = (profile[`${namespace}/tenant_id`] as string) || null;
        token.teamId = (profile[`${namespace}/team_id`] as string) || null;
        token.email = profile.email as string;
        token.name = profile.name as string;
        token.picture = profile.picture as string;
      }

      return token;
    },
    async session({ session, token }) {
      // JWT のトークン情報をセッションに含める
      session.accessToken = token.accessToken as string;
      session.idToken = token.idToken as string;
      session.roles = token.roles as string[];
      session.tenantId = token.tenantId as string | null;
      session.teamId = token.teamId as string | null;

      if (session.user) {
        session.user.email = token.email as string;
        session.user.name = token.name as string;
        session.user.image = token.picture as string;
      }

      return session;
    },
  },
  session: {
    strategy: 'jwt',
  },
  pages: {
    signIn: '/login',
  },
});

export const { handlers, signIn, signOut } = nextAuth;

// AUTH_SKIP=1 の場合はモックセッションを返す
export const auth = authSkipEnabled ? async () => mockSession : nextAuth.auth;
