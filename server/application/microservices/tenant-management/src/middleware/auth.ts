import type { Context, Next } from 'hono';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTVerifyOptions } from 'jose';
import { createLogger } from '../lib/logger';

const logger = createLogger('auth-middleware');

// ── AUTH_SKIP ガード ─────────────────────────────────
/* istanbul ignore next -- Production safety guard */
if (process.env.AUTH_SKIP === '1' && process.env.NODE_ENV === 'production') {
  throw new Error('AUTH_SKIP cannot be enabled in production');
}

const authSkipEnabled =
  process.env.AUTH_SKIP === '1' &&
  process.env.NODE_ENV !== 'production';

/* istanbul ignore next -- Development-only warning */
if (authSkipEnabled && typeof console !== 'undefined') {
  console.warn(
    '\x1b[33m⚠️  AUTH_SKIP mode is enabled in tenant-management. JWT verification is bypassed.\x1b[0m'
  );
}

// ── JWT / JWKS configuration ─────────────────────────
// Primary: generic JWKS_URI / JWT_ISSUER (works with Cognito, Keycloak, etc.)
// Fallback: Auth0-specific AUTH0_DOMAIN derivation
const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN || 'dev-tenkacloud.auth0.com';
const AUTH0_AUDIENCE =
  process.env.AUTH0_AUDIENCE || 'https://api.tenkacloud.com';
const AUTH0_NAMESPACE = 'https://tenkacloud.com';

const JWKS_URL =
  process.env.JWKS_URI ?? `https://${AUTH0_DOMAIN}/.well-known/jwks.json`;
const JWT_ISSUER =
  process.env.JWT_ISSUER ?? `https://${AUTH0_DOMAIN}/`;

// Lazy initialization of JWKS to avoid startup failures
let jwksCache: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJWKS() {
  if (!jwksCache) {
    jwksCache = createRemoteJWKSet(new URL(JWKS_URL));
  }
  return jwksCache;
}

/**
 * Sanitize dev header values to prevent header injection.
 * Only allows alphanumeric, @, ., _, :, /, +, =, comma, hyphen.
 */
function sanitizeDevHeader(
  value: string | undefined,
  fallback: string,
  maxLength = 128,
): string {
  if (!value) {
    return fallback;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }
  const sanitized = trimmed
    .replace(/[^A-Za-z0-9@._:/+=,-]/g, '-')
    .slice(0, maxLength);
  return sanitized || fallback;
}

// User roles enum
export enum UserRole {
  PLATFORM_ADMIN = 'platform-admin',
  TENANT_ADMIN = 'tenant-admin',
  USER = 'user',
}

// JWT payload interface — supports both Auth0 and Cognito claims
export interface JWTPayload {
  sub: string;
  email?: string;
  name?: string;
  nickname?: string;
  picture?: string;
  org_id?: string;
  // Cognito claims
  'cognito:groups'?: string[];
  'custom:tenant_id'?: string;
  [key: `${typeof AUTH0_NAMESPACE}/${string}`]: unknown;
  [key: string]: unknown;
}

// Authenticated user context
export interface AuthenticatedUser {
  id: string;
  email: string;
  username: string;
  roles: string[];
  tenantId?: string;
  organizationId?: string;
}

// Extend Hono context with user info
declare module 'hono' {
  interface ContextVariableMap {
    user: AuthenticatedUser;
  }
}

function extractRoles(payload: JWTPayload): string[] {
  // 1. Cognito: cognito:groups
  const cognitoGroups = payload['cognito:groups'];
  if (Array.isArray(cognitoGroups) && cognitoGroups.length > 0) {
    return cognitoGroups as string[];
  }

  // 2. Auth0: namespace/roles
  const rolesKey = `${AUTH0_NAMESPACE}/roles` as const;
  const roles = payload[rolesKey];
  if (Array.isArray(roles)) {
    return roles as string[];
  }

  return [];
}

function extractTenantId(payload: JWTPayload): string | undefined {
  // 1. Cognito: custom:tenant_id
  const cognitoTenantId = payload['custom:tenant_id'];
  if (typeof cognitoTenantId === 'string' && cognitoTenantId) {
    return cognitoTenantId;
  }

  // 2. Auth0: namespace/tenant_id
  const tenantKey = `${AUTH0_NAMESPACE}/tenant_id` as const;
  const tenantId = payload[tenantKey];
  if (typeof tenantId === 'string') {
    return tenantId;
  }

  return undefined;
}

/**
 * JWT authentication middleware supporting Auth0 and Cognito.
 * Validates JWT token from Authorization header and attaches user info to context.
 */
export async function authMiddleware(c: Context, next: Next) {
  // AUTH_SKIP=1: 開発用に JWT 検証をバイパス（dev ヘッダーで上書き可能）
  if (authSkipEnabled) {
    const devRolesRaw =
      c.req.header('X-TenkaCloud-Dev-Roles') ??
      process.env.AUTH_SKIP_ROLES;
    const devRoles = devRolesRaw
      ? devRolesRaw
          .split(',')
          .map((r) => r.trim())
          .filter(Boolean)
      : [UserRole.PLATFORM_ADMIN];

    const mockUser: AuthenticatedUser = {
      id: sanitizeDevHeader(
        c.req.header('X-TenkaCloud-Dev-User-Id'),
        'dev-user',
      ),
      email: sanitizeDevHeader(
        c.req.header('X-TenkaCloud-Dev-Email'),
        'dev@tenkacloud.local',
      ),
      username: sanitizeDevHeader(
        c.req.header('X-TenkaCloud-Dev-Username'),
        'Dev Admin',
      ),
      roles: devRoles,
      tenantId: sanitizeDevHeader(
        c.req.header('X-TenkaCloud-Dev-Tenant-Id'),
        'dev-tenant',
      ),
    };
    c.set('user', mockUser);
    await next();
    return;
  }

  const authHeader = c.req.header('Authorization');

  if (!authHeader) {
    logger.warn('Missing Authorization header');
    return c.json({ error: 'Unauthorized: Missing Authorization header' }, 401);
  }

  const [bearer, token] = authHeader.split(' ');

  if (bearer !== 'Bearer' || !token) {
    logger.warn('Invalid Authorization header format');
    return c.json({ error: 'Unauthorized: Invalid Authorization format' }, 401);
  }

  try {
    const verifyOptions: JWTVerifyOptions = {
      issuer: JWT_ISSUER,
    };
    const audience = process.env.JWT_AUDIENCE ?? process.env.AUTH0_AUDIENCE ?? AUTH0_AUDIENCE;
    if (audience) {
      verifyOptions.audience = audience;
    }

    const { payload } = await jwtVerify(
      token,
      getJWKS(),
      verifyOptions,
    );

    const jwtPayload = payload as unknown as JWTPayload;

    // Note: email may be empty for M2M (machine-to-machine) tokens using client credentials.
    // Downstream consumers must handle empty email values appropriately.
    const email = jwtPayload.email || '';
    const name = jwtPayload.name || jwtPayload.nickname || email;
    const roles = extractRoles(jwtPayload);
    const tenantId = extractTenantId(jwtPayload);

    const user: AuthenticatedUser = {
      id: jwtPayload.sub,
      email,
      username: name,
      roles,
      tenantId,
      organizationId: jwtPayload.org_id,
    };

    c.set('user', user);

    logger.info(
      { userId: user.id, email: user.email, orgId: user.organizationId },
      'User authenticated'
    );

    await next();
  } catch (error) {
    logger.error({ error }, 'JWT verification failed');
    return c.json({ error: 'Unauthorized: Invalid token' }, 401);
  }
}

/**
 * Role-based access control middleware factory
 * Checks if authenticated user has required roles
 */
export function requireRoles(...requiredRoles: UserRole[]) {
  return async (c: Context, next: Next) => {
    const user = c.get('user');

    if (!user) {
      logger.warn('User not found in context (authMiddleware not applied?)');
      return c.json({ error: 'Unauthorized: No user context' }, 401);
    }

    const hasRequiredRole = requiredRoles.some((role) =>
      user.roles.includes(role)
    );

    if (!hasRequiredRole) {
      logger.warn(
        { userId: user.id, requiredRoles, userRoles: user.roles },
        'Access denied: insufficient permissions'
      );
      return c.json(
        {
          error: 'Forbidden: Insufficient permissions',
          required: requiredRoles,
        },
        403
      );
    }

    logger.info({ userId: user.id, roles: user.roles }, 'Access granted');

    await next();
  };
}

/**
 * Tenant access control middleware
 * Ensures user can only access resources within their tenant
 */
export function requireTenantAccess() {
  return async (c: Context, next: Next) => {
    const user = c.get('user');

    if (!user) {
      return c.json({ error: 'Unauthorized: No user context' }, 401);
    }

    // Platform admins can access all tenants
    if (user.roles.includes(UserRole.PLATFORM_ADMIN)) {
      await next();
      return;
    }

    // For tenant-specific access, check tenant ID from path or header
    const pathTenantId = c.req.param('tenantId');
    const headerTenantId = c.req.header('X-Tenant-ID');
    const requestedTenantId = pathTenantId || headerTenantId;

    if (requestedTenantId && user.tenantId !== requestedTenantId) {
      logger.warn(
        { userId: user.id, userTenantId: user.tenantId, requestedTenantId },
        'Tenant access denied'
      );
      return c.json({ error: 'Forbidden: Cannot access this tenant' }, 403);
    }

    await next();
  };
}

/**
 * Optional authentication middleware
 * Attempts to authenticate but doesn't fail if no token present
 */
export async function optionalAuth(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');

  if (!authHeader) {
    await next();
    return;
  }

  const [bearer, token] = authHeader.split(' ');

  if (bearer !== 'Bearer' || !token) {
    await next();
    return;
  }

  try {
    const verifyOptions: JWTVerifyOptions = {
      issuer: JWT_ISSUER,
    };
    const optAudience = process.env.JWT_AUDIENCE ?? process.env.AUTH0_AUDIENCE ?? AUTH0_AUDIENCE;
    if (optAudience) {
      verifyOptions.audience = optAudience;
    }

    const { payload } = await jwtVerify(
      token,
      getJWKS(),
      verifyOptions,
    );

    const jwtPayload = payload as unknown as JWTPayload;

    // Note: email may be empty for M2M (machine-to-machine) tokens using client credentials.
    // Consistent with authMiddleware, always set user context even with empty email.
    const email = jwtPayload.email || '';
    const name = jwtPayload.name || jwtPayload.nickname || email;
    const roles = extractRoles(jwtPayload);
    const tenantId = extractTenantId(jwtPayload);

    const user: AuthenticatedUser = {
      id: jwtPayload.sub,
      email,
      username: name,
      roles,
      tenantId,
      organizationId: jwtPayload.org_id,
    };

    c.set('user', user);

    logger.info(
      { userId: user.id, email: user.email },
      'User authenticated (optional)'
    );
  } catch (error) {
    logger.debug(
      { error },
      'Optional auth: JWT verification failed, continuing without user'
    );
  }

  await next();
}
