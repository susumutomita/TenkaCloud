import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SSMClient } from "@aws-sdk/client-ssm";
import { STSClient } from "@aws-sdk/client-sts";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { getEnv } from "../../../helper-functions.js";
import type { ControlDataRuntime } from "../../control-data/runtime-repositories.js";

/**
 * Competitor Accounts handler の module-scope shared resources。
 *
 * - `tableName` = `CompetitorAccounts` DDB (Issue #459)
 * - `env` / `tenkaCloudAccountId` = SSM path 構築 + 「Add account」レスポンスで返す値
 * - `cognito` = Issue #839 Phase B で SAML IdP CRUD に使う Cognito-IDP client
 *
 * Lambda は warm invoke で SDK client を 1 つだけ持つ (= cold start 軽減)。
 */
export interface CompetitorAccountsSharedResources {
  /** [#2527 Slice 4] Injected control-data runtime (from the Lambda entrypoint's instance). */
  readonly runtime: ControlDataRuntime;
  readonly tableName: string;
  readonly env: string;
  readonly tenkaCloudAccountId: string;
  readonly ddb: DynamoDBDocumentClient;
  readonly ssm: SSMClient;
  readonly sts: STSClient;
  readonly cognito: CognitoIdentityProviderClient;
}

export function buildCompetitorAccountsSharedResources(
  runtime: ControlDataRuntime,
): CompetitorAccountsSharedResources {
  return {
    runtime,
    // [Issue #2442 / Phase C2] `controlDataBackend` が純 SQL (`turso`) のときは
    // CompetitorAccounts table 自体が synth されず env も配線されないため、module-load を
    // `getEnv` の fail-fast に委ねると cold start が Initialization Error で落ちる。空文字
    // default に緩和し、dynamodb backend の誤設定は runtime resolver
    // (`aggregate-resolvers.ts` の `requireDdbAndTableName`) が fail loud に受ける
    // (= silent fallback にはならない、event-handler/shared.ts と同じ緩和)。
    tableName: process.env.COMPETITOR_ACCOUNTS_TABLE_NAME ?? "",
    env: getEnv("DEPLOY_ENVIRONMENT"),
    tenkaCloudAccountId: getEnv("TENKACLOUD_ACCOUNT_ID"),
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    ssm: new SSMClient({}),
    sts: new STSClient({}),
    cognito: new CognitoIdentityProviderClient({}),
  };
}
