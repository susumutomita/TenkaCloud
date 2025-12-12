import { createMiddleware } from 'hono/factory';
import * as jose from 'jose';

export interface AuthContext {
  userId: string;
  tenantId: string;
  roles: string[];
}

declare module 'hono' {
  interface ContextVariableMap {
    auth: AuthContext;
  }
}

const JWKS_URI =
  process.env.JWKS_URI ??
  'http://localhost:8080/realms/tenkacloud/protocol/openid-connect/certs';
const ISSUER =
  process.env.JWT_ISSUER ?? 'http://localhost:8080/realms/tenkacloud';

let jwks: jose.JWTVerifyGetKey | null = null;

async function getJWKS() {
  if (!jwks) {
    jwks = jose.createRemoteJWKSet(new URL(JWKS_URI));
  }
  return jwks;
}

export const authMiddleware = createMiddleware(async (c, next) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: '認証が必要です' }, 401);
  }

  const token = authHeader.slice(7);

  try {
    const jwksSet = await getJWKS();
    const { payload } = await jose.jwtVerify(token, jwksSet, {
      issuer: ISSUER,
    });

    const tenantId = (payload as Record<string, unknown>)['tenant_id'] as
      | string
      | undefined;
    if (!tenantId) {
      return c.json({ error: 'テナント情報がありません' }, 403);
    }

    c.set('auth', {
      userId: payload.sub ?? '',
      tenantId,
      roles:
        (
          (payload as Record<string, unknown>)['realm_access'] as {
            roles?: string[];
          }
        )?.roles ?? [],
    });

    await next();
  } catch (error) {
    if (error instanceof jose.errors.JWTExpired) {
      return c.json({ error: 'トークンの有効期限が切れています' }, 401);
    }
    if (error instanceof jose.errors.JWTClaimValidationFailed) {
      return c.json({ error: 'トークンの検証に失敗しました' }, 401);
    }
    return c.json({ error: '認証に失敗しました' }, 401);
  }
});
