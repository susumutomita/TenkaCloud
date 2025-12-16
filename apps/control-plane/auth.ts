import NextAuth from 'next-auth';
import Auth0 from 'next-auth/providers/auth0';

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Auth0({
      clientId: process.env.AUTH0_CLIENT_ID,
      clientSecret: process.env.AUTH0_CLIENT_SECRET,
      issuer: process.env.AUTH0_ISSUER,
    }),
  ],
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
