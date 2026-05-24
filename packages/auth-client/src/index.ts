/**
 * @tenkacloud/auth-client
 *
 * Shared Cognito Hosted UI OAuth 2.0 Code + PKCE client for TenkaCloud admin SPAs
 * (admin-console / application-admin-console). See Issue #1246.
 *
 * Public surface:
 *   - PKCE helpers: `generateVerifier`, `deriveChallenge` (browser `crypto.subtle`)
 *   - OAuth flow: `beginLogin`, `completeLogin`, `loadStoredTokens`, `clearTokens`, `beginLogout`
 *   - Token storage shape: `TokenSet`
 *   - Config contract: `CognitoOAuthConfig` (subset of each SPA's `AppConfig`)
 *   - runtime-config.json URL validators: `isHttpsUrl`, `isCognitoDomain` (Issue #871 reuse)
 *
 * Browser-only (relies on `sessionStorage`, `window.location`, `crypto.subtle`).
 */

export {
  beginLogin,
  beginLogout,
  type CognitoOAuthConfig,
  clearTokens,
  completeLogin,
  loadStoredTokens,
  type TokenSet,
} from "./cognito";
export { deriveChallenge, generateVerifier } from "./pkce";
export { isCognitoDomain, isHttpsUrl } from "./runtime-config";
