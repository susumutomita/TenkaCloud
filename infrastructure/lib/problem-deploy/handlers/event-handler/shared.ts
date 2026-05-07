import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { getEnv } from "../../../helper-functions.js";

/**
 * Event handler Lambda module-scope で 1 度だけ build される shared resources。
 * Events / Teams の 2 Table 名と DocumentClient を保持する。
 */
export interface EventSharedResources {
  readonly eventsTableName: string;
  readonly teamsTableName: string;
  readonly ddb: DynamoDBDocumentClient;
}

export function buildEventSharedResources(): EventSharedResources {
  return {
    eventsTableName: getEnv("EVENTS_TABLE_NAME"),
    teamsTableName: getEnv("TEAMS_TABLE_NAME"),
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
  };
}
