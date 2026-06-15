import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { getEnv } from "../../../helper-functions.js";
import { handleUsageMeteringEvent } from "./repository.js";

const shared = {
  ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
  tableName: getEnv("USAGE_FACTS_TABLE_NAME"),
};

/**
 * Usage metering event consumer.
 *
 * CDK/EventBridge wiring is intentionally outside this handler. The handler accepts the
 * stable detail-type contracts from repository.ts and records idempotent daily usage facts.
 */
export async function handler(event: unknown): Promise<{ readonly recorded: boolean }> {
  const result = await handleUsageMeteringEvent(shared, event);
  return { recorded: result.recorded };
}
