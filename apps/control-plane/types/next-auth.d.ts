import type { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  /**
   * セッション型の拡張
   * Keycloak からのトークン情報とロール情報を含める
   */
  interface Session {
    accessToken?: string;
    idToken?: string;
    roles?: string[];
    user: {
      email: string;
      name: string;
    } & DefaultSession['user'];
  }

  /**
   * JWT トークン型の拡張
   */
  interface JWT {
    accessToken?: string;
    refreshToken?: string;
    idToken?: string;
    roles?: string[];
    email?: string;
    name?: string;
  }

  /**
   * Keycloak プロファイル型の拡張
   */
  interface Profile {
    roles?: string[];
    email?: string;
    name?: string;
  }
}
