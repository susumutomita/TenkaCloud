import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { getEnv } from "../../../helper-functions.js";
import type { ProblemDisruptionEntry } from "../../../utils/discover-problems-catalog.js";
import type { DeploymentItem } from "../deploy-handler/types.js";
import { parseProblemsCatalog } from "../shared/catalog.js";

/**
 * Event handler Lambda module-scope で 1 度だけ build される shared resources。
 *
 * Phase 1 では Events / Teams のみ触るため deploymentsTableName / events client は
 * 不要だったが、Phase 2a の Bulk Deploy / Bulk Teardown 経路で Deployments table
 * への書き込み + EventBridge publish (DeployCreateRequested / DeployDeleteRequested)
 * が必要になったため拡張する。problemsCatalog は bulk deploy 時に problemId → problemDir
 * を解決するため env (BATTLE_PROBLEMS_CATALOG) から JSON parse する。
 *
 * Issue #459 / ADR-002 Phase 2.2: bulk-deploy が verified=true 行のみを許可する
 * gate を持つため、`CompetitorAccounts` table 名と SSM SecureString path 構築用の
 * `env` を share する。
 */
export interface EventSharedResources {
  readonly eventsTableName: string;
  readonly teamsTableName: string;
  readonly deploymentsTableName: string;
  readonly competitorAccountsTableName: string;
  /** Issue #888: disruption audit + idempotency 用 DDB table。 deploy 時に env で wire。 */
  readonly disruptionsTableName: string;
  readonly eventBusName: string;
  readonly env: string;
  readonly ddb: DynamoDBDocumentClient;
  readonly events: EventBridgeClient;
  readonly problemsCatalog: Readonly<Record<string, string>>;
  /** Issue #888: problem metadata.json の `disruptions[]` 宣言 (problemId 毎)。 */
  readonly problemsDisruptions: Readonly<Record<string, readonly ProblemDisruptionEntry[]>>;
}

export function buildEventSharedResources(): EventSharedResources {
  return {
    eventsTableName: getEnv("EVENTS_TABLE_NAME"),
    teamsTableName: getEnv("TEAMS_TABLE_NAME"),
    deploymentsTableName: getEnv("DEPLOYMENTS_TABLE_NAME"),
    competitorAccountsTableName: getEnv("COMPETITOR_ACCOUNTS_TABLE_NAME"),
    disruptionsTableName: getEnv("DISRUPTIONS_TABLE_NAME"),
    eventBusName: getEnv("DEPLOY_EVENT_BUS_NAME"),
    env: getEnv("DEPLOY_ENVIRONMENT"),
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    events: new EventBridgeClient({}),
    problemsCatalog: parseProblemsCatalog(process.env.BATTLE_PROBLEMS_CATALOG),
    problemsDisruptions: parseProblemsDisruptions(process.env.BATTLE_PROBLEMS_DISRUPTIONS),
  };
}

function parseProblemsDisruptions(
  raw: string | undefined,
): Readonly<Record<string, readonly ProblemDisruptionEntry[]>> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, ProblemDisruptionEntry[]>;
    return parsed;
  } catch {
    return {};
  }
}

/**
 * Deployments table から指定 event の全行を取得する共通 helper。
 *
 * 内部的に GSI1 (TENANT#<tenantId>) を query し、`FilterExpression` で eventId 一致だけ
 * を返す。Filter は post-read のため RCU は変わらないが、ネットワーク転送 + Lambda 内
 * 処理量は削減できる (= ~750 行規模で意味のある差)。
 *
 * Phase 3+ で eventId 専用 GSI に切り替えれば 1 query で済むが、現状は単一 tenant 内
 * 全 deployment が <100 程度の運用想定で十分。Phase 2a の bulk-delete から、Phase 2c
 * 経由の schedule (eventStartsAt 伝播) まで同じ query が必要なので 1 箇所に集約。
 */
export async function queryDeploymentsByEvent(
  shared: EventSharedResources,
  tenantId: string,
  eventId: string,
  projectionExpression?: string,
): Promise<Partial<DeploymentItem>[]> {
  // Issue #670: DDB は `status` 等の reserved word を ProjectionExpression / FilterExpression
  // / UpdateExpression 全てで alias 必須。 caller が `#s` を含む projection を渡すケース
  // (= bulk-deploy.ts が `jobId, teamId, problemId, #s` で呼ぶ) を黙ってサポートするため、
  // alias を本 helper 側で定義する。 caller が `#s` を使わなくても extra alias は ignored。
  const out = await shared.ddb.send(
    new QueryCommand({
      TableName: shared.deploymentsTableName,
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      FilterExpression: "eventId = :ev",
      ExpressionAttributeValues: {
        ":pk": `TENANT#${tenantId}`,
        ":ev": eventId,
      },
      ...(projectionExpression
        ? {
            ProjectionExpression: projectionExpression,
            ...(projectionExpression.includes("#s")
              ? { ExpressionAttributeNames: { "#s": "status" } }
              : {}),
          }
        : {}),
    }),
  );
  return (out.Items ?? []) as Partial<DeploymentItem>[];
}
