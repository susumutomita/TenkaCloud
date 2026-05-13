/**
 * Issue #653 / #714: SBT default の SystemAdmin 招待メール本文 (`http://localhost` を埋める)
 * を override するためのテンプレ生成。 admin-console origin が解決できないときは
 * 運営連絡先を促す fallback 文面を返す (= Phase 1 deploy 時)、 解決済なら CloudFront
 * URL を本文に埋める (= Phase 3 再 deploy 後)。
 *
 * #714: 旧実装は ja + en を `—` で連結した 1 通だったが、 Gmail 等で改行が collapse されて
 * 「1 段落の長文」 になり可読性が低かった。 English-only に統一し、 各セクションを空行で
 * 分離する (= preview で改行が落ちても各 key:value が独立可読)。
 */

const FALLBACK_URL_PLACEHOLDER =
  "(Admin console URL will be provided after deploy. Please contact your operator.)";

export const INVITE_EMAIL_SUBJECT = "Your TenkaCloud Admin Console invitation";

/**
 * 招待メール本文を組み立てる。 English 単一ロケール、 各 key を 1 行ずつ。
 * Cognito placeholder の `{username}` / `{####}` はそのまま埋め、 Cognito 側で展開させる。
 */
export function buildInviteEmailBody(adminConsoleOrigin: string | undefined): string {
  const url =
    adminConsoleOrigin && adminConsoleOrigin.length > 0
      ? adminConsoleOrigin
      : FALLBACK_URL_PLACEHOLDER;
  return [
    "Welcome to TenkaCloud Admin Console.",
    "",
    `URL: ${url}`,
    "Username: {username}",
    "Temporary password: {####}",
    "",
    "You will be prompted to set a new password on first sign-in.",
  ].join("\n");
}
