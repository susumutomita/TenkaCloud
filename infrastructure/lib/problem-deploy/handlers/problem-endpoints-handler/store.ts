import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { controlDataRuntime } from "../../control-data/runtime-repositories.js";
import type { ProblemEndpointRecord } from "../../control-data/types.js";

/**
 * [Issue #2442 / Phase C1] Domain shape of one (tenant, team, problem, slot)
 * override row. Re-exported under its pre-seam name (`EndpointOverrideItem`)
 * for the existing callers (`resolve.ts`) — the raw DDB access these three
 * functions used to perform inline now lives behind
 * {@link controlDataRuntime.resolveProblemEndpointsRepository}
 * ({@link DynamoDbProblemEndpointsRepository} / {@link SqlProblemEndpointsRepository}),
 * so this is the domain record (no physical PK/SK), not a raw DDB item.
 *
 * `defaultCacheUrl` は Phase 3.A 時点では未使用 (= read-through 算出)。Phase 3.B で
 * deploy 完了 hook が書き込む余地を残す。
 */
export type EndpointOverrideItem = ProblemEndpointRecord;

export interface PutOverrideArgs {
  tenantId: string;
  teamId: string;
  problemId: string;
  slot: string;
  overrideUrl: string;
  nowIso: string;
}

export async function putOverride(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  args: PutOverrideArgs,
): Promise<EndpointOverrideItem> {
  const record: ProblemEndpointRecord = {
    tenantId: args.tenantId,
    teamId: args.teamId,
    problemId: args.problemId,
    slot: args.slot,
    overrideUrl: args.overrideUrl,
    updatedAt: args.nowIso,
  };
  const repo = await controlDataRuntime.resolveProblemEndpointsRepository({
    ddb,
    endpointsTableName: tableName,
  });
  await repo.putOverride(record);
  return record;
}

export interface DeleteOverrideArgs {
  tenantId: string;
  teamId: string;
  problemId: string;
  slot: string;
}

export async function deleteOverride(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  args: DeleteOverrideArgs,
): Promise<void> {
  const repo = await controlDataRuntime.resolveProblemEndpointsRepository({
    ddb,
    endpointsTableName: tableName,
  });
  await repo.deleteOverride(args.tenantId, args.teamId, args.problemId, args.slot);
}

export async function queryOverrides(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  tenantId: string,
  teamId: string,
  problemId: string,
): Promise<EndpointOverrideItem[]> {
  const repo = await controlDataRuntime.resolveProblemEndpointsRepository({
    ddb,
    endpointsTableName: tableName,
  });
  return [...(await repo.queryOverrides(tenantId, teamId, problemId))];
}
