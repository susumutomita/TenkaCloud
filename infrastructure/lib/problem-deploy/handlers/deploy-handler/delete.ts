import { GetCommand, UpdateCommand, type UpdateCommandInput } from "@aws-sdk/lib-dynamodb";
import type { DeploySharedResources } from "./deploy.js";
import type { DeploymentItem, DeploymentStatus } from "./types.js";

export type TeardownOutcome =
  | { kind: "accepted"; previousStatus: DeploymentStatus }
  | { kind: "not_found" }
  | { kind: "already_deleted" }
  | { kind: "race"; reason: "tenant_or_status_mismatch" };

const TEARDOWNABLE_STATUSES: ReadonlySet<DeploymentStatus> = new Set([
  "PENDING",
  "IN_PROGRESS",
  "COMPLETE",
  "FAILED",
]);

/**
 * 手動 teardown を要求する。新しく CFn DeleteStack を呼ぶ Lambda は作らず、
 * `expiresAt` を現在時刻に書き換えて既存の StatusUpdater (1 min) に拾わせる。
 *
 * これで:
 *   - Deploy API Lambda に新しい STS / CFn 権限を足さない
 *   - auto-teardown TTL の経路と同じ機械で動く (idempotent / let-win 込み)
 *   - 0〜60 秒の遅延は許容
 *
 * 既に `DELETING` / `DELETED` の行は no-op で返す。
 * クロステナント漏洩防止のため `tenantId` mismatch は `not_found` 扱い (存在を漏らさない)。
 */
export async function requestTeardown(
  shared: DeploySharedResources,
  tenantId: string,
  jobId: string,
  nowMs: number,
): Promise<TeardownOutcome> {
  const got = await shared.ddb.send(
    new GetCommand({
      TableName: shared.tableName,
      Key: { PK: `DEPLOYMENT#${jobId}`, SK: "META" },
    }),
  );
  const item = got.Item as Partial<DeploymentItem> | undefined;
  if (!item) return { kind: "not_found" };
  if (item.tenantId !== tenantId) return { kind: "not_found" };
  const status = (item.status ?? "PENDING") as DeploymentStatus;
  if (status === "DELETING" || status === "DELETED") return { kind: "already_deleted" };

  const update: UpdateCommandInput = {
    TableName: shared.tableName,
    Key: { PK: `DEPLOYMENT#${jobId}`, SK: "META" },
    UpdateExpression: "SET expiresAt = :expiresAt, updatedAt = :updatedAt",
    ConditionExpression: "tenantId = :tenantId AND #s IN (:p, :i, :c, :f)",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: {
      ":expiresAt": Math.floor(nowMs / 1000),
      ":updatedAt": new Date(nowMs).toISOString(),
      ":tenantId": tenantId,
      ":p": "PENDING",
      ":i": "IN_PROGRESS",
      ":c": "COMPLETE",
      ":f": "FAILED",
    },
  };
  try {
    await shared.ddb.send(new UpdateCommand(update));
  } catch (err) {
    const code = (err as { name?: string })?.name ?? "";
    if (code === "ConditionalCheckFailedException") {
      return { kind: "race", reason: "tenant_or_status_mismatch" };
    }
    throw err;
  }
  return { kind: "accepted", previousStatus: status };
}

export { TEARDOWNABLE_STATUSES };
