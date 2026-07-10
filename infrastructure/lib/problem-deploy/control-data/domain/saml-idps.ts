/**
 * [Issue #2527 Slice 1] SamlIdps aggregate — domain record and repository port (Lite-only IdP registry).
 *
 * Extracted verbatim from the former all-aggregate `control-data/types.ts` so each
 * aggregate's domain contract lives in its own module. `../types.ts` re-exports this
 * module as a temporary compatibility barrel while consumers migrate to direct imports.
 */

import type { SamlIdpConfig } from "@tenkacloud/saml-utils";
import type { IdpScope } from "../../../control-plane/handlers/idp-handler/core.js";

// ---------------------------------------------------------------------------
// [Issue #2442 / Phase C5] SamlIdps aggregate (Issue #1312).
//
// Physical shape (unchanged, `saml-idps-table.ts`):
//   pk = `SYSTEM` (Control Plane scope; the construct is never instantiated for
//        Control Plane today — see below) | tenantId (Application Plane scope)
//   sk = idpId
// **Lower-case `pk`/`sk` attribute names** — every other table in this file uses
// upper-case `PK`/`SK`. Must match `control-plane/handlers/idp-handler/ddb-store.ts`'s
// `PutCommand`/`GetCommand` Key names verbatim (mismatched case is a runtime
// `ValidationException`, not a compile-time error). No GSI.
//
// **Lite-only**: `SamlIdpsTable` is instantiated by `TenkaCloudLiteStack`
// (`lib/tenkacloud-lite/tenkacloud-lite-stack.ts`), NOT `ProblemDeployBackendStack`
// — unlike every other aggregate in this file. `TenantTemplateStack` (SaaS/Full
// mode) never passes `samlIdpsTable` to `buildAppPlaneCore`, so `SamlIdpLambda` is
// never created there; this seam has no SaaS-mode participation, and pure-SQL
// conditional synth is implemented in `TenkaCloudLiteStack`, not
// `ProblemDeployBackendStack` (see `AppPlaneCoreProps.attachSamlIdpLambda`).
//
// Do not confuse with the CompetitorAccounts-table `SAML_CONFIG` sub-aggregate
// (#839, modeled above as {@link SamlConfigRepository}) — a completely separate
// table, tenant SSO *display* config vs. this file's Cognito IdP *registry*.
// ---------------------------------------------------------------------------

/**
 * [Issue #2442 / Phase C5] Domain shape of one SAML IdP row — verbatim
 * `SamlIdpConfig` (`@tenkacloud/saml-utils`). The pre-seam DDB item has no
 * separate physical-key wrapper: `ddb-store.ts` spreads `config` directly into
 * the Item alongside `pk`/`sk`, so the domain record and the wire shape are
 * already the same object minus those two keys.
 */
export type SamlIdpRecord = SamlIdpConfig;

/**
 * [Issue #2442 / Phase C5] Repository for the SamlIdps aggregate — a verbatim
 * behavior-preserving relocation of `IdpStore`
 * (`control-plane/handlers/idp-handler/core.ts`) onto the `CONTROL_DATA_BACKEND`
 * seam. Method names/signatures (including `get`'s `| null` — not `| undefined`,
 * unlike every other point-read in this file) are unchanged so a resolved
 * instance is assignable directly to `IdpHandlerDeps.store: IdpStore` at the two
 * Lambda entry points (`control-plane/handlers/idp-handler/index.ts`,
 * `tenant-template/handlers/idp-handler/index.ts`) with no adapter layer beyond
 * the lazy per-call resolver (`createSeamIdpStore` in `ddb-store.ts`).
 */
export interface SamlIdpsRepository {
  /** Every IdP row for one scope (`SAML_IDP_LIMIT_PER_USERPOOL` = 25 bounds it — single Query/SELECT). */
  list(scope: IdpScope): Promise<readonly SamlIdpRecord[]>;
  /** Scoped point read. `null` (not `undefined`) when the row is absent — matches `IdpStore.get`. */
  get(scope: IdpScope, idpId: string): Promise<SamlIdpRecord | null>;
  /** Upsert one IdP row. No conditional write — `core.ts`'s `createIdp` performs the duplicate/limit checks via `get`/`list` before calling this. */
  put(scope: IdpScope, config: SamlIdpRecord): Promise<void>;
  /** Delete one IdP row (idempotent — `core.ts` probes existence via `get` first). */
  delete(scope: IdpScope, idpId: string): Promise<void>;
}
