import type { Context, Next } from 'hono';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createLogger } from '../lib/logger';

const logger = createLogger('auth-middleware');

// Auth0 configuration
const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN || 'dev-tenkacloud.auth0.com';
const AUTH0_AUDIENCE =
  process.env.AUTH0_AUDIENCE || 'https://api.tenkacloud.com';
const JWKS_URL = `https://${AUTH0_DOMAIN}/.well-known/jwks.json`;
const AUTH0_NAMESPACE = 'https://tenkacloud.com';

// Lazy initialization of JWKS to avoid startup failures
let jwksCache: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJWKS() {
  if (!jwksCache) {
    jwksCache = createRemoteJWKSet(new URL(JWKS_URL));
  }
  return jwksCache;
}

// User roles enum
export enum UserRole {
  PLATFORM_ADMIN = 'platform-admin',
  TENANT_ADMIN = 'tenant-admin',
  USER = 'user',
}

// Auth0 JWT payload interface
export interface JWTPayload {
  sub: string;
  email?: string;
  name?: string;
  nickname?: string;
  picture?: string;
  org_id?: string;
  [key: `${typeof AUTH0_NAMESPACE}/${string}`]: unknown;
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
  const rolesKey = `${AUTH0_NAMESPACE}/roles` as const;
  const roles = payload[rolesKey];
  if (Array.isArray(roles)) {
    return roles as string[];
  }
  return [];
}

function extractTenantId(payload: JWTPayload): string | undefined {
  const tenantKey = `${AUTH0_NAMESPACE}/tenant_id` as const;
  const tenantId = payload[tenantKey];
  if (typeof tenantId === 'string') {
    return tenantId;
  }
  return undefined;
}

/**
 * JWT authentication middleware for Auth0
 * Validates JWT token from Authorization header and attaches user info to context
 */
export async function authMiddleware(c: Context, next: Next) {
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
    const { payload } = await jwtVerify(token, getJWKS(), {
      issuer: `https://${AUTH0_DOMAIN}/`,
      audience: AUTH0_AUDIENCE,
    });

    const jwtPayload = payload as unknown as JWTPayload;

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
    const { payload } = await jwtVerify(token, getJWKS(), {
      issuer: `https://${AUTH0_DOMAIN}/`,
      audience: AUTH0_AUDIENCE,
    });

    const jwtPayload = payload as unknown as JWTPayload;

    const email = jwtPayload.email || '';
    const name = jwtPayload.name || jwtPayload.nickname || email;
    const roles = extractRoles(jwtPayload);
    const tenantId = extractTenantId(jwtPayload);

    if (email) {
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
    }
  } catch (error) {
    logger.debug(
      { error },
      'Optional auth: JWT verification failed, continuing without user'
    );
  }

  await next();
}
