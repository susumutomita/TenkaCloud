import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { getEnv } from "../../../helper-functions.js";
import { parseProblemsCatalog } from "../shared/catalog.js";

/**
 * Event handler Lambda module-scope で 1 度だけ build される shared resources。
 *
 * Phase 1 では Events / Teams のみ触るため deploymentsTableName / events client は
 * 不要だったが、Phase 2a の Bulk Deploy / Bulk Teardown 経路で Deployments table
 * への書き込み + EventBridge publish (DeployCreateRequested / DeployDeleteRequested)
 * が必要になったため拡張する。problemsCatalog は bulk deploy 時に problemId → problemDir
 * を解決するため env (BATTLE_PROBLEMS_CATALOG) から JSON parse する。
 */
export interface EventSharedResources {
  readonly eventsTableName: string;
  readonly teamsTableName: string;
  readonly deploymentsTableName: string;
  readonly eventBusName: string;
  readonly ddb: DynamoDBDocumentClient;
  readonly events: EventBridgeClient;
  readonly problemsCatalog: Readonly<Record<string, string>>;
}

export function buildEventSharedResources(): EventSharedResources {
  return {
    eventsTableName: getEnv("EVENTS_TABLE_NAME"),
    teamsTableName: getEnv("TEAMS_TABLE_NAME"),
    deploymentsTableName: getEnv("DEPLOYMENTS_TABLE_NAME"),
    eventBusName: getEnv("DEPLOY_EVENT_BUS_NAME"),
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    events: new EventBridgeClient({}),
    problemsCatalog: parseProblemsCatalog(process.env.BATTLE_PROBLEMS_CATALOG),
  };
}
