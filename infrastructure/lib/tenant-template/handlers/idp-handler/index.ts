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
 * [USER-REVIEW]: the CDK addition that wires the per-tenant table + IAM
 * scoping (silo UserPool ARN vs pooled UserPool ARN + tenant-prefixed
 * `cognito-idp:*IdentityProvider` perms) is left for the maintainer.
 */

import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { Context } from "hono";
import type { LambdaContext, LambdaEvent } from "hono/aws-lambda";
import { handle } from "hono/aws-lambda";
import { StatusCodes } from "http-status-codes";
import {
  isTenantAdmin,
  resolveTenantId,
} from "../../../control-plane/handlers/idp-handler/auth.js";
import { createCognitoIdpAdapter } from "../../../control-plane/handlers/idp-handler/cognito-adapter.js";
import type { IdpScope } from "../../../control-plane/handlers/idp-handler/core.js";
import { createDdbIdpStore } from "../../../control-plane/handlers/idp-handler/ddb-store.js";
import { buildIdpApp } from "../../../control-plane/handlers/idp-handler/routes.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Application Plane IdP Lambda env ${name} is not set`);
  return value;
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const cognito = new CognitoIdentityProviderClient({});

const TABLE_NAME = requireEnv("SAML_IDPS_TABLE_NAME");
const USER_POOL_ID = requireEnv("TENANT_USER_POOL_ID");

const app = buildIdpApp({
  pathPrefix: "/tenant/idp",
  resolveScope: (c: Context): IdpScope | { readonly forbidden: Response } => {
    if (!isTenantAdmin(c)) {
      return {
        forbidden: c.json({ error: "forbidden" }, StatusCodes.FORBIDDEN),
      };
    }
    const tenantId = resolveTenantId(c);
    if (!tenantId) {
      return {
        forbidden: c.json({ error: "forbidden_missing_tenant" }, StatusCodes.FORBIDDEN),
      };
    }
    return { kind: "tenant", tenantId };
  },
  deps: {
    store: createDdbIdpStore({ ddb, tableName: TABLE_NAME }),
    cognito: createCognitoIdpAdapter({ client: cognito, userPoolId: USER_POOL_ID }),
    now: () => new Date(),
  },
});

export const handler = handle(app) as (
  event: LambdaEvent,
  context: LambdaContext,
) => Promise<unknown>;

export { app };
