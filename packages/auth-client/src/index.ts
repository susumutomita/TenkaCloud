/**
 * @tenkacloud/auth-client
 *
 * Shared Cognito Hosted UI OAuth 2.0 Code + PKCE client for TenkaCloud admin SPAs
 * (admin-console / application-admin-console). See Issue #1246.
 *
 * Public surface:
 *   - PKCE helpers: `generateVerifier`, `deriveChallenge` (browser `crypto.subtle`)
 *   - OAuth flow: `beginLogin`, `completeLogin`, `clearStoredAuthState`, `beginLogout`
 *   - Storage hygiene: `purgeLegacyTokenStorage` evicts pre-upgrade persisted tokens
 *   - Token shape: `TokenSet` is held in memory by the caller and never persisted
 *   - Config contract: `CognitoOAuthConfig` (subset of each SPA's `AppConfig`)
 *   - runtime-config.json URL validators: `isHttpsUrl`, `isCognitoDomain` (Issue #871 reuse)
 *
 * Browser-only (relies on `sessionStorage` for PKCE transients, `window.location`,
 * `crypto.subtle`). Bearer tokens are returned to the caller, not stored here.
 */

export {
  type BeginLoginOptions,
  beginLogin,
  beginLogout,
  type CognitoOAuthConfig,
  clearStoredAuthState,
  completeLogin,
  purgeLegacyTokenStorage,
  type TokenSet,
} from "./cognito";
export { deriveChallenge, generateVerifier } from "./pkce";
export { isCognitoDomain, isHttpsUrl } from "./runtime-config";
