import { DeleteCommand, type DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";

/**
 * [#2866] Shared TTL sweep for the DynamoDB control-data repositories.
 *
 * DynamoDB removes expired rows natively via each table's TTL attribute; this
 * manual Scan + Delete sweep exists so the seam is uniform with the SQLite
 * backends (no native TTL, ADR-049 §5.2). It is idempotent and only ever
 * deletes rows DynamoDB's own TTL would also drop, so it is safe on the DDB
 * backend too. Five repositories (admin-audit-log / events / notifications /
 * teams / disruptions) carried this loop verbatim — it now lives here once.
 *
 * The caller passes its FilterExpression (and attribute-name aliases) verbatim
 * so every repository keeps its exact pre-extraction request bytes: four tables
 * filter on `expiresAt`, the admin-audit-log table on the reserved-word-safe
 * `#ttl` alias. All five share the physical `PK` / `SK` key shape.
 */
export async function sweepExpiredRows(opts: {
  readonly ddb: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly nowEpochSeconds: number;
  /** e.g. `"expiresAt > :zero AND expiresAt <= :now"` — kept verbatim per table. */
  readonly filterExpression: string;
  readonly expressionAttributeNames?: Readonly<Record<string, string>>;
}): Promise<number> {
  let deleted = 0;
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const out = await opts.ddb.send(
      new ScanCommand({
        TableName: opts.tableName,
        FilterExpression: opts.filterExpression,
        ...(opts.expressionAttributeNames
          ? { ExpressionAttributeNames: { ...opts.expressionAttributeNames } }
          : {}),
        ExpressionAttributeValues: { ":zero": 0, ":now": opts.nowEpochSeconds },
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );
    for (const item of (out.Items ?? []) as Record<string, unknown>[]) {
      await opts.ddb.send(
        new DeleteCommand({
          TableName: opts.tableName,
          Key: { PK: item.PK, SK: item.SK },
        }),
      );
      deleted += 1;
    }
    exclusiveStartKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return deleted;
}
