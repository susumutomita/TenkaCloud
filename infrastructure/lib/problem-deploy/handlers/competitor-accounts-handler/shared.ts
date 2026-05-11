import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SSMClient } from "@aws-sdk/client-ssm";
import { STSClient } from "@aws-sdk/client-sts";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { getEnv } from "../../../helper-functions.js";

/**
 * Competitor Accounts handler の module-scope shared resources。
 *
 * - `tableName` = `CompetitorAccounts` DDB (Issue #459 / ADR-002)
 * - `env` / `tenkaCloudAccountId` = SSM path 構築 + 「Add account」レスポンスで返す値
 *
 * Lambda は warm invoke で SDK client を 1 つだけ持つ (= cold start 軽減)。
 */
export interface CompetitorAccountsSharedResources {
  readonly tableName: string;
  readonly env: string;
  readonly tenkaCloudAccountId: string;
  readonly ddb: DynamoDBDocumentClient;
  readonly ssm: SSMClient;
  readonly sts: STSClient;
}

export function buildCompetitorAccountsSharedResources(): CompetitorAccountsSharedResources {
  return {
    tableName: getEnv("COMPETITOR_ACCOUNTS_TABLE_NAME"),
    env: getEnv("DEPLOY_ENVIRONMENT"),
    tenkaCloudAccountId: getEnv("TENKACLOUD_ACCOUNT_ID"),
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    ssm: new SSMClient({}),
    sts: new STSClient({}),
  };
}
