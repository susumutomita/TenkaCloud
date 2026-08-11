/**
 * Issue #1418 web-kit Stage 3: admin-console の Cognito AuthProvider。
 *
 * memory-only token + 15min idle-logout (#859) + server-side revoke (#833) の実装は
 * application-admin-console と byte 一致だったため `@tenkacloud/web-kit` に集約済み。 ここは
 * 公開 API (AuthProvider / useAuth) を移行前と互換に保つ再 export shim。 `<AuthProvider config>` に
 * 渡す AppConfig は web-kit が要求する CognitoOAuthConfig の superset なので prop はそのまま通る。
 */

export { AuthProvider, useAuth } from "@tenkacloud/web-kit";
