/**
 * Issue #653: SBT default の SystemAdmin 招待メール本文 (`http://localhost` を埋める)
 * を override するためのテンプレ生成。 admin-console origin が解決できないときは
 * 運営連絡先を促す fallback 文面を返す (= Phase 1 deploy 時)、 解決済なら CloudFront
 * URL を本文に埋める (= Phase 3 再 deploy 後)。
 */

const FALLBACK_URL_PLACEHOLDER = "(deploy 完了後の admin-console URL は運営にお問い合わせください)";

export const INVITE_EMAIL_SUBJECT =
  "TenkaCloud Admin Console 招待 / Your TenkaCloud Admin Console invitation";

/**
 * 招待メール本文を組み立てる。 ja + en 並列で 1 通に並べる (PR-582 同様の方針)。
 * Cognito placeholder の `{username}` / `{####}` はそのまま埋め、 Cognito 側で展開させる。
 */
export function buildInviteEmailBody(adminConsoleOrigin: string | undefined): string {
  const url =
    adminConsoleOrigin && adminConsoleOrigin.length > 0
      ? adminConsoleOrigin
      : FALLBACK_URL_PLACEHOLDER;
  return [
    "TenkaCloud Admin Console へようこそ。",
    "",
    `URL: ${url}`,
    "ユーザー名: {username}",
    "仮パスワード: {####}",
    "",
    "初回ログイン時に新しいパスワードの設定を求められます。",
    "",
    "—",
    "Welcome to TenkaCloud Admin Console.",
    "",
    `URL: ${url}`,
    "Username: {username}",
    "Temporary password: {####}",
    "",
    "You will be prompted to set a new password on first sign-in.",
  ].join("\n");
}
