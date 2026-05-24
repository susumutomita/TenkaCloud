/**
 * Issue #871 / #1246: runtime-config.json URL validators shared by every admin SPA.
 *
 * runtime-config.json は S3 + CloudFront 経由で配信されるため tampering surface は
 * 限定的だが、 万一 bucket compromise / MITM で URL が attacker URL に書き換えられた
 * 場合に frontend が JWT を漏らさないよう、 protocol / host を validate する。
 *
 *   - `isHttpsUrl(value)`: `https://` であることを確認 (= mixed content / MITM 防御)
 *   - `isCognitoDomain(value)`: `https://` かつ host が `.amazoncognito.com` 終端 (= Cognito Hosted UI ドメインの allowlist)
 *
 * 検証失敗時は false を返し、 caller を env-based dev fallback に倒す
 * (= production deploy では env が空なので throw に倒れ、 早期に検知できる)。
 */

export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function isCognitoDomain(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.host.endsWith(".amazoncognito.com");
  } catch {
    return false;
  }
}
