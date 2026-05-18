import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

/**
 * AdminInsight Lambda が module load で 1 度だけ作るリソース束。
 *
 * Lambda warm invoke で SDK client / connection pool を使い回すため、handler 外で
 * `buildSharedResources()` を呼ぶ。env が無い場合は **module 評価時に throw** して
 * `Initialization Error` で落とす (= 後段 routes が `undefined` 参照で意味不明な 500 を
 * 返すよりは fail-fast)。
 */
export interface AdminInsightSharedResources {
  readonly deploymentsTableName: string;
  readonly eventsTableName: string;
  readonly teamsTableName: string;
  readonly ddb: DynamoDBDocumentClient;
  /**
   * Issue #950 (ADR-020 Phase D): admin audit log table 名。 未配線時は空文字、
   * handler の audit route が 503 を返す。
   */
  readonly auditTableName: string;
  /** Issue #950: 環境名 (= SYSTEM 操作の PK 構築に使う `SYSTEM#<env>`)。 */
  readonly environmentName: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`AdminInsight Lambda の env ${name} が未設定です`);
  }
  return value;
}

export function buildSharedResources(): AdminInsightSharedResources {
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return {
    deploymentsTableName: requireEnv("DEPLOYMENTS_TABLE_NAME"),
    eventsTableName: requireEnv("EVENTS_TABLE_NAME"),
    teamsTableName: requireEnv("TEAMS_TABLE_NAME"),
    ddb,
    // Issue #950: 未配線時は空文字。 caller (audit route) が 503 を返す。
    auditTableName: process.env.ADMIN_AUDIT_LOG_TABLE_NAME ?? "",
    environmentName: process.env.DEPLOY_ENVIRONMENT ?? "development",
  };
}
