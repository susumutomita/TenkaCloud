/**
 * Shared IdP CRUD core for Control Plane (#1293) and Application Plane (#1294).
 *
 * Plane separation is enforced by:
 *   - The Control Plane handler hard-codes `tenantId: undefined` (scope = system).
 *   - The Application Plane handler injects the caller's `tenantId` from the JWT
 *     and rejects any cross-tenant access at the route guard layer.
 *
 * This file is pure (no Cognito / DDB imports). It works against the
 * {@link IdpStore} and {@link CognitoIdpAdapter} ports so unit tests can fake them.
 */

import {
  CreateIdpInputSchema,
  SAML_IDP_LIMIT_PER_USERPOOL,
  type SamlIdpConfig,
  type UpdateIdpInput,
  UpdateIdpInputSchema,
  validateSamlMetadata,
} from "@tenkacloud/saml-utils";
import type { IdpScope } from "../../../problem-deploy/control-data/domain/saml-idps.js";

// [Issue #2527 Slice 1 step 2] The scope discriminator is owned by the SamlIdps
// domain module (the repository seam it scopes); re-exported here so the
// idp-handler / tenant-template consumers keep their import path.
export type { IdpScope } from "../../../problem-deploy/control-data/domain/saml-idps.js";

/**
 * DDB-shaped persistence port. The Control Plane uses a single-PK table
 * (`idpId#`); the Application Plane uses `${tenantId}#${idpId}`. The adapter
 * builds the PK from the scope.
 */
export interface IdpStore {
  list(scope: IdpScope): Promise<readonly SamlIdpConfig[]>;
  get(scope: IdpScope, idpId: string): Promise<SamlIdpConfig | null>;
  put(scope: IdpScope, config: SamlIdpConfig): Promise<void>;
  delete(scope: IdpScope, idpId: string): Promise<void>;
}

/**
 * Cognito SDK port (`cognito-idp:CreateIdentityProvider`, etc). One adapter
 * per UserPool — the Application Plane handler resolves the tenant's pool
 * from the `tenantId` claim.
 */
export interface CognitoIdpAdapter {
  createIdp(config: SamlIdpConfig): Promise<void>;
  updateIdp(config: SamlIdpConfig): Promise<void>;
  deleteIdp(idpId: string): Promise<void>;
}

export type IdpHandlerError =
  | { readonly kind: "validation"; readonly message: string }
  | { readonly kind: "invalid_metadata"; readonly reason: string }
  | { readonly kind: "not_found" }
  | { readonly kind: "conflict"; readonly message: string }
  | { readonly kind: "internal"; readonly message: string };

export interface IdpHandlerDeps {
  readonly store: IdpStore;
  readonly cognito: CognitoIdpAdapter;
  readonly now: () => Date;
}

function nowIso(deps: IdpHandlerDeps): string {
  return deps.now().toISOString();
}

export async function listIdps(
  deps: IdpHandlerDeps,
  scope: IdpScope,
): Promise<readonly SamlIdpConfig[]> {
  return deps.store.list(scope);
}

export async function getIdp(
  deps: IdpHandlerDeps,
  scope: IdpScope,
  idpId: string,
): Promise<SamlIdpConfig | { readonly error: IdpHandlerError }> {
  const found = await deps.store.get(scope, idpId);
  if (!found) return { error: { kind: "not_found" } };
  return found;
}

export async function createIdp(
  deps: IdpHandlerDeps,
  scope: IdpScope,
  rawBody: unknown,
): Promise<SamlIdpConfig | { readonly error: IdpHandlerError }> {
  const parsed = CreateIdpInputSchema.safeParse(rawBody);
  if (!parsed.success) {
    return { error: { kind: "validation", message: parsed.error.message } };
  }
  const validated = validateSamlMetadata(parsed.data.metadataXml);
  if (!validated.ok) {
    return { error: { kind: "invalid_metadata", reason: validated.reason ?? "unknown" } };
  }
  // idpId は Cognito ProviderName になるため lowercase 正規化する (#1392): 大小文字違いの重複
  // provider (`Foo` と `foo`) を防ぎ、 federated username の小文字化 (saml-admin-allowlist) と整合させる。
  const idpId = parsed.data.idpId.toLowerCase();
  const existing = await deps.store.get(scope, idpId);
  if (existing) {
    return { error: { kind: "conflict", message: `idp ${idpId} already exists` } };
  }
  // documented per-UserPool 上限 (= Cognito 制約 / list query が 25 件 bound 前提) を write 時に強制 (#1392)。
  const current = await deps.store.list(scope);
  if (current.length >= SAML_IDP_LIMIT_PER_USERPOOL) {
    return {
      error: {
        kind: "conflict",
        message: `idp limit reached (max ${SAML_IDP_LIMIT_PER_USERPOOL} per user pool)`,
      },
    };
  }
  const ts = nowIso(deps);
  const config: SamlIdpConfig = {
    idpId,
    displayName: parsed.data.displayName,
    ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
    metadataXml: parsed.data.metadataXml,
    attributeMapping: parsed.data.attributeMapping,
    groupToRole: parsed.data.groupToRole,
    ...(scope.kind === "tenant" ? { tenantId: scope.tenantId } : {}),
    createdAt: ts,
    updatedAt: ts,
  };
  // Order matters: write Cognito first so a DDB-only ghost row cannot exist.
  // If Cognito fails, the user retries; the DDB row is never created.
  try {
    await deps.cognito.createIdp(config);
  } catch (err) {
    const message = err instanceof Error ? err.message : "cognito error";
    return { error: { kind: "internal", message } };
  }
  await deps.store.put(scope, config);
  return config;
}

export async function updateIdp(
  deps: IdpHandlerDeps,
  scope: IdpScope,
  idpId: string,
  rawBody: unknown,
): Promise<SamlIdpConfig | { readonly error: IdpHandlerError }> {
  const parsed = UpdateIdpInputSchema.safeParse(rawBody);
  if (!parsed.success) {
    return { error: { kind: "validation", message: parsed.error.message } };
  }
  const current = await deps.store.get(scope, idpId);
  if (!current) return { error: { kind: "not_found" } };
  if (parsed.data.metadataXml !== undefined) {
    const validated = validateSamlMetadata(parsed.data.metadataXml);
    if (!validated.ok) {
      return { error: { kind: "invalid_metadata", reason: validated.reason ?? "unknown" } };
    }
  }
  const merged = mergeUpdate(current, parsed.data, nowIso(deps));
  try {
    await deps.cognito.updateIdp(merged);
  } catch (err) {
    const message = err instanceof Error ? err.message : "cognito error";
    return { error: { kind: "internal", message } };
  }
  await deps.store.put(scope, merged);
  return merged;
}

export async function deleteIdp(
  deps: IdpHandlerDeps,
  scope: IdpScope,
  idpId: string,
): Promise<true | { readonly error: IdpHandlerError }> {
  const current = await deps.store.get(scope, idpId);
  if (!current) return { error: { kind: "not_found" } };
  try {
    await deps.cognito.deleteIdp(idpId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "cognito error";
    return { error: { kind: "internal", message } };
  }
  await deps.store.delete(scope, idpId);
  return true;
}

function mergeUpdate(
  current: SamlIdpConfig,
  patch: UpdateIdpInput,
  updatedAt: string,
): SamlIdpConfig {
  return {
    ...current,
    ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.metadataXml !== undefined ? { metadataXml: patch.metadataXml } : {}),
    ...(patch.attributeMapping !== undefined ? { attributeMapping: patch.attributeMapping } : {}),
    ...(patch.groupToRole !== undefined ? { groupToRole: patch.groupToRole } : {}),
    updatedAt,
  };
}

/**
 * Structured audit log emitter. Relates #1292: the eventual `AuditEvents` row
 * write hangs off this same code path. Until #1292 lands, we emit a structured
 * `console.info` so CloudWatch Logs Insights can grep on it; the audit-emitter
 * subscriber path is a TODO marked here.
 */
export interface AuditEventInput {
  readonly action: "idp.create" | "idp.update" | "idp.delete" | "idp.read";
  readonly scope: IdpScope;
  readonly actorSub: string;
  readonly idpId?: string;
  readonly outcome: "success" | "forbidden" | "not_found" | "conflict" | "error";
  readonly errorMessage?: string;
}

export function emitAudit(input: AuditEventInput): void {
  // Stable structured log shape so the future AuditEvents subscriber (#1292)
  // can ingest these without a code change to the emitter.
  // TODO(#1292): when AuditEmitter lands, replace this with a typed call.
  console.info({
    event: "audit.idp",
    action: input.action,
    scopeKind: input.scope.kind,
    tenantId: input.scope.kind === "tenant" ? input.scope.tenantId : undefined,
    actor: input.actorSub,
    idpId: input.idpId,
    outcome: input.outcome,
    errorMessage: input.errorMessage,
  });
}
