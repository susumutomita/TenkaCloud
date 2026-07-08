import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DeploymentsRepository } from "../../control-data/deployments-repository.js";
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
