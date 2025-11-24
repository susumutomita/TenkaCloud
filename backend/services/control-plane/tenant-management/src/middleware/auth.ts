import type { Context, Next } from 'hono';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createLogger } from '../lib/logger';

const logger = createLogger('auth-middleware');

// Keycloak configuration
const KEYCLOAK_REALM = process.env.KEYCLOAK_REALM || 'tenkacloud';
const KEYCLOAK_URL = process.env.KEYCLOAK_URL || 'http://localhost:8080';
const JWKS_URL = `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/certs`;

// Cache JWKS
const JWKS = createRemoteJWKSet(new URL(JWKS_URL));

// User roles enum
export enum UserRole {
  PLATFORM_ADMIN = 'platform-admin',
  TENANT_ADMIN = 'tenant-admin',
  USER = 'user',
}

// JWT payload interface
export interface JWTPayload {
  sub: string; // Subject (user ID)
  email: string;
  preferred_username: string;
  realm_access?: {
    roles: string[];
  };
  resource_access?: {
    [key: string]: {
      roles: string[];
    };
  };
}

// Authenticated user context
export interface AuthenticatedUser {
  id: string;
  email: string;
  username: string;
  roles: string[];
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
    // Verify JWT token
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}`,
    });

    // Extract user information
    const jwtPayload = payload as unknown as JWTPayload;
    const roles = jwtPayload.realm_access?.roles || [];

    const user: AuthenticatedUser = {
      id: jwtPayload.sub,
      email: jwtPayload.email,
      username: jwtPayload.preferred_username,
      roles,
    };

    // Attach user to context
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
    // Invalid format, but optional auth should continue
    await next();
    return;
  }

  try {
    // Verify JWT token
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}`,
    });

    // Extract user information
    const jwtPayload = payload as unknown as JWTPayload;
    const roles = jwtPayload.realm_access?.roles || [];

    const user: AuthenticatedUser = {
      id: jwtPayload.sub,
      email: jwtPayload.email,
      username: jwtPayload.preferred_username,
      roles,
    };

    // Attach user to context
    c.set('user', user);

    logger.info({ userId: user.id, email: user.email }, 'User authenticated (optional)');
  } catch (error) {
    // JWT verification failed, but optional auth should continue
    logger.debug({ error }, 'Optional auth: JWT verification failed, continuing without user');
  }

  await next();
}
