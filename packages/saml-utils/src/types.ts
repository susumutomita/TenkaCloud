/**
 * Shared SAML SSO types for Control Plane and Application Plane (Issues #1293 / #1294).
 *
 * Design notes:
 *   - Same email × multiple IdPs is a first-class requirement. We never key on email.
 *     The canonical user identifier is `(idpId, subjectId)` for Control Plane and
 *     `(tenantId, idpId, subjectId)` for Application Plane. `subjectId` is the SAML
 *     `NameID` reflected back through Cognito as the federated `sub` claim.
 *   - `SamlIdpConfig` is the wire shape returned by the IdP CRUD API. The XML metadata
 *     blob is opaque to the platform — we validate it in {@link ./metadata.js} and hand
 *     it to Cognito `CreateIdentityProvider` / `UpdateIdentityProvider` as-is.
 *   - `attributeMapping` maps SAML attribute URIs to Cognito user pool attributes.
 *     The platform layer provides defaults; admins can override per IdP.
 *   - `groupToRole` maps SAML group attribute values to the platform role enum
 *     (SystemAdmin / TenantAdmin / Operator / Viewer). JIT-elevation only happens
 *     when the group is on this map (no implicit defaults — fail closed).
 */

export type PlatformRole = "SystemAdmin" | "TenantAdmin" | "Operator" | "Viewer";

/**
 * A single SAML IdP attached to a Cognito UserPool. The wire shape returned by
 * the IdP CRUD API and stored in DynamoDB.
 */
export interface SamlIdpConfig {
  /**
   * Stable ID assigned by the platform. For Cognito this is also the
   * `ProviderName` (= `idpId` in our URLs / DDB rows).
   */
  readonly idpId: string;
  /** Display label shown on the Hosted UI picker. */
  readonly displayName: string;
  /** Optional one-line description shown under the display name. */
  readonly description?: string;
  /**
   * Raw SAML metadata XML, as supplied by the IdP. We validate it with
   * {@link ./metadata.js#validateSamlMetadata} before storing.
   */
  readonly metadataXml: string;
  /** Cognito UserPool attribute mapping (key = SAML attribute URI). */
  readonly attributeMapping: SamlAttributeMapping;
  /** Group → platform role map. Unmapped groups grant nothing. */
  readonly groupToRole: Readonly<Record<string, PlatformRole>>;
  /**
   * Application Plane only — the tenant this IdP belongs to. Control Plane
   * IdPs leave this undefined.
   */
  readonly tenantId?: string;
  /** ISO timestamp; set by the handler on create / update. */
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Cognito `AttributeMapping` shape — SAML attribute URI → Cognito user pool
 * attribute name. We require at minimum `email` so accounts can be addressed
 * for support, and the canonical `subjectId` (= SAML `NameID`, which Cognito
 * exposes back as the federated `sub` claim — never bypass this).
 *
 * `roles` and `groups` are optional but populated when the IdP emits them
 * (Okta / Azure AD / Google Workspace all do).
 */
export interface SamlAttributeMapping {
  readonly email: string;
  /**
   * SAML attribute URI carrying the user's display name (Okta default:
   * `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name`). Mapped to
   * Cognito `name`.
   */
  readonly displayName?: string;
  /**
   * SAML attribute URI carrying the comma-separated or multi-value list of
   * groups this user is a member of. Mapped to Cognito `custom:samlGroups`
   * (string, comma-separated).
   */
  readonly groups?: string;
}

/**
 * Canonical user identity claim, derived from a verified SAML response and
 * Cognito federated session. This is the shape persisted on the Users table.
 *
 * - Control Plane PK: `${idpId}#${subjectId}`
 * - Application Plane PK: `${tenantId}#${idpId}#${subjectId}`
 */
export interface SamlIdentityClaim {
  readonly idpId: string;
  /** Cognito federated `sub` (= SAML `NameID`). Never collides across IdPs. */
  readonly subjectId: string;
  /** Application Plane only — bind to the tenant. Undefined on Control Plane. */
  readonly tenantId?: string;
  /**
   * The email reflected at sign-in time. We snapshot this on the Users row
   * so support can look up "what email did this user use at last login"
   * without re-reading the IdP. Never used as a primary key.
   */
  readonly emailSnapshot: string;
  readonly displayName?: string;
  /** Effective roles after group → role mapping. May be empty (= no access). */
  readonly roles: readonly PlatformRole[];
}
