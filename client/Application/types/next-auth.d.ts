import type { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  /**
   * Session type extension.
   * Includes token info, roles, and tenant context from Cognito/Auth0.
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
   * Profile type extension for Cognito and Auth0 claims.
   */
  interface Profile {
    roles?: string[];
    email?: string;
    name?: string;
    picture?: string;
    // Cognito claims
    'cognito:groups'?: string[];
    'custom:tenant_id'?: string;
    'custom:team_id'?: string;
    // Auth0 legacy claims
    'https://tenkacloud.com/roles'?: string[];
    'https://tenkacloud.com/tenant_id'?: string;
    'https://tenkacloud.com/team_id'?: string;
    [key: string]: unknown;
  }
}
