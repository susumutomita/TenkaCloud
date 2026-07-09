/**
 * Application Plane SAML IdP CRUD Lambda's module-scope shared resources
 * (Issue #1294; split out of `index.ts` in #2442 Phase C5).
 *
 * `tableName` mirrors `buildCompetitorAccountsSharedResources`'s relaxation
 * (`?? ""` instead of `requireEnv`): pure SQL backend (`turso`/`sql`) selection
 * means `TenkaCloudLiteStack` does not synth `SamlIdpsTable` at all, so
 * `SAML_IDPS_TABLE_NAME` is absent from the Lambda's environment. Fail-fasting
 * on module load would turn that into an Initialization Error for the whole
 * Lambda instead of a graceful fall-through to the SQL executor — the
 * repository seam (`createSeamIdpStore` → `resolveSamlIdpsRepository`) is what
 * actually enforces "table required" for the `dynamodb` / `*-mirror` backends
 * (fail loud there, not here).
 *
 * `TENANT_USER_POOL_ID` stays required: the tenant UserPool always exists
 * regardless of `CONTROL_DATA_BACKEND`.
 */

import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Application Plane IdP Lambda env ${name} is not set`);
  return value;
}

export interface IdpHandlerSharedResources {
  readonly tableName: string;
  readonly userPoolId: string;
  readonly ddb: DynamoDBDocumentClient;
  readonly cognito: CognitoIdentityProviderClient;
}

export function buildIdpSharedResources(): IdpHandlerSharedResources {
  return {
    // [Issue #2442 / Phase C5] Pure SQL backend never synths SamlIdpsTable — see file header.
    tableName: process.env.SAML_IDPS_TABLE_NAME ?? "",
    userPoolId: requireEnv("TENANT_USER_POOL_ID"),
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    cognito: new CognitoIdentityProviderClient({}),
  };
}
