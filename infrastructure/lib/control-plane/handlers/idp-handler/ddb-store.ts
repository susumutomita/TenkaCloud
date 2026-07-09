/**
 * {@link IdpStore} construction for the SAML IdP CRUD Lambdas (Issues #1293 / #1294).
 *
 * Table shape (`SamlIdps`):
 *   - PK: `${scope}#${idpId}` where `scope` is `SYSTEM` (Control Plane) or the
 *     tenantId (Application Plane). The Control Plane stack and the per-tenant
 *     stack each own their own table — they do not share storage.
 *
 *   - `idpId` is also stored as a top-level attribute for hydration.
 *
 * No GSI — list queries are bounded by `SAML_IDP_LIMIT_PER_USERPOOL` (25) and
 * a single Query call per scope suffices.
 *
 * [Issue #2442 / Phase C5] The raw DynamoDB access itself moved verbatim to
 * `control-data/dynamodb-saml-idps-repository.ts` (`DynamoDbSamlIdpsRepository`) so
 * it participates in the `CONTROL_DATA_BACKEND` seam like every other C-series
 * aggregate. Two factories live here now:
 *
 *   - {@link createDdbIdpStore} — thin backward-compatible wrapper that always
 *     forces the DynamoDB backend (existing tests / any caller that wants DDB
 *     regardless of `CONTROL_DATA_BACKEND`).
 *   - {@link createSeamIdpStore} — what both Lambda entry points actually wire
 *     (`control-plane/handlers/idp-handler/index.ts`,
 *     `tenant-template/handlers/idp-handler/index.ts`). Every `list`/`get`/`put`/
 *     `delete` call resolves the backend via
 *     `controlDataRuntime.resolveSamlIdpsRepository` (its SQL executor is
 *     cold-start-cached across warm invocations), so pure SQL (`turso`/`sql`)
 *     works even though `SamlIdpsTable` is never synthesized for that backend.
 */

import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoDbSamlIdpsRepository } from "../../../problem-deploy/control-data/dynamodb-saml-idps-repository.js";
import { controlDataRuntime } from "../../../problem-deploy/control-data/runtime-repositories.js";
import type { IdpScope, IdpStore } from "./core.js";

export interface DdbIdpStoreOptions {
  readonly ddb: DynamoDBDocumentClient;
  readonly tableName: string;
}

/**
 * Forces the DynamoDB backend regardless of `CONTROL_DATA_BACKEND`. Backed by
 * {@link DynamoDbSamlIdpsRepository} (the canonical, seam-participating
 * implementation) — same key marshalling, same behavior as before #2442.
 */
export function createDdbIdpStore(opts: DdbIdpStoreOptions): IdpStore {
  return new DynamoDbSamlIdpsRepository(opts.ddb, opts.tableName);
}

/**
 * [Issue #2442 / Phase C5] `CONTROL_DATA_BACKEND`-aware {@link IdpStore}.
 * `opts.tableName` may be `""` (pure SQL cold start, `SamlIdpsTable` not
 * synthesized) — `controlDataRuntime.resolveSamlIdpsRepository` only requires a
 * non-empty value when the resolved backend is `dynamodb` or a `*-mirror`
 * variant; the empty string is normalized to `undefined` before the resolver
 * sees it so the pure-SQL branch never treats "" as a real table name.
 */
export function createSeamIdpStore(opts: DdbIdpStoreOptions): IdpStore {
  const resolve = () =>
    controlDataRuntime.resolveSamlIdpsRepository({
      ddb: opts.ddb,
      samlIdpsTableName: opts.tableName || undefined,
    });
  return {
    list: async (scope: IdpScope) => (await resolve()).list(scope),
    get: async (scope: IdpScope, idpId: string) => (await resolve()).get(scope, idpId),
    put: async (scope: IdpScope, config) => (await resolve()).put(scope, config),
    delete: async (scope: IdpScope, idpId: string) => (await resolve()).delete(scope, idpId),
  };
}
