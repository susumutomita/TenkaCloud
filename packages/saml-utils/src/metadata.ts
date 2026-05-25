/**
 * SAML metadata XML validation (Issues #1293 / #1294).
 *
 * Why this is here and not in the handler:
 *   - Same rule must run on both the Control Plane handler and the Application
 *     Plane handler, so we share it.
 *   - It also has to run in Node Lambda (no DOM). We deliberately do **not**
 *     pull a full XML parser library — supply chain surface, ~1MB cold start.
 *     Instead, we do **structural string checks** at the boundaries that
 *     matter for Cognito acceptance:
 *
 *       1. The blob is a real string and within Cognito's metadata size limit
 *          (32KB; we cap at 30KB for safety margin).
 *       2. The XML declaration / EntityDescriptor root tag is present.
 *       3. The `entityID` attribute is present and non-empty.
 *       4. A SAML `IDPSSODescriptor` is present (= it's an IdP descriptor,
 *          not an SP descriptor).
 *       5. Either an `X509Certificate` (= public key) **or** a Signature
 *          element is present. We do **not** verify the signature itself — that
 *          is Cognito's job downstream — but we reject blobs that have neither,
 *          since they cannot be used for SP-initiated or IdP-initiated SAML.
 *       6. A `NameIDFormat` is declared, since downstream we treat the
 *          `NameID` as the canonical `subjectId`.
 *
 *   - The actual XML signature / certificate validation is done by Cognito on
 *     `CreateIdentityProvider` / `UpdateIdentityProvider`. We are not trying
 *     to replicate that — only to fail-fast obviously bad inputs from the UI.
 */

import type { SamlAttributeMapping, SamlIdpConfig } from "./types.js";

export const SAML_METADATA_MAX_BYTES = 30 * 1024;

export type SamlMetadataValidationFailure =
  | "empty"
  | "too_large"
  | "not_xml"
  | "missing_entity_descriptor"
  | "missing_entity_id"
  | "missing_idp_sso_descriptor"
  | "missing_signing_material"
  | "missing_name_id_format";

export interface SamlMetadataValidationResult {
  readonly ok: boolean;
  readonly reason?: SamlMetadataValidationFailure;
  /** Extracted `entityID` (a.k.a. issuer) — only set when {@link ok}. */
  readonly entityId?: string;
}

/**
 * Validate a SAML metadata XML blob. Pure function, side-effect-free.
 */
export function validateSamlMetadata(xml: unknown): SamlMetadataValidationResult {
  if (typeof xml !== "string" || xml.trim().length === 0) {
    return { ok: false, reason: "empty" };
  }
  // Approx byte size (UTF-8). For the size guard we don't need exact bytes —
  // a slight overcount via TextEncoder is fine and avoids ambiguity.
  const byteLength = new TextEncoder().encode(xml).length;
  if (byteLength > SAML_METADATA_MAX_BYTES) {
    return { ok: false, reason: "too_large" };
  }
  const trimmed = xml.trim();
  if (!trimmed.startsWith("<")) {
    return { ok: false, reason: "not_xml" };
  }
  if (!/<(?:[A-Za-z0-9_-]+:)?EntityDescriptor\b/.test(trimmed)) {
    return { ok: false, reason: "missing_entity_descriptor" };
  }
  const entityIdMatch = trimmed.match(/\bentityID\s*=\s*"([^"]+)"/);
  if (!entityIdMatch || entityIdMatch[1].trim().length === 0) {
    return { ok: false, reason: "missing_entity_id" };
  }
  if (!/<(?:[A-Za-z0-9_-]+:)?IDPSSODescriptor\b/.test(trimmed)) {
    return { ok: false, reason: "missing_idp_sso_descriptor" };
  }
  // Either a key (X509Certificate) or a Signature element is required.
  const hasCert = /<(?:[A-Za-z0-9_-]+:)?X509Certificate\b/.test(trimmed);
  const hasSignature = /<(?:[A-Za-z0-9_-]+:)?Signature\b/.test(trimmed);
  if (!hasCert && !hasSignature) {
    return { ok: false, reason: "missing_signing_material" };
  }
  if (!/<(?:[A-Za-z0-9_-]+:)?NameIDFormat\b/.test(trimmed)) {
    return { ok: false, reason: "missing_name_id_format" };
  }
  return { ok: true, entityId: entityIdMatch[1] };
}

/**
 * Default SAML attribute → Cognito user pool attribute mapping. Picked to work
 * with Okta / Azure AD / Google Workspace out of the box; admins may override
 * per IdP in {@link SamlIdpConfig.attributeMapping}.
 */
export const DEFAULT_ATTRIBUTE_MAPPING: SamlAttributeMapping = {
  email: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
  displayName: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
  groups: "http://schemas.xmlsoap.org/claims/Group",
};

/**
 * Cap on the number of SAML IdPs per UserPool. Cognito's own limit is 50, but
 * we cap at 25 to keep the Hosted UI picker usable (= scrolling a 50-row list
 * is hostile to first-time SSO users).
 */
export const SAML_IDP_LIMIT_PER_USERPOOL = 25;

/**
 * Shape the wire payload we send to Cognito `CreateIdentityProvider`.
 *
 * The platform never deletes / mutates the underlying Cognito attribute. We
 * always invoke the SDK with explicit `ProviderDetails` so partial updates
 * cannot leave the IdP in a half-configured state.
 */
export function toCognitoProviderDetails(
  config: Pick<SamlIdpConfig, "metadataXml">,
): Readonly<Record<string, string>> {
  return Object.freeze({
    MetadataFile: config.metadataXml,
    // IdP-initiated SAML: Cognito honors `RelayState` only when the IdP signs
    // an AuthnResponse and posts to the Cognito ACS URL with `RelayState=`
    // pointing back at our SP callback. We pin this here so admins do not
    // have to remember it. Verified manually against Okta IdP-initiated tile
    // (POC notes: see PR body — "Cognito IdP-initiated SAML RelayState").
    IDPSignout: "false",
  });
}
