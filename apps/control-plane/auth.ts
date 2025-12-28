import NextAuth from 'next-auth';
import type { Session } from 'next-auth';
import Auth0 from 'next-auth/providers/auth0';

const getEnv = (key: string) => process.env[key];
const skipAuth0Validation = getEnv('SKIP_AUTH0_VALIDATION') === '1';
const authSkipEnabled = getEnv('AUTH_SKIP') === '1';

/**
 * モックセッション（AUTH_SKIP=1 の場合に使用）
 *
 * Control Plane は全テナントを管理する画面のため、
 * 特定の tenantId/teamId には紐付かない。
 * そのため、Application Plane と異なり tenantId/teamId を含まない。
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
  roles: ['admin'],
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
const auth0Config = {
  clientId:
    getEnv('AUTH0_CLIENT_ID') ??
    (skipAuth0Validation || authSkipEnabled ? 'stub-client-id' : undefined),
  clientSecret:
    getEnv('AUTH0_CLIENT_SECRET') ??
    (skipAuth0Validation || authSkipEnabled ? 'stub-client-secret' : undefined),
  issuer:
    getEnv('AUTH0_ISSUER') ??
    (skipAuth0Validation || authSkipEnabled
      ? 'https://example.com'
      : undefined),
};

if (
  !skipAuth0Validation &&
  !authSkipEnabled &&
  (!auth0Config.clientId || !auth0Config.clientSecret || !auth0Config.issuer)
) {
  throw new Error(
    'Missing required Auth0 environment variables: AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET, AUTH0_ISSUER'
  );
}

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
        // Auth0 のカスタムクレームからロールを取得
        const namespace = 'https://tenkacloud.com';
        token.roles =
          (profile[`${namespace}/roles`] as string[]) ||
          (profile.roles as string[]) ||
          [];
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
