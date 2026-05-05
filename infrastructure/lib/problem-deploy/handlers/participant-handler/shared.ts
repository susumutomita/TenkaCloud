import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { getEnv } from "../../../helper-functions.js";
import { parseProblemsScoring } from "./submit-flag.js";

/**
 * Participant Lambda は DDB Query しか叩かない。Deploy Worker / API が使う
 * `DeploySharedResources` (EventBridge クライアントを含む) を流用すると
 * 不要な SDK 初期化と未使用 env (`DEPLOY_EVENT_BUS_NAME`) を要求してしまうため、
 * 必要最小限の shape を独自に定義する。
 */
export interface ParticipantSharedResources {
  readonly tableName: string;
  readonly ddb: DynamoDBDocumentClient;
  /** `{ [problemId]: scoring }`。submit-flag が採点に使う。 */
  readonly problemsScoring: Record<string, unknown>;
}

export function buildParticipantSharedResources(): ParticipantSharedResources {
  return {
    tableName: getEnv("DEPLOYMENTS_TABLE_NAME"),
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    problemsScoring: parseProblemsScoring(process.env.BATTLE_PROBLEMS_SCORING),
  };
}
