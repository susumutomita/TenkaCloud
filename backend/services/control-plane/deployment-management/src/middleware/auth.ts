import type { Context, Next } from 'hono';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createLogger } from '../lib/logger';

const logger = createLogger('auth-middleware');

// Keycloak configuration
const KEYCLOAK_REALM = process.env.KEYCLOAK_REALM || 'tenkacloud';
const KEYCLOAK_URL = process.env.KEYCLOAK_URL || 'http://localhost:8080';
const JWKS_URL = `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/certs`;

// Lazy initialization of JWKS to avoid startup failures when Keycloak is not available
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

// JWT payload interface
export interface JWTPayload {
  sub: string;
  email?: string;
  preferred_username?: string;
  tenant_id?: string;
  realm_access?: {
    roles: string[];
  };
}

// Authenticated user context
export interface AuthenticatedUser {
  id: string;
  email: string;
  username: string;
  roles: string[];
  tenantId?: string;
}

// Extend Hono context with user info
declare module 'hono' {
  interface ContextVariableMap {
    user: AuthenticatedUser;
  }
}

/**
 * JWT authentication middleware
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
      issuer: `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}`,
    });

    const jwtPayload = payload as unknown as JWTPayload;

    if (!jwtPayload.email || !jwtPayload.preferred_username) {
      logger.error(
        { payload: jwtPayload },
        'JWT payload missing required fields'
      );
      return c.json({ error: 'Unauthorized: Invalid token claims' }, 401);
    }

    const roles = jwtPayload.realm_access?.roles || [];

    const user: AuthenticatedUser = {
      id: jwtPayload.sub,
      email: jwtPayload.email,
      username: jwtPayload.preferred_username,
      roles,
      tenantId: jwtPayload.tenant_id,
    };

    c.set('user', user);

    logger.info({ userId: user.id, email: user.email }, 'User authenticated');

    await next();
  } catch (error) {
    logger.error({ error }, 'JWT verification failed');
    return c.json({ error: 'Unauthorized: Invalid token' }, 401);
  }
}

/**
 * Role-based access control middleware factory
 */
export function requireRoles(...requiredRoles: UserRole[]) {
  return async (c: Context, next: Next) => {
    const user = c.get('user');

    if (!user) {
      logger.warn('User not found in context');
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

    await next();
  };
}
