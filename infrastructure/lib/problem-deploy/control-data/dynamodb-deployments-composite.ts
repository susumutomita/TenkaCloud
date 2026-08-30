import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { type DynamoDbDeploymentsCore, itemToRecord } from "./dynamodb-deployments-core.js";
import type {
  CompositeParentDeploymentRecord,
  CompositeTargetDeploymentRecord,
  DeploymentMutationOutcome,
  DeploymentRecord,
  DeploymentsCompositePort,
  DeploymentsRepository,
} from "./types.js";

/**
 * [#2527 Slice 3] DynamoDB {@link DeploymentsCompositePort} adapter — composite parent/target persistence, CAS, and composite reconciler scans,
 * moved verbatim from the pre-split `DynamoDbDeploymentsRepository`. Engine
 * primitives (keys, conditional writes, pagination) live on
 * {@link DynamoDbDeploymentsCore}.
 */
export class DynamoDbDeploymentsComposite implements DeploymentsCompositePort {
  constructor(private readonly core: DynamoDbDeploymentsCore) {}

  // -- GSI3: composite targets --------------------------------------------

  async listCompositeTargets(parentDeploymentId: string): Promise<readonly DeploymentRecord[]> {
    // Single page — verbatim `deploy-handler/composite-repository.ts`.
    const out = await this.core.ddb.send(
      new QueryCommand({
        TableName: this.core.tableName,
        IndexName: "GSI3",
        KeyConditionExpression: "GSI3PK = :pk",
        ExpressionAttributeValues: { ":pk": `PARENT_DEPLOYMENT#${parentDeploymentId}` },
        ScanIndexForward: true,
      }),
    );
    return (out.Items ?? []).map((item) => itemToRecord(item as Record<string, unknown>));
  }

  async forEachCompositeDeployReconcilablePage(
    onPage: (items: readonly DeploymentRecord[]) => Promise<void>,
  ): Promise<void> {
    await this.core.scanAllPages(
      {
        FilterExpression: "runtimeKind = :composite AND #s IN (:p, :i)",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":composite": "composite",
          ":p": "PENDING",
          ":i": "IN_PROGRESS",
        },
        Limit: 200,
      },
      async (items) => {
        await onPage(items.map(itemToRecord));
      },
    );
  }

  async forEachCompositeTeardownPendingPage(
    onPage: (items: readonly DeploymentRecord[]) => Promise<void>,
  ): Promise<void> {
    await this.core.scanAllPages(
      {
        FilterExpression: "runtimeKind = :composite AND #s = :deleting",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":composite": "composite", ":deleting": "DELETING" },
        Limit: 200,
      },
      async (items) => {
        await onPage(items.map(itemToRecord));
      },
    );
  }

  async failCompositeTargetIfPending(
    jobId: string,
    reason: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.conditionalUpdate(
      jobId,
      {
        UpdateExpression: "SET #s = :failed, failureReason = :reason, updatedAt = :now",
        ConditionExpression: "#s = :pending",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":failed": "FAILED",
          ":pending": "PENDING",
          ":reason": reason,
          ":now": at,
        },
      },
      "conflict",
    );
  }

  async markCompositeParentDeleting(jobId: string, at: string): Promise<DeploymentMutationOutcome> {
    return this.core.conditionalUpdate(
      jobId,
      {
        // [Issue #3128] Same permanent teardown marker the two other DELETING
        // transitions stamp. Leaving the composite parent out would reopen the
        // hole for exactly the rows a composite problem's teams own.
        UpdateExpression:
          "SET #s = :deleting, updatedAt = :now, teardownRequestedAt = if_not_exists(teardownRequestedAt, :now)",
        ConditionExpression: "runtimeKind = :composite AND #s <> :deleting",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":deleting": "DELETING",
          ":composite": "composite",
          ":now": at,
        },
      },
      "conflict",
    );
  }

  async putCompositeParent(
    record: CompositeParentDeploymentRecord,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.conditionalPut(record, { probeTenantId: record.tenantId });
  }

  async putCompositeTarget(
    record: CompositeTargetDeploymentRecord,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.conditionalPut(record, "conflict");
  }

  async casCompositeParentStatus(
    jobId: string,
    previousStatus: Parameters<DeploymentsRepository["casCompositeParentStatus"]>[1],
    nextStatus: Parameters<DeploymentsRepository["casCompositeParentStatus"]>[2],
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.conditionalUpdate(
      jobId,
      {
        UpdateExpression: "SET #s = :next, updatedAt = :now",
        ConditionExpression: "#s = :prev AND runtimeKind = :composite",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":next": nextStatus,
          ":prev": previousStatus,
          ":now": at,
          ":composite": "composite",
        },
      },
      "conflict",
    );
  }
}
