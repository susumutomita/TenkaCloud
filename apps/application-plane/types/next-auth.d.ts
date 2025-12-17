import type { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  /**
   * セッション型の拡張
   * Auth0 からのトークン情報、ロール、テナント情報を含める
   */
  interface Session {
    accessToken?: string;
    idToken?: string;
    roles?: string[];
    tenantId?: string | null;
    teamId?: string | null;
    user: {
      email: string;
      name: string;
      image?: string;
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
    tenantId?: string | null;
    teamId?: string | null;
    email?: string;
    name?: string;
    picture?: string;
  }

  /**
   * Auth0 プロファイル型の拡張
   */
  interface Profile {
    roles?: string[];
    email?: string;
    name?: string;
    picture?: string;
    'https://tenkacloud.com/roles'?: string[];
    'https://tenkacloud.com/tenant_id'?: string;
    'https://tenkacloud.com/team_id'?: string;
    [key: string]: unknown;
  }
}
