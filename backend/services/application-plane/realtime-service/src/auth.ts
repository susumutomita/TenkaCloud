import * as jose from 'jose';

export interface AuthPayload {
  userId: string;
  tenantId: string;
  roles: string[];
}

const JWKS_URI =
  process.env.JWKS_URI ??
  'http://localhost:8080/realms/tenkacloud/protocol/openid-connect/certs';
const ISSUER =
  process.env.JWT_ISSUER ?? 'http://localhost:8080/realms/tenkacloud';

let jwks: jose.JWTVerifyGetKey | null = null;

function getJWKS() {
  if (!jwks) {
    jwks = jose.createRemoteJWKSet(new URL(JWKS_URI));
  }
  return jwks;
}

/** WebSocket 接続時のトークン検証 */
export async function verifyToken(token: string): Promise<AuthPayload> {
  const jwksSet = getJWKS();
  const { payload } = await jose.jwtVerify(token, jwksSet, {
    issuer: ISSUER,
  });

  const tenantId = (payload as Record<string, unknown>)['tenant_id'] as
    | string
    | undefined;
  if (!tenantId) {
    throw new Error('テナント情報がありません');
  }

  return {
    userId: payload.sub ?? '',
    tenantId,
    roles:
      (
        (payload as Record<string, unknown>)['realm_access'] as {
          roles?: string[];
        }
      )?.roles ?? [],
  };
}

/** テスト用: JWKS キャッシュをリセット */
export function resetJWKSCache() {
  jwks = null;
}
