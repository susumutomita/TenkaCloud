/**
 * 認証・認可システム
 *
 * Cognito JWT と Keycloak JWT の両方をサポート。
 * JWKS_URI / JWT_ISSUER 環境変数で設定可能。
 * 未設定の場合は Keycloak パターンにフォールバック。
 *
 * AUTH_SKIP モードでは JWT 検証をバイパスし、
 * モックユーザーを返す（ローカル開発用）。
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';
import { parseAuthSkipRoles } from './auth-skip-roles';

/* v8 ignore start -- Production safety guard */
if (process.env.AUTH_SKIP === '1' && process.env.NODE_ENV === 'production') {
  throw new Error('AUTH_SKIP cannot be enabled in production');
}
/* v8 ignore stop */

const isNonProduction = process.env.NODE_ENV !== 'production';
const authSkipEnabled =
  process.env.AUTH_SKIP === '1' &&
  isNonProduction;
// mock-access-token is only accepted when AUTH_SKIP=1 is explicitly set
const localDevTokenEnabled = authSkipEnabled;
const LOCAL_DEV_TOKEN = 'mock-access-token';

/* v8 ignore start -- Development-only warning */
if (authSkipEnabled && typeof console !== 'undefined') {
  console.warn(
    '\x1b[33m⚠️  AUTH_SKIP mode is enabled in problem-service. JWT verification is bypassed.\x1b[0m'
  );
  console.warn(
    '\x1b[33m   This should only be used for local development.\x1b[0m'
  );
}
/* v8 ignore stop */

const KEYCLOAK_REALM = process.env.KEYCLOAK_REALM || 'tenkacloud';
const KEYCLOAK_URL = process.env.KEYCLOAK_URL || 'http://localhost:8080';
const KEYCLOAK_JWKS_URL = `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/certs`;
const KEYCLOAK_ISSUER = `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}`;

const JWKS_URL = process.env.JWKS_URI || KEYCLOAK_JWKS_URL;
const JWT_ISSUER = process.env.JWT_ISSUER || KEYCLOAK_ISSUER;

let jwksCache: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJWKS() {
  if (!jwksCache) {
    jwksCache = createRemoteJWKSet(new URL(JWKS_URL));
  }
  return jwksCache;
}

export enum UserRole {
  PLATFORM_ADMIN = 'platform-admin',
  TENANT_ADMIN = 'tenant-admin',
  ORGANIZER = 'organizer',
  COMPETITOR = 'competitor',
  SPECTATOR = 'spectator',
}

export interface JWTPayload {
  sub: string;
  email?: string;
  preferred_username?: string;
  // Keycloak claims
  realm_access?: {
    roles: string[];
  };
  resource_access?: {
    [key: string]: {
      roles: string[];
    };
  };
  // Cognito claims
  'custom:tenant_id'?: string;
  'cognito:groups'?: string[];
  // TenkaCloud 拡張 (Keycloak)
  teamId?: string;
  tenantId?: string;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  username: string;
  roles: string[];
  teamId?: string;
  tenantId?: string;
}

const DEV_USER_ID_HEADER = "x-tenkacloud-dev-user-id";
const DEV_TENANT_ID_HEADER = "x-tenkacloud-dev-tenant-id";
const DEV_ROLES_HEADER = "x-tenkacloud-dev-roles";

function sanitizeDevIdentity(
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
		.replace(/[^A-Za-z0-9@._:/+=,-]/g, "-")
		.slice(0, maxLength);

	return sanitized || fallback;
}

/**
 * JWT トークンを検証してユーザー情報を取得
 *
 * Cognito と Keycloak 両方のクレーム形式をサポート。
 * - tenant_id: `custom:tenant_id` (Cognito) -> `tenantId` (Keycloak)
 * - roles: `cognito:groups` (Cognito) -> `realm_access.roles` (Keycloak)
 */
export async function verifyToken(
  token: string
): Promise<AuthenticatedUser | null> {
  try {
    const { payload } = await jwtVerify(token, getJWKS(), {
      issuer: JWT_ISSUER,
    });

    const jwtPayload = payload as unknown as JWTPayload;

    const tenantId =
      jwtPayload['custom:tenant_id'] ?? jwtPayload.tenantId;
    const roles =
      jwtPayload['cognito:groups'] ?? jwtPayload.realm_access?.roles ?? [];

    return {
      id: jwtPayload.sub,
      email: jwtPayload.email || '',
      username: jwtPayload.preferred_username || '',
      roles,
      teamId: jwtPayload.teamId,
      tenantId,
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

export function hasAnyRole(
  user: AuthenticatedUser,
  roles: UserRole[]
): boolean {
  return roles.some((role) => user.roles.includes(role));
}

/**
 * チームへのアクセス権チェック
 */
export function canAccessTeam(
  user: AuthenticatedUser,
  teamId: string
): boolean {
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

/** AUTH_SKIP モードで使用するモックユーザーを生成（リクエスト間の状態共有を防止） */
function createMockUser(
	headers?: {
		[DEV_USER_ID_HEADER]?: string;
		[DEV_TENANT_ID_HEADER]?: string;
		[DEV_ROLES_HEADER]?: string;
	},
): AuthenticatedUser {
	const userId = sanitizeDevIdentity(headers?.[DEV_USER_ID_HEADER], "dev-user");
	const tenantId = sanitizeDevIdentity(
		headers?.[DEV_TENANT_ID_HEADER],
		"dev-tenant",
	);
	const email = userId.includes("@") ? userId : `${userId}@localhost`;

	return {
		id: userId,
		email,
		username: userId,
		roles: parseAuthSkipRoles(
			headers?.[DEV_ROLES_HEADER] ?? process.env.AUTH_SKIP_ROLES,
		),
		tenantId,
	};
}

/**
 * ヘッダーからトークンを抽出して認証
 *
 * AUTH_SKIP モード: モックユーザーを即座に返す（JWT 検証なし）
 * 通常モード: JWKS_URI (Cognito/Keycloak) でトークンを検証
 */
export async function authenticateRequest(headers: {
  authorization?: string;
  authorizationtoken?: string;
  [DEV_USER_ID_HEADER]?: string;
  [DEV_TENANT_ID_HEADER]?: string;
  [DEV_ROLES_HEADER]?: string;
  [key: string]: string | undefined;
}): Promise<AuthContext> {
  if (authSkipEnabled) {
    return {
      user: createMockUser(headers),
      token: LOCAL_DEV_TOKEN,
      isValid: true,
    };
  }

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

  if (localDevTokenEnabled && token === LOCAL_DEV_TOKEN) {
    return {
      user: createMockUser(headers),
      token,
      isValid: true,
    };
  }

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
