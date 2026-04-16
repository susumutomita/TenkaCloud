import NextAuth from 'next-auth';
import type { Session } from 'next-auth';
import Cognito from 'next-auth/providers/cognito';
import { isAuthSkipEnabled } from '@/lib/auth/is-auth-skip-enabled';

const getEnv = (key: string) => process.env[key];
const skipProviderValidation =
  getEnv('SKIP_AUTH0_VALIDATION') === '1' ||
  getEnv('SKIP_PROVIDER_VALIDATION') === '1';
const isBuildPhase = process.env.NEXT_PHASE === 'phase-production-build';
let authSkipEnabled: boolean;
try {
  authSkipEnabled = isAuthSkipEnabled();
} catch {
  authSkipEnabled = false;
}
const useStubAuth =
  authSkipEnabled || (isBuildPhase && process.env.AUTH_SKIP === '1');

/**
 * Mock session for AUTH_SKIP=1 (local development only).
 * Control Plane manages all tenants, so no tenantId/teamId.
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

/* v8 ignore start -- Development-only warning */
if (authSkipEnabled && typeof console !== 'undefined') {
  console.warn(
    '\x1b[33m⚠️  AUTH_SKIP mode is enabled. Authentication is bypassed with a mock session.\x1b[0m',
  );
  console.warn(
    '\x1b[33m   This should only be used for local development.\x1b[0m',
  );
}
/* v8 ignore stop */

// Cognito configuration (falls back to Auth0 env vars for backward compatibility)
const cognitoConfig = {
  clientId:
    getEnv('COGNITO_CLIENT_ID') ??
    getEnv('AUTH0_CLIENT_ID') ??
    (skipProviderValidation || useStubAuth ? 'stub-client-id' : undefined),
  clientSecret:
    getEnv('COGNITO_CLIENT_SECRET') ??
    getEnv('AUTH0_CLIENT_SECRET') ??
    (skipProviderValidation || useStubAuth ? 'stub-client-secret' : undefined),
  issuer:
    getEnv('COGNITO_ISSUER') ??
    getEnv('AUTH0_ISSUER') ??
    (skipProviderValidation || useStubAuth ? 'https://example.com' : undefined),
};

if (
  !skipProviderValidation &&
  !useStubAuth &&
  (!cognitoConfig.clientId ||
    !cognitoConfig.clientSecret ||
    !cognitoConfig.issuer)
) {
  throw new Error(
    'Missing required auth environment variables. Set COGNITO_CLIENT_ID, COGNITO_CLIENT_SECRET, COGNITO_ISSUER ' +
      '(or legacy AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET, AUTH0_ISSUER)',
  );
}

const nextAuth = NextAuth({
  providers: [Cognito(cognitoConfig)],
  callbacks: {
    async jwt({ token, account, profile }) {
      if (account) {
        token.accessToken = account.access_token;
        token.refreshToken = account.refresh_token;
        token.idToken = account.id_token;
      }

      if (profile) {
        // Cognito custom attributes: custom:role, cognito:groups
        // Also support Auth0-style namespace claims for backward compat
        const cognitoGroups = profile['cognito:groups'] as string[] | undefined;
        const auth0Roles = profile['https://tenkacloud.com/roles'] as
          | string[]
          | undefined;
        token.roles =
          cognitoGroups ?? auth0Roles ?? (profile.roles as string[]) ?? [];
        token.email = (profile.email as string) ?? token.email;
        token.name = (profile.name as string) ?? token.name;
        token.picture = (profile.picture as string) ?? token.picture;
      }

      return token;
    },
    async session({ session, token }) {
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
export const auth = nextAuth.auth;
export { authSkipEnabled };

export async function getSession(): Promise<Session | null> {
  if (process.env.AUTH_SKIP === '1') {
    return mockSession;
  }
  return nextAuth.auth();
}
