/**
 * [ADR-031 / Issue #1419] executor の DDB 副作用 dep 実装 (= `executeDisruptionAction` の
 * `claimExecution` / `resolveDeployment` の具体実装)。 既存 pattern を踏襲し新 SDK 依存を増やさない:
 *   - claim: disruption-fire の REQUEST# 冪等 claim と同型 (conditional Put + CCF=duplicate)
 *   - resolve: leaderboard-score-events の GSI1(TENANT#)+eventId filter query と同型
 *
 * AssumeRole / SDK 送信 / scheduler は別 dep (= deploy 判断を伴うため owner)。 ここは DDB のみ。
 */

import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { type DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { DeploymentItem } from "../deploy-handler/types.js";
import { parseStackOutputs } from "../shared/cfn-status.js";
import type { DeploymentTarget, DisruptionFiredDetail } from "./execute.js";

export interface ExecutorResources {
  readonly ddb: Pick<DynamoDBDocumentClient, "send">;
  /** Deployments テーブル (= deploy-handler が書く row)。 GSI1 = TENANT#。 */
  readonly deploymentsTableName: string;
  /** Disruptions テーブル (= fire の REQUEST#/AUDIT# と同居、 EXEC# 冪等行を置く)。 */
  readonly disruptionsTableName: string;
  /** EXEC# 行の TTL 秒数 (省略時 7 日)。 */
  readonly execTtlSeconds?: number;
}

const DEFAULT_EXEC_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * `EXEC#{requestId}#{teamId}` を conditional Put で奪う。 at-least-once 配送に対する per-team 冪等性。
 * ConditionalCheckFailed = 既に処理済 (duplicate)、 それ以外の error は伝播。
 *
 * [ADR-037] phase で claim key を分ける:
 *   - `"event"` (既定): fired event (EventBridge at-least-once) の重複を弾く。
 *   - `"inject"`: scheduled fire の遅延注入 (aws-scheduler at-least-once) の重複を弾く。 遅延注入は
 *     fired event とは別の配送経路なので、 別 key で claim しないと scheduler 再配送で二重注入になる。
 */
export async function claimExecution(
  resources: ExecutorResources,
  detail: DisruptionFiredDetail,
  nowMs: number,
  phase: "event" | "inject" = "event",
): Promise<"claimed" | "duplicate"> {
  const pk =
    phase === "inject"
      ? `EXEC#${detail.requestId}#${detail.teamId}#INJECT`
      : `EXEC#${detail.requestId}#${detail.teamId}`;
  try {
    await resources.ddb.send(
      new PutCommand({
        TableName: resources.disruptionsTableName,
        Item: {
          PK: pk,
          SK: "METADATA",
          disruptionId: detail.disruptionId,
          eventId: detail.eventId,
          problemId: detail.problemId,
          tenantId: detail.tenantId,
          teamId: detail.teamId,
          requestId: detail.requestId,
          firedAt: detail.firedAt,
          expiresAt:
            Math.floor(nowMs / 1000) + (resources.execTtlSeconds ?? DEFAULT_EXEC_TTL_SECONDS),
        },
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
    return "claimed";
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return "duplicate";
    throw err;
  }
}

/**
 * fired `(tenantId, eventId, teamId, problemId)` の **COMPLETE** deployment を GSI1 query で解決し、
 * cross-account 注入に必要な情報が揃った行のみ返す。 未 deploy / 未完了 / cross-account 情報や
 * stackOutputs 欠落は undefined (= 注入対象なし、 caller が no-op にする)。
 */
export async function resolveDeployment(
  resources: ExecutorResources,
  detail: DisruptionFiredDetail,
): Promise<DeploymentTarget | undefined> {
  const out = await resources.ddb.send(
    new QueryCommand({
      TableName: resources.deploymentsTableName,
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      FilterExpression: "eventId = :ev AND teamId = :tid AND problemId = :pid",
      ExpressionAttributeValues: {
        ":pk": `TENANT#${detail.tenantId}`,
        ":ev": detail.eventId,
        ":tid": detail.teamId,
        ":pid": detail.problemId,
      },
    }),
  );
  const items = (out.Items ?? []) as Partial<DeploymentItem>[];
  const ready = items.find(
    (d) =>
      d.status === "COMPLETE" &&
      typeof d.jobId === "string" &&
      typeof d.region === "string" &&
      typeof d.competitorRoleArn === "string" &&
      typeof d.externalIdParameterName === "string",
  );
  if (!ready) return undefined;
  return {
    jobId: ready.jobId as string,
    region: ready.region as string,
    competitorRoleArn: ready.competitorRoleArn as string,
    externalIdParameterName: ready.externalIdParameterName as string,
    stackOutputs: parseStackOutputs(ready.stackOutputs),
  };
}
