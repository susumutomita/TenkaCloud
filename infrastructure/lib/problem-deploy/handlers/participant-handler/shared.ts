import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { getEnv } from "../../../helper-functions.js";
import { type ProblemScoringMetadata, parseScoringEnv } from "../../../utils/scoring-metadata.js";
import type { DeploymentItem } from "../deploy-handler/types.js";

/**
 * Participant Lambda は DDB Query しか叩かない。Deploy Worker / API が使う
 * `DeploySharedResources` (EventBridge クライアントを含む) を流用すると
 * 不要な SDK 初期化と未使用 env (`DEPLOY_EVENT_BUS_NAME`) を要求してしまうため、
 * 必要最小限の shape を独自に定義する。
 */
export interface ParticipantSharedResources {
  readonly tableName: string;
  /**
   * Events table 名 (ADR-006 Notifications で参照)。`GET /portal/me/notifications` が
   * `PK=EVENT#<eventId>` の partition で `begins_with(SK, "NOTIFICATION#")` を
   * Query する。CDK 側で IAM `dynamodb:Query` を Events table にも付与する。
   */
  readonly eventsTableName: string;
  readonly ddb: DynamoDBDocumentClient;
  /** `{ [problemId]: ProblemScoringMetadata }`。submit-flag が採点に使う。 */
  readonly problemsScoring: Record<string, ProblemScoringMetadata>;
}

export function buildParticipantSharedResources(): ParticipantSharedResources {
  return {
    tableName: getEnv("DEPLOYMENTS_TABLE_NAME"),
    eventsTableName: getEnv("EVENTS_TABLE_NAME"),
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    problemsScoring: parseScoringEnv(process.env.BATTLE_PROBLEMS_SCORING),
  };
}

/**
 * teamLoginKey で GSI2 を Query して team の全 deployment 行を返す共通 helper
 * (lookup / update / submit-flag が同じ query を使うため)。
 */
export async function queryTeamItems(
  shared: ParticipantSharedResources,
  teamLoginKey: string,
): Promise<Partial<DeploymentItem>[]> {
  const out = await shared.ddb.send(
    new QueryCommand({
      TableName: shared.tableName,
      IndexName: "GSI2",
      KeyConditionExpression: "GSI2PK = :pk",
      ExpressionAttributeValues: { ":pk": `TEAMKEY#${teamLoginKey}` },
    }),
  );
  return (out.Items ?? []) as Partial<DeploymentItem>[];
}
