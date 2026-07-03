import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { getEnv } from "../../../helper-functions.js";
import { type ProblemEndpointSlot, parseEndpointsEnv } from "../../../utils/endpoints-metadata.js";
import { type ProblemScoringMetadata, parseScoringEnv } from "../../../utils/scoring-metadata.js";
import { type ProblemWriteup, parseWriteupsEnv } from "../../../utils/writeup-metadata.js";
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
  /**
   * ADR-012 Phase 3.A: Endpoint registry table 名 (= ProblemEndpoints)。
   * `/portal/me/problems/:problemId/endpoints` 系 route が読み書きする。
   * 未配線時 (= 古い deploy / Phase 3.A 適用前) は空文字、route 側で 503 ガード。
   */
  readonly endpointsTableName: string;
  readonly ddb: DynamoDBDocumentClient;
  /** SSM SecureString client for tenant ExternalId lookup used by AWS Console SSO. */
  readonly ssm?: Pick<SSMClient, "send">;
  /** Deploy environment segment used in `/{env}/tenants/{tenantId}/external-id`. */
  readonly env?: string;
  /** `{ [problemId]: ProblemScoringMetadata }`。submit-flag が採点に使う。 */
  readonly problemsScoring: Record<string, ProblemScoringMetadata>;
  /** Issue #2191: backend-only post-solve explanations. */
  readonly problemsWriteups?: Record<string, ProblemWriteup>;
  /**
   * ADR-012 Phase 3.A: `{ [problemId]: ProblemEndpointSlot[] }`。endpoint registry
   * route が default URL 算出に使う。`endpoints[]` 宣言の無い problem は key ごと不在。
   */
  readonly problemsEndpoints: Record<string, readonly ProblemEndpointSlot[]>;
}

export function buildParticipantSharedResources(): ParticipantSharedResources {
  return {
    tableName: getEnv("DEPLOYMENTS_TABLE_NAME"),
    eventsTableName: getEnv("EVENTS_TABLE_NAME"),
    // 未配線時 (= legacy stack) でも import が落ちないよう env 必須にしない (= 空文字)。
    // route 側で空チェックして 503 を返す経路にする。
    endpointsTableName: process.env.PROBLEM_ENDPOINTS_TABLE_NAME ?? "",
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    ssm: new SSMClient({}),
    env: getEnv("DEPLOY_ENVIRONMENT"),
    problemsScoring: parseScoringEnv(process.env.BATTLE_PROBLEMS_SCORING),
    problemsWriteups: parseWriteupsEnv(process.env.BATTLE_PROBLEMS_WRITEUPS),
    problemsEndpoints: parseEndpointsEnv(process.env.PROBLEM_ENDPOINTS),
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
