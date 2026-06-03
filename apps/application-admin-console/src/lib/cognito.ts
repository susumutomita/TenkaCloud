/**
 * Build the Cognito Hosted UI origin from `config.cognitoDomain`.
 *
 * `cognitoDomain` arrives with a scheme in some environments (`https://xxx.auth.<region>.amazoncognito.com`)
 * and without one in others (`xxx.auth.<region>.amazoncognito.com`). Blindly prefixing `https://`
 * produced `https://https://xxx…` — `new URL()` then parsed the host as `https`, so the Test sign-in
 * link and the SAML ACS URL pointed at a dead host. This normalizes to exactly one scheme and no
 * trailing slash, so both call sites build a valid origin.
 */
export function cognitoOrigin(cognitoDomain: string): string {
  const trimmed = cognitoDomain.trim().replace(/\/+$/, "");
  if (trimmed.startsWith("https://") || trimmed.startsWith("http://")) return trimmed;
  return `https://${trimmed}`;
}

/**
 * Extract the User Pool ID from a Cognito ID token's `iss` claim
 * (`https://cognito-idp.<region>.amazonaws.com/<userPoolId>`). The User Pool ID is not in
 * runtime-config, but the signed-in admin's own ID token carries it, so we can show the real
 * SP Entity ID instead of a `<userPoolId>` placeholder the operator has to substitute by hand.
 */
export function userPoolIdFromIssuer(iss: string | undefined): string | undefined {
  if (!iss) return undefined;
  const match = iss.match(/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/([A-Za-z0-9_-]+)$/);
  return match?.[1];
}

/** The Cognito SAML SP Entity ID. Falls back to the placeholder only when the pool id is unknown. */
export function spEntityId(userPoolId: string | undefined): string {
  return userPoolId ? `urn:amazon:cognito:sp:${userPoolId}` : "urn:amazon:cognito:sp:<userPoolId>";
}
