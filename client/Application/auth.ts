import NextAuth from 'next-auth';
import type { Session } from 'next-auth';
import Cognito from 'next-auth/providers/cognito';
import { isAuthSkipEnabled } from '@/lib/auth/is-auth-skip-enabled';
import { parseAuthSkipRoles } from '@/lib/auth/roles';

const getEnv = (key: string) => process.env[key];
/* istanbul ignore next -- production guard branches not testable in unit tests */
const skipProviderValidation =
  process.env.NODE_ENV !== 'production' &&
  (getEnv('SKIP_AUTH0_VALIDATION') === '1' ||
    getEnv('SKIP_PROVIDER_VALIDATION') === '1');
/* istanbul ignore next -- build phase only triggers during `next build` */
const isBuildPhase = process.env.NEXT_PHASE === 'phase-production-build';
let authSkipEnabled: boolean;
try {
  authSkipEnabled = isAuthSkipEnabled();
} catch {
  // Caught only when AUTH_SKIP=1 && NODE_ENV=production (e.g. local build).
  authSkipEnabled = false;
}
/* istanbul ignore next -- build phase only triggers during `next build` */
const useStubAuth =
  authSkipEnabled || (isBuildPhase && process.env.AUTH_SKIP === '1');
const authSkipRoles = parseAuthSkipRoles(process.env.AUTH_SKIP_ROLES);

/**
 * Mock session for AUTH_SKIP=1 (local development only).
 * Application Plane includes tenantId and teamId.
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
  roles: authSkipRoles,
  tenantId: 'dev-tenant',
  teamId: 'team-alpha',
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
const stubFallback = skipProviderValidation || useStubAuth;
/* istanbul ignore next -- stub only used when AUTH_SKIP=1 or SKIP_PROVIDER_VALIDATION=1 */
const stub = stubFallback
  ? {
      id: 'stub-client-id',
      secret: 'stub-client-secret',
      iss: 'https://example.com',
    }
  : { id: undefined, secret: undefined, iss: undefined };
const cognitoConfig = {
  clientId: getEnv('COGNITO_CLIENT_ID') ?? getEnv('AUTH0_CLIENT_ID') ?? stub.id,
  clientSecret:
    getEnv('COGNITO_CLIENT_SECRET') ??
    getEnv('AUTH0_CLIENT_SECRET') ??
    stub.secret,
  issuer: getEnv('COGNITO_ISSUER') ?? getEnv('AUTH0_ISSUER') ?? stub.iss,
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
        // Cognito: cognito:groups, custom:tenant_id, custom:team_id
        // Auth0 fallback: namespace claims
        const namespace = 'https://tenkacloud.com';
        const cognitoGroups = profile['cognito:groups'] as string[] | undefined;
        const auth0Roles = profile[`${namespace}/roles`] as
          | string[]
          | undefined;
        token.roles =
          cognitoGroups ?? auth0Roles ?? (profile.roles as string[]) ?? [];

        const cognitoTenantId = profile['custom:tenant_id'] as
          | string
          | undefined;
        const auth0TenantId = profile[`${namespace}/tenant_id`] as
          | string
          | undefined;
        token.tenantId = cognitoTenantId ?? auth0TenantId ?? null;

        const cognitoTeamId = profile['custom:team_id'] as string | undefined;
        const auth0TeamId = profile[`${namespace}/team_id`] as
          | string
          | undefined;
        token.teamId = cognitoTeamId ?? auth0TeamId ?? null;

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

// AUTH_SKIP=1 returns mock session
export const auth = authSkipEnabled ? async () => mockSession : nextAuth.auth;

export { authSkipEnabled, mockSession };

export async function getSession(): Promise<Session | null> {
  if (authSkipEnabled) {
    return mockSession;
  }
  return nextAuth.auth();
}
