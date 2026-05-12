import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { getEnv } from "../../../helper-functions.js";

/**
 * Microservice Migration Registration handler の module-scope shared resources。
 *
 * - `tableName` = `MicroserviceMigrationScoresTable` の DDB 物理名 (env 注入)
 *
 * Lambda は warm invoke で 1 つの SDK client を使い回す (cold start 軽減)。
 * 別 SDK (S3 / SSM 等) は登録 API では不要なので持たない (= IAM blast-radius 縮小)。
 */
export interface MicroserviceMigrationRegistrationSharedResources {
  readonly tableName: string;
  readonly ddb: DynamoDBDocumentClient;
}

export function buildMicroserviceMigrationRegistrationSharedResources(): MicroserviceMigrationRegistrationSharedResources {
  return {
    tableName: getEnv("MICROSERVICE_MIGRATION_SCORES_TABLE_NAME"),
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
  };
}
