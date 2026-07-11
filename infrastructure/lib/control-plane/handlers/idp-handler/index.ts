/**
 * Control Plane SAML IdP CRUD Lambda (Issue #1293).
 *
 * Authorization (two layers):
 *   1. API Gateway HTTP API + JWT Authorizer pinned to the ControlPlane
 *      UserPool — token must be valid.
 *   2. This handler checks `custom:userRole == SystemAdmin` (matches the
 *      pattern in admin-insight-handler/auth.ts).
 *
 * Storage: `SAML_IDPS_TABLE_NAME` (DDB, PROVISIONED 1/1). PK = `SYSTEM`, SK = `idpId`.
 * [Issue #2442 / Phase C5]: goes through `createSeamIdpStore`
 * (`CONTROL_DATA_BACKEND`-aware) rather than unconditionally forcing DynamoDB;
 * the table name is optional so cold start does not fail-fast when it is
 * absent. This Lambda is not wired into any CDK stack today (Control Plane
 * scope is unused — see `saml-idps-table.ts`), so the relaxation only keeps
 * this file consistent with its Application Plane sibling.
 *
 * Cognito: `CONTROL_PLANE_USER_POOL_ID` env names the SBT ControlPlane UserPool.
 *
 * [USER-REVIEW]: the CDK addition that creates the table + grants the Lambda
 * `cognito-idp:Create/Update/DeleteIdentityProvider` against this UserPool is
 * left for the maintainer per AGENTS.md role split.
 */

import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { Context } from "hono";
import type { LambdaContext, LambdaEvent } from "hono/aws-lambda";
import { handle } from "hono/aws-lambda";
import { StatusCodes } from "http-status-codes";
import { createDefaultControlDataRuntime } from "../../../problem-deploy/control-data/runtime-repositories.js";
import { isSystemAdmin } from "./auth.js";
import { createCognitoIdpAdapter } from "./cognito-adapter.js";
import type { IdpScope } from "./core.js";
import { createSeamIdpStore } from "./ddb-store.js";
import { buildIdpApp } from "./routes.js";

// [#2527 Slice 4] Composition root: one control-data runtime per Lambda instance.
const controlDataRuntime = createDefaultControlDataRuntime();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Control Plane IdP Lambda env ${name} is not set`);
  return value;
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const cognito = new CognitoIdentityProviderClient({});

// [Issue #2442 / Phase C5] optional — pure SQL backend never synths SamlIdpsTable.
const TABLE_NAME = process.env.SAML_IDPS_TABLE_NAME ?? "";
const USER_POOL_ID = requireEnv("CONTROL_PLANE_USER_POOL_ID");

const app = buildIdpApp({
  pathPrefix: "/admin/idp",
  resolveScope: (c: Context): IdpScope | { readonly forbidden: Response } => {
    if (!isSystemAdmin(c)) {
      return {
        forbidden: c.json({ error: "forbidden" }, StatusCodes.FORBIDDEN),
      };
    }
    return { kind: "system" };
  },
  deps: {
    store: createSeamIdpStore({ runtime: controlDataRuntime, ddb, tableName: TABLE_NAME }),
    cognito: createCognitoIdpAdapter({ client: cognito, userPoolId: USER_POOL_ID }),
    now: () => new Date(),
  },
});

export const handler = handle(app) as (
  event: LambdaEvent,
  context: LambdaContext,
) => Promise<unknown>;

export { app };
