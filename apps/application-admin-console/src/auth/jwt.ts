/**
 * Cognito id_token の payload を decode する (署名検証は別系統)。
 *
 * Cognito から issued された id_token は completeLogin で取得し memory (React state) に
 * 保持される信頼できる値 (web storage には永続化しない)。本 helper は payload の
 * JSON を取り出すだけで、改竄検知は行わない (本 app は token を外部から受け取る route が
 * なく、常に自身が発行経路 = Cognito から直接受けるため)。
 *
 * 戻り値: 欲しいフィールド (tenantId / email) だけ抽出した型。token 不正時は null。
 */
export interface IdTokenClaims {
  email?: string;
  tenantId?: string;
}

function base64UrlDecode(segment: string): string {
  // base64url → base64
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  // ブラウザ / vitest jsdom どちらでも atob は利用可能
  return atob(padded);
}

export function decodeIdToken(idToken: string): IdTokenClaims | null {
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const payloadJson = base64UrlDecode(parts[1]);
    // base64 decode した binary を UTF-8 として再解釈する。
    const payload = JSON.parse(decodeURIComponent(escape(payloadJson))) as Record<string, unknown>;
    const email = typeof payload.email === "string" ? payload.email : undefined;
    const tenantId =
      typeof payload["custom:tenantId"] === "string"
        ? (payload["custom:tenantId"] as string)
        : undefined;
    return { email, tenantId };
  } catch {
    return null;
  }
}
