/**
 * SAML attribute → platform identity claim mapping (Issues #1293 / #1294).
 *
 * Called once per SAML sign-in inside the handler-layer post-confirmation /
 * pre-token-generation Lambda. Pure function so we can unit-test it without
 * mocking Cognito.
 *
 * The shape of the input matches what Cognito hands us after running its own
 * attribute mapping (= a flat `Record<string, string>` keyed by user pool
 * attribute names like `email`, `name`, `custom:samlGroups`, plus the
 * federated `sub` and the resolved `idpId`).
 */

import type { PlatformRole, SamlIdentityClaim, SamlIdpConfig } from "./types.js";

export interface AttributeMapperInput {
  /** `idpId` resolved by Cognito (= our `ProviderName`). */
  readonly idpId: string;
  /**
   * Federated `sub` claim — equals SAML `NameID`. We never look at `email`
   * for keying.
   */
  readonly subjectId: string;
  /** Email reflected by the IdP, snapshot only. May be absent. */
  readonly email?: string;
  readonly displayName?: string;
  /** Comma-separated or multi-value list of group strings. */
  readonly groups?: readonly string[] | string;
  /** Application Plane: tenant the user is signing in to. */
  readonly tenantId?: string;
}

/**
 * Resolve the platform-effective roles for this user given the IdP's
 * `groupToRole` mapping. Unknown groups grant nothing (fail closed).
 */
export function resolveRoles(
  idp: Pick<SamlIdpConfig, "groupToRole">,
  rawGroups: readonly string[] | string | undefined,
): readonly PlatformRole[] {
  const groups = normalizeGroups(rawGroups);
  const seen = new Set<PlatformRole>();
  for (const group of groups) {
    const role = idp.groupToRole[group];
    if (role) seen.add(role);
  }
  return [...seen];
}

/**
 * Build the canonical {@link SamlIdentityClaim} for a federated sign-in.
 * The PK to use on the Users DDB table is derived from `idpId` + `subjectId`
 * (Control Plane) or `tenantId` + `idpId` + `subjectId` (Application Plane).
 */
export function buildIdentityClaim(
  idp: Pick<SamlIdpConfig, "groupToRole">,
  input: AttributeMapperInput,
): SamlIdentityClaim {
  if (input.subjectId.length === 0) {
    throw new Error("subjectId is required (= SAML NameID / Cognito federated sub)");
  }
  if (input.idpId.length === 0) {
    throw new Error("idpId is required");
  }
  return {
    idpId: input.idpId,
    subjectId: input.subjectId,
    ...(input.tenantId ? { tenantId: input.tenantId } : {}),
    emailSnapshot: input.email ?? "",
    ...(input.displayName ? { displayName: input.displayName } : {}),
    roles: resolveRoles(idp, input.groups),
  };
}

/**
 * Build the Users DDB partition key. Separator is `#`. The function is
 * deliberately split into Control Plane vs Application Plane so callers can
 * not accidentally cross planes.
 */
export function buildControlPlaneUserPk(idpId: string, subjectId: string): string {
  return `${idpId}#${subjectId}`;
}

export function buildApplicationPlaneUserPk(
  tenantId: string,
  idpId: string,
  subjectId: string,
): string {
  return `${tenantId}#${idpId}#${subjectId}`;
}

function normalizeGroups(value: readonly string[] | string | undefined): readonly string[] {
  if (value === undefined) return [];
  if (typeof value === "string") {
    return value
      .split(",")
      .map((g) => g.trim())
      .filter((g) => g.length > 0);
  }
  // value is a (readonly) string[] here — the only remaining type, so this is the
  // total final branch (no unreachable fallthrough).
  return value.filter((g): g is string => typeof g === "string");
}
