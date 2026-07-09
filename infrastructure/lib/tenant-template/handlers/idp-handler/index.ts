/**
 * Application Plane SAML IdP CRUD Lambda (Issue #1294).
 *
 * Per-tenant scope:
 *   - Caller is a Cognito TenantAdmin (= JWT `custom:userRole == TenantAdmin`).
 *   - All reads / writes are scoped to the caller's `custom:tenantId` claim
 *     — tenant A cannot see or modify tenant B's IdPs. The Application Plane
 *     handler enforces this by ignoring any tenantId on the body and using
 *     the JWT-derived value.
 *
 * Pooled vs silo UserPool (= per #1294 acceptance "Design ADR for per-tenant
 * IdP model"):
 *   - BASIC / STANDARD / PREMIUM (pooled): one UserPool serves N tenants.
 *     Cognito federated IdPs are global to the UserPool, so the `idpId` MUST
 *     be namespaced by tenantId (`${tenantId}__${idpId}`) when calling
 *     `CreateIdentityProvider`. We do this transparently inside the cognito
 *     adapter when `IDP_NAMESPACE_PREFIX_TENANT` env is `"true"`.
 *   - PLATINUM (silo): each tenant has its own UserPool. `idpId` is stored
 *     verbatim. `IDP_NAMESPACE_PREFIX_TENANT` env defaults to `"false"`.
 *
 *   See PR body for the full pooled-vs-silo trade-off.
 *
 * [Issue #2442 / Phase C5]: storage now goes through `createSeamIdpStore`
 * (`CONTROL_DATA_BACKEND`-aware) instead of unconditionally forcing DynamoDB —
 * `shared.ts` reads the env / builds the SDK clients so the store construction
 * below stays a one-line wire-up.
 */

import type { LambdaContext, LambdaEvent } from "hono/aws-lambda";
import { handle } from "hono/aws-lambda";
import { createCognitoIdpAdapter } from "../../../control-plane/handlers/idp-handler/cognito-adapter.js";
import { createSeamIdpStore } from "../../../control-plane/handlers/idp-handler/ddb-store.js";
import { buildIdpApp } from "../../../control-plane/handlers/idp-handler/routes.js";
import { buildIdpSharedResources } from "./shared.js";
import { createTenantIdpResolveScope } from "./tier-guard.js";

const shared = buildIdpSharedResources();

/**
 * Defense-in-depth tier guard.
 *
 * The UI hides IdP CRUD for pooled-tier tenants, but a TenantAdmin with a
 * valid JWT could bypass the SPA and call this API directly. In a pooled
 * UserPool that would mutate the SHARED UserPool's federated IdPs — a
 * cross-tenant data-plane impact.
 *
 * The CDK wiring deploys this Lambda only for silo (PLATINUM) tenants and
 * sets `IDP_TIER_GUARD=silo` on that Lambda. If the env is absent or any
 * other value (= the Lambda was wired into a pooled deployment by mistake),
 * the handler returns 503 for every request — fail-closed at runtime even
 * if the CDK side regresses.
 *
 * [USER-REVIEW]: CDK must set `IDP_TIER_GUARD=silo` only on silo-tenant
 * Lambdas. Pooled deployments should not have this handler at all; the env
 * check is the second line of defense.
 */
const app = buildIdpApp({
  pathPrefix: "/tenant/idp",
  resolveScope: createTenantIdpResolveScope(process.env.IDP_TIER_GUARD),
  deps: {
    store: createSeamIdpStore({ ddb: shared.ddb, tableName: shared.tableName }),
    cognito: createCognitoIdpAdapter({ client: shared.cognito, userPoolId: shared.userPoolId }),
    now: () => new Date(),
  },
});

export const handler = handle(app) as (
  event: LambdaEvent,
  context: LambdaContext,
) => Promise<unknown>;

export { app };
