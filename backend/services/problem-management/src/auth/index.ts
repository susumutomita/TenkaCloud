/**
 * 認証・認可システム
 *
 * control-plane の Keycloak 認証を再利用
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';

// Keycloak configuration
const KEYCLOAK_REALM = process.env.KEYCLOAK_REALM || 'tenkacloud';
const KEYCLOAK_URL = process.env.KEYCLOAK_URL || 'http://localhost:8080';
const JWKS_URL = `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/certs`;

// Lazy initialization of JWKS
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
  ORGANIZER = 'organizer',
  COMPETITOR = 'competitor',
  SPECTATOR = 'spectator',
}

// JWT payload interface (Keycloak 互換)
export interface JWTPayload {
  sub: string;
  email?: string;
  preferred_username?: string;
  realm_access?: {
    roles: string[];
  };
  resource_access?: {
    [key: string]: {
      roles: string[];
    };
  };
  // TenkaCloud 拡張
  teamId?: string;
  tenantId?: string;
}

// Authenticated user context
export interface AuthenticatedUser {
  id: string;
  email: string;
  username: string;
  roles: string[];
  teamId?: string;
  tenantId?: string;
}

/**
 * JWT トークンを検証してユーザー情報を取得
 */
export async function verifyToken(token: string): Promise<AuthenticatedUser | null> {
  try {
    const { payload } = await jwtVerify(token, getJWKS(), {
      issuer: `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}`,
    });

    const jwtPayload = payload as unknown as JWTPayload;

    return {
      id: jwtPayload.sub,
      email: jwtPayload.email || '',
      username: jwtPayload.preferred_username || '',
      roles: jwtPayload.realm_access?.roles || [],
      teamId: jwtPayload.teamId,
      tenantId: jwtPayload.tenantId,
    };
  } catch (error) {
    console.error('JWT verification failed:', error);
    return null;
  }
}

/**
 * ロールチェック
 */
export function hasRole(user: AuthenticatedUser, role: UserRole): boolean {
  return user.roles.includes(role);
}

export function hasAnyRole(user: AuthenticatedUser, roles: UserRole[]): boolean {
  return roles.some((role) => user.roles.includes(role));
}

/**
 * チームへのアクセス権チェック
 */
export function canAccessTeam(user: AuthenticatedUser, teamId: string): boolean {
  if (hasRole(user, UserRole.PLATFORM_ADMIN)) return true;
  if (hasRole(user, UserRole.TENANT_ADMIN)) return true;
  if (hasRole(user, UserRole.ORGANIZER)) return true;
  return user.teamId === teamId;
}

/**
 * Hono ミドルウェア用の型宣言
 */
declare module 'hono' {
  interface ContextVariableMap {
    user: AuthenticatedUser;
  }
}

/**
 * Express/Hono 互換の認証コンテキスト
 */
export interface AuthContext {
  user: AuthenticatedUser | null;
  token: string | null;
  isValid: boolean;
  error?: string;
}

/**
 * ヘッダーからトークンを抽出して認証
 */
export async function authenticateRequest(headers: {
  authorization?: string;
  authorizationtoken?: string;
  [key: string]: string | undefined;
}): Promise<AuthContext> {
  const authHeader = headers.authorization || headers.authorizationtoken;

  if (!authHeader) {
    return {
      user: null,
      token: null,
      isValid: false,
      error: 'No authorization token provided',
    };
  }

  const token = authHeader.replace(/^Bearer\s+/i, '');
  const user = await verifyToken(token);

  if (!user) {
    return {
      user: null,
      token,
      isValid: false,
      error: 'Invalid token',
    };
  }

  return {
    user,
    token,
    isValid: true,
  };
}
