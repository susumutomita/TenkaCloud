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
  };
}
