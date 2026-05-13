import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { decideReconcile } from "../status-policy.js";

/**
 * Issue #659: TenantMappingTable を scan して "In progress" stuck な row を
 * "Complete" / "Failed" に遷移させる。 EventBridge Schedule (= 2 分周期) から呼ばれる。
 *
 * RCU: TenantMappingTable はテナント数 = small (< 1000) を想定。 1 RCU = 4KB 行 1 read /
 * sec。 2 分周期 + 全件 scan で十分耐えうる (= dev scale: 数行 / production: 数十行)。
 * 大規模化したら GSI を `tenantStatus-createdAt` に切り、 status="In progress" のみを
 * query で読み出す経路に移行する (= Phase 2)。
 */

const tableName = (() => {
  const v = process.env.TENANT_MAPPING_TABLE_NAME;
  if (!v) throw new Error("env TENANT_MAPPING_TABLE_NAME is required");
  return v;
})();

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

interface TenantRow {
  readonly tenantId?: string;
  readonly tenantStatus?: string;
  readonly tenantConfig?: string;
  readonly createdAt?: string;
}

export async function handler(): Promise<{ scanned: number; updated: number }> {
  const nowMs = Date.now();
  let scanned = 0;
  let updated = 0;
  let lastKey: Record<string, unknown> | undefined;

  do {
    const out = await ddb.send(
      new ScanCommand({
        TableName: tableName,
        ExclusiveStartKey: lastKey,
        ProjectionExpression: "tenantId, tenantStatus, tenantConfig, createdAt",
      }),
    );
    const items = (out.Items ?? []) as TenantRow[];
    scanned += items.length;

    for (const row of items) {
      if (!row.tenantId) continue;
      const verdict = decideReconcile({
        tenantStatus: row.tenantStatus,
        tenantConfig: row.tenantConfig,
        createdAt: row.createdAt,
        nowMs,
      });
      if (verdict.action === "skip") continue;

      if (verdict.action === "complete") {
        await ddb.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { tenantId: row.tenantId },
            UpdateExpression: "SET tenantStatus = :s, reconciledAt = :t",
            ExpressionAttributeValues: {
              ":s": "Complete",
              ":t": new Date(nowMs).toISOString(),
            },
          }),
        );
        updated += 1;
        continue;
      }

      // action === "fail"
      await ddb.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { tenantId: row.tenantId },
          UpdateExpression:
            "SET tenantStatus = :s, failedAt = :t, failureReason = :r, reconciledAt = :t",
          ExpressionAttributeValues: {
            ":s": "Failed",
            ":t": new Date(nowMs).toISOString(),
            ":r": verdict.reason,
          },
        }),
      );
      updated += 1;
    }
    lastKey = out.LastEvaluatedKey;
  } while (lastKey);

  return { scanned, updated };
}
