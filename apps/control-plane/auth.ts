import NextAuth from 'next-auth';
import Auth0 from 'next-auth/providers/auth0';

const getEnv = (key: string) => process.env[key];
const skipAuth0Validation = getEnv('SKIP_AUTH0_VALIDATION') === '1';

// Auth0 設定のバリデーション
const auth0Config = {
  clientId:
    getEnv('AUTH0_CLIENT_ID') ??
    (skipAuth0Validation ? 'stub-client-id' : undefined),
  clientSecret:
    getEnv('AUTH0_CLIENT_SECRET') ??
    (skipAuth0Validation ? 'stub-client-secret' : undefined),
  issuer:
    getEnv('AUTH0_ISSUER') ??
    (skipAuth0Validation ? 'https://example.com' : undefined),
};

if (
  !skipAuth0Validation &&
  (!auth0Config.clientId || !auth0Config.clientSecret || !auth0Config.issuer)
) {
  throw new Error(
    'Missing required Auth0 environment variables: AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET, AUTH0_ISSUER'
  );
}

export const { handlers, signIn, signOut, auth } = NextAuth({
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
