import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DeploymentsRepository } from "../../control-data/deployments-repository.js";
import type { DisruptionsRepository } from "../../control-data/disruptions-repository.js";
import { controlDataRuntime } from "../../control-data/runtime-repositories.js";

export interface DisruptionExecutorDeploymentsSharedResources {
  readonly ddb: Pick<DynamoDBDocumentClient, "send">;
  readonly deploymentsTableName: string;
}

/**
 * [Issue #2441 / Phase B1] Deployments READ seam for disruption-executor modules.
 *
 * Default backend stays DynamoDB and emits the same GSI1 read through the same
 * injected DocumentClient. `CONTROL_DATA_BACKEND=turso/sql` is the known B4
 * constraint: the control-data factory fails loudly until the SQL Deployments
 * backend exists.
 *
 * [#2467-era runtime] Delegates to the cold-start-cached `controlDataRuntime`,
 * so `Promise<DeploymentsRepository>` — caller must await before use.
 */
export function resolveDeploymentsRepository(
  shared: DisruptionExecutorDeploymentsSharedResources,
): Promise<DeploymentsRepository> {
  return controlDataRuntime.resolveDeploymentsRepository({
    ddb: shared.ddb as DynamoDBDocumentClient,
    deploymentsTableName: shared.deploymentsTableName,
  });
}

export interface DisruptionExecutorDisruptionsSharedResources {
  readonly ddb: Pick<DynamoDBDocumentClient, "send">;
  readonly disruptionsTableName: string;
}

/**
 * [Issue #2442 / Phase C3] Disruptions seam for disruption-executor modules (mirror of
 * {@link resolveDeploymentsRepository}). Default backend stays DynamoDB and emits the same
 * conditional PutItem (`EXEC#` claim) through the same injected DocumentClient — byte-identical
 * to the pre-seam inline access. Delegates to the cold-start-cached `controlDataRuntime`, so
 * `CONTROL_DATA_BACKEND=turso|sql|turso-mirror|sql-mirror` all work.
 */
export function resolveDisruptionsRepository(
  shared: DisruptionExecutorDisruptionsSharedResources,
): Promise<DisruptionsRepository> {
  return controlDataRuntime.resolveDisruptionsRepository({
    ddb: shared.ddb as DynamoDBDocumentClient,
    disruptionsTableName: shared.disruptionsTableName,
  });
}
