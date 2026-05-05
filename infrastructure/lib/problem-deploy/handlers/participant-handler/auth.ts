/**
 * `Authorization: Bearer <teamLoginKey>` から teamLoginKey を抽出する。
 * 形式不正は `undefined` を返し、route 側で 401。
 *
 * teamLoginKey は `crypto.randomBytes(18).toString("base64url")` で生成される
 * 24 文字 base64url。ここで形式チェックを行うのは、不正値で DDB Query する前に
 * 早期に弾くため (DDB の存在確認時間が攻撃者に漏れる timing oracle を防ぐ)。
 */
const TEAM_LOGIN_KEY_RE = /^[A-Za-z0-9_-]{24}$/;

export function extractBearerToken(authorizationHeader: string | undefined): string | undefined {
  if (!authorizationHeader) return undefined;
  const trimmed = authorizationHeader.trim();
  const match = /^Bearer\s+(.+)$/i.exec(trimmed);
  if (!match) return undefined;
  const token = match[1].trim();
  if (!TEAM_LOGIN_KEY_RE.test(token)) return undefined;
  return token;
}
