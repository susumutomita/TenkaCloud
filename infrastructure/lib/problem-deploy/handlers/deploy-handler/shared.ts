import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DeploymentsRepository } from "../../control-data/deployments-repository.js";
import type { IdempotencyPort } from "../../control-data/idempotency-repository.js";
import type { ControlDataRuntime } from "../../control-data/runtime-repositories.js";

export interface DeploymentsTableSharedResources {
  /** [#2527 Slice 4] Injected control-data runtime (from the Lambda entrypoint's instance). */
  readonly runtime: ControlDataRuntime;
  readonly ddb: Pick<DynamoDBDocumentClient, "send">;
  readonly tableName: string;
}

/**
 * [Issue #2441 / Phase B1] Deployments READ seam for deploy-handler modules.
 *
 * Default backend stays DynamoDB and emits the same Get/Query requests through
 * the same injected DocumentClient. `CONTROL_DATA_BACKEND=turso` is the
 * known B4 constraint: the control-data factory fails loudly until the SQL
 * Deployments backend exists.
 *
 * [#2467-era runtime] Delegates to the cold-start-cached injected `shared.runtime`,
 * so `Promise<DeploymentsRepository>` — caller must await before use.
 */
export function resolveDeploymentsRepository(
  shared: DeploymentsTableSharedResources,
): Promise<DeploymentsRepository> {
  return shared.runtime.resolveDeploymentsRepository({
    ddb: shared.ddb as DynamoDBDocumentClient,
    deploymentsTableName: shared.tableName,
  });
}

/**
 * [Issue #3002] Idempotency seam。 `resolveDeploymentsRepository` と同じ二分岐で、
 * DynamoDB backend でも Turso backend でも同じ port が返る。
 *
 * `/deploy` は両 backend で動くため、 ここが片方だけだと Turso の環境が黙って無防備になる
 * (= 二重デプロイが防げているように見えて防げていない)。
 */
export function resolveIdempotencyRepository(
  shared: DeploymentsTableSharedResources,
): Promise<IdempotencyPort> {
  return shared.runtime.resolveIdempotencyRepository({
    ddb: shared.ddb as DynamoDBDocumentClient,
    deploymentsTableName: shared.tableName,
  });
}
