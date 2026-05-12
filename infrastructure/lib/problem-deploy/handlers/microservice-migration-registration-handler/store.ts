import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  MICROSERVICE_MIGRATION_PROBLEM_ID,
  type MicroserviceMigrationSlot,
} from "../microservice-migration-poller-handler/scoring.js";
import type { MicroserviceMigrationRegistrationSharedResources } from "./shared.js";
import {
  buildScorePk,
  buildScoreSk,
  type ListEndpointsResponse,
  type MicroserviceMigrationScoreItem,
  type RegisterEndpointRequest,
  type RegisterEndpointResponse,
} from "./types.js";

export interface RegisterEndpointContext {
  readonly tenantId: string;
  readonly nowMs: number;
  readonly registeredBy: string;
}

/**
 * 1 slot の endpoint を upsert する。
 *
 * - 既存 row があれば `registeredUrl` / `registeredAt` / `registeredBy` のみ上書き。
 * - polling Lambda が書く observation 系属性 (`platform` / `lastProbeAt` 等) は保持
 *   (= UpdateExpression で触る属性を限定するため)。
 *
 * race (登録と probe 同時): 最後勝ち (LWW) で十分 — 1 min 以内に polling が
 * observation 列を埋め直す。
 */
export async function registerEndpoint(
  shared: MicroserviceMigrationRegistrationSharedResources,
  ctx: RegisterEndpointContext,
  req: RegisterEndpointRequest,
): Promise<RegisterEndpointResponse> {
  const nowIso = new Date(ctx.nowMs).toISOString();
  const pk = buildScorePk(ctx.tenantId);
  const sk = buildScoreSk(req.slot);

  await shared.ddb.send(
    new UpdateCommand({
      TableName: shared.tableName,
      Key: { PK: pk, SK: sk },
      UpdateExpression: [
        "SET",
        "tenantId = :tenant,",
        "problemId = :problemId,",
        "slot = :slot,",
        "registeredUrl = :url,",
        "registeredAt = :now,",
        "registeredBy = :by",
      ].join(" "),
      ExpressionAttributeValues: {
        ":tenant": ctx.tenantId,
        ":problemId": MICROSERVICE_MIGRATION_PROBLEM_ID,
        ":slot": req.slot,
        ":url": req.url,
        ":now": nowIso,
        ":by": ctx.registeredBy,
      },
    }),
  );

  return {
    slot: req.slot,
    registeredUrl: req.url,
    registeredAt: nowIso,
  };
}

/**
 * 1 tenant 分の登録 slot を返す (最大 3 件: users / orders / catalog)。
 *
 * PK = `TENANT#<tenantId>#PROBLEM#microservice-migration-battle` で Query。GSI 不要。
 */
export async function listEndpoints(
  shared: MicroserviceMigrationRegistrationSharedResources,
  tenantId: string,
): Promise<ListEndpointsResponse> {
  const pk = buildScorePk(tenantId);
  const out = await shared.ddb.send(
    new QueryCommand({
      TableName: shared.tableName,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": pk },
    }),
  );
  type Item = ListEndpointsResponse["items"][number];
  const items: Item[] = [];
  for (const row of (out.Items ?? []) as Partial<MicroserviceMigrationScoreItem>[]) {
    if (!row.slot || !row.registeredUrl || !row.registeredAt) continue;
    const item: Item = {
      slot: row.slot as MicroserviceMigrationSlot,
      registeredUrl: row.registeredUrl,
      registeredAt: row.registeredAt,
      ...(typeof row.platform === "string" ? { platform: row.platform } : {}),
      ...(row.lastResult ? { lastResult: row.lastResult } : {}),
      ...(typeof row.lastProbeAt === "string" ? { lastProbeAt: row.lastProbeAt } : {}),
      ...(typeof row.lastPoints === "number" ? { lastPoints: row.lastPoints } : {}),
      ...(typeof row.lastResponseTimeMs === "number"
        ? { lastResponseTimeMs: row.lastResponseTimeMs }
        : {}),
    };
    items.push(item);
  }

  return { items };
}
