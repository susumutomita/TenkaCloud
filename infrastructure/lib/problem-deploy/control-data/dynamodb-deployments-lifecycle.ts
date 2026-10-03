import { PutCommand, type TransactWriteCommandInput, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { type DynamoDbDeploymentsCore, recordToItem } from "./dynamodb-deployments-core.js";
import type {
  BulkDeploymentCreateEntry,
  DeploymentMutationOutcome,
  DeploymentRecord,
  DeploymentSchedulePatch,
  DeploymentsLifecyclePort,
  DeploymentsRepository,
} from "./types.js";

/**
 * [#2527 Slice 3] DynamoDB {@link DeploymentsLifecyclePort} adapter — create / SFN status writebacks / retry-delete compensations / bulk / schedule,
 * moved verbatim from the pre-split `DynamoDbDeploymentsRepository`. Engine
 * primitives (keys, conditional writes, pagination) live on
 * {@link DynamoDbDeploymentsCore}.
 */
export class DynamoDbDeploymentsLifecycle implements DeploymentsLifecyclePort {
  constructor(private readonly core: DynamoDbDeploymentsCore) {}

  // -- Conditional / atomic writes ------------------------------------------

  async putDeployment(record: DeploymentRecord): Promise<void> {
    await this.core.ddb.send(
      new PutCommand({ TableName: this.core.tableName, Item: recordToItem(record) }),
    );
  }

  async markCreateInProgress(jobId: string, at: string): Promise<DeploymentMutationOutcome> {
    await this.core.ddb.send(
      new UpdateCommand({
        TableName: this.core.tableName,
        Key: this.core.deploymentKey(jobId),
        UpdateExpression: "SET #status = :status, updatedAt = :updatedAt",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": "IN_PROGRESS",
          ":updatedAt": at,
        },
      }),
    );
    return { outcome: "updated" };
  }

  async markCreateSucceeded(
    jobId: string,
    stackId: string,
    stackOutputs: string,
    buildId: string | undefined,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    // [Issue #2946] `completedAt` は `if_not_exists` で **一度だけ** 書く。CFn の再 reconcile
    // などでこの経路が再入しても最初の到達時刻が動かない。以後の teardown 遷移はこの属性に
    // 触れないので、撤去後も「一度は成功した」事実が残る。
    const updateExpression =
      "SET #status = :status, updatedAt = :updatedAt, stackId = :stackId, stackOutputs = :stackOutputs" +
      ", completedAt = if_not_exists(completedAt, :completedAt)" +
      (buildId !== undefined ? ", buildId = :buildId" : "");
    await this.core.ddb.send(
      new UpdateCommand({
        TableName: this.core.tableName,
        Key: this.core.deploymentKey(jobId),
        UpdateExpression: updateExpression,
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": "COMPLETE",
          ":updatedAt": at,
          ":stackId": stackId,
          ":stackOutputs": stackOutputs,
          ":completedAt": at,
          ...(buildId !== undefined ? { ":buildId": buildId } : {}),
        },
      }),
    );
    return { outcome: "updated" };
  }

  async markCreateFailed(
    jobId: string,
    failureReason: string,
    buildId: string | undefined,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    const updateExpression =
      "SET #status = :status, updatedAt = :updatedAt, #failureReason = :failureReason" +
      (buildId !== undefined ? ", buildId = :buildId" : "");
    await this.core.ddb.send(
      new UpdateCommand({
        TableName: this.core.tableName,
        Key: this.core.deploymentKey(jobId),
        UpdateExpression: updateExpression,
        ExpressionAttributeNames: {
          "#status": "status",
          "#failureReason": "failureReason",
        },
        ExpressionAttributeValues: {
          ":status": "FAILED",
          ":updatedAt": at,
          ":failureReason": failureReason,
          ...(buildId !== undefined ? { ":buildId": buildId } : {}),
        },
      }),
    );
    return { outcome: "updated" };
  }

  async markDeleted(jobId: string, at: string): Promise<DeploymentMutationOutcome> {
    await this.core.ddb.send(
      new UpdateCommand({
        TableName: this.core.tableName,
        Key: this.core.deploymentKey(jobId),
        UpdateExpression: "SET #status = :status, updatedAt = :updatedAt REMOVE GSI2PK, GSI2SK",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": "DELETED",
          ":updatedAt": at,
        },
      }),
    );
    return { outcome: "updated" };
  }

  async markFailedIfPending(
    jobId: string,
    tenantId: string,
    reason: string,
    at: string,
    expiresAt: number,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.conditionalUpdate(
      jobId,
      {
        UpdateExpression:
          "SET #s = :failed, updatedAt = :updatedAt, failureReason = :reason, expiresAt = :expiresAt",
        ConditionExpression: "tenantId = :tenantId AND #s = :pending",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":failed": "FAILED",
          ":pending": "PENDING",
          ":updatedAt": at,
          ":reason": reason,
          ":tenantId": tenantId,
          ":expiresAt": expiresAt,
        },
      },
      "conflict",
    );
  }

  async retryToPending(
    jobId: string,
    tenantId: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.conditionalUpdate(
      jobId,
      {
        UpdateExpression: "SET #s = :pending, updatedAt = :updatedAt REMOVE failureReason",
        ConditionExpression: "#s = :failed AND tenantId = :tenantId",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":pending": "PENDING",
          ":failed": "FAILED",
          ":updatedAt": at,
          ":tenantId": tenantId,
        },
      },
      "conflict",
    );
  }

  async compensateRetryToFailed(
    jobId: string,
    tenantId: string,
    reason: string,
    at: string,
    expiresAt: number,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.conditionalUpdate(
      jobId,
      {
        UpdateExpression:
          "SET #s = :failed, updatedAt = :updatedAt, failureReason = :reason, expiresAt = :expiresAt",
        ConditionExpression: "#s = :pending AND tenantId = :tenantId",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":failed": "FAILED",
          ":pending": "PENDING",
          ":updatedAt": at,
          ":reason": reason,
          ":tenantId": tenantId,
          ":expiresAt": expiresAt,
        },
      },
      "conflict",
    );
  }

  async markDeleting(
    jobId: string,
    tenantId: string,
    at: string,
    expiresAt: number,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.conditionalUpdate(
      jobId,
      {
        // [Issue #3128] `teardownRequestedAt` is a permanent marker, written once
        // (`if_not_exists`) the way `completedAt` is: a row that went DELETING
        // can still land on FAILED afterwards (the delete state machine's
        // `DELETE_FAILED` route calls `markFailed`), and FAILED is
        // indistinguishable from a failed DEPLOY. Status alone therefore cannot
        // answer "was this torn down", which is what the coordination guard
        // needs to know.
        UpdateExpression:
          "SET #s = :deleting, updatedAt = :updatedAt, expiresAt = :expiresAt, teardownRequestedAt = if_not_exists(teardownRequestedAt, :updatedAt)",
        ConditionExpression: "tenantId = :tenantId AND #s IN (:p, :ap, :i, :c, :f)",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":deleting": "DELETING",
          ":updatedAt": at,
          ":tenantId": tenantId,
          ":p": "PENDING",
          ":ap": "APPROVAL_PENDING",
          ":i": "IN_PROGRESS",
          ":c": "COMPLETE",
          ":f": "FAILED",
          ":expiresAt": expiresAt,
        },
      },
      "conflict",
    );
  }

  async compensateDeleteToFailed(
    jobId: string,
    tenantId: string,
    reason: string,
    at: string,
    expiresAt: number,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.conditionalUpdate(
      jobId,
      {
        UpdateExpression:
          "SET #s = :failed, updatedAt = :updatedAt, failureReason = :reason, expiresAt = :expiresAt",
        ConditionExpression: "tenantId = :tenantId AND #s = :deleting",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":failed": "FAILED",
          ":deleting": "DELETING",
          ":updatedAt": at,
          ":reason": reason,
          ":tenantId": tenantId,
          ":expiresAt": expiresAt,
        },
      },
      "conflict",
    );
  }

  async markApprovalPending(
    jobId: string,
    tenantId: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.conditionalUpdate(
      jobId,
      {
        UpdateExpression: "SET #s = :approvalPending, updatedAt = :updatedAt",
        ConditionExpression: "tenantId = :tenantId AND #s = :pending",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":approvalPending": "APPROVAL_PENDING",
          ":pending": "PENDING",
          ":updatedAt": at,
          ":tenantId": tenantId,
        },
      },
      "conflict",
    );
  }

  async markStuckDeletingFailed(
    jobId: string,
    reason: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.conditionalUpdate(
      jobId,
      {
        UpdateExpression:
          "SET #status = :failed, updatedAt = :now, #reason = :reason REMOVE GSI2PK, GSI2SK",
        ConditionExpression: "#status = :deleting",
        ExpressionAttributeNames: { "#status": "status", "#reason": "failureReason" },
        ExpressionAttributeValues: {
          ":deleting": "DELETING",
          ":failed": "FAILED",
          ":now": at,
          ":reason": reason,
        },
      },
      "conflict",
    );
  }

  async markStuckCreatingFailed(
    jobId: string,
    reason: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.conditionalUpdate(
      jobId,
      {
        UpdateExpression: "SET #status = :failed, updatedAt = :now, #reason = :reason",
        ConditionExpression: "#status IN (:pending, :inProgress)",
        ExpressionAttributeNames: { "#status": "status", "#reason": "failureReason" },
        ExpressionAttributeValues: {
          ":pending": "PENDING",
          ":inProgress": "IN_PROGRESS",
          ":failed": "FAILED",
          ":now": at,
          ":reason": reason,
        },
      },
      "conflict",
    );
  }

  async transitionRuntimeStatus(
    jobId: string,
    tenantId: string,
    currentStatus: Parameters<DeploymentsRepository["transitionRuntimeStatus"]>[2],
    nextStatus: Parameters<DeploymentsRepository["transitionRuntimeStatus"]>[3],
    stackOutputs: string | undefined,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    const sets = ["#s = :next", "updatedAt = :now"];
    const values: Record<string, unknown> = {
      ":next": nextStatus,
      ":now": at,
      ":cur": currentStatus,
      ":tenant": tenantId,
    };
    if (stackOutputs !== undefined) {
      sets.push("stackOutputs = :outputs");
      values[":outputs"] = stackOutputs;
    }
    return this.core.conditionalUpdate(
      jobId,
      {
        UpdateExpression: `SET ${sets.join(", ")}`,
        ConditionExpression: "tenantId = :tenant AND #s = :cur",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: values,
      },
      "conflict",
    );
  }

  async compensateBulkTeardown(
    jobId: string,
    tenantId: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.conditionalUpdate(
      jobId,
      {
        UpdateExpression: "SET #s = :failed, updatedAt = :updatedAt, failureReason = :reason",
        ConditionExpression: "tenantId = :tenantId AND #s = :deleting",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":failed": "FAILED",
          ":deleting": "DELETING",
          ":updatedAt": at,
          ":reason": "Failed to publish DeployDeleteRequested event (bulk teardown)",
          ":tenantId": tenantId,
        },
      },
      "conflict",
    );
  }

  async markDeletingForBulk(
    jobId: string,
    tenantId: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.conditionalUpdate(
      jobId,
      {
        // [Issue #3128] Same permanent teardown marker as `markDeleting`.
        UpdateExpression:
          "SET #s = :deleting, updatedAt = :updatedAt, teardownRequestedAt = if_not_exists(teardownRequestedAt, :updatedAt)",
        ConditionExpression: "tenantId = :tenantId AND #s IN (:p, :ap, :i, :c, :f)",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":deleting": "DELETING",
          ":updatedAt": at,
          ":tenantId": tenantId,
          ":p": "PENDING",
          ":ap": "APPROVAL_PENDING",
          ":i": "IN_PROGRESS",
          ":c": "COMPLETE",
          ":f": "FAILED",
        },
      },
      "conflict",
    );
  }

  async applySchedulePatch(
    jobId: string,
    tenantId: string,
    patch: DeploymentSchedulePatch,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    const deploymentParts = ["updatedAt = :now"];
    const deploymentValues: Record<string, string> = { ":now": at, ":tenantId": tenantId };
    if (patch.startsAt !== undefined) {
      deploymentParts.push("eventStartsAt = :s");
      deploymentValues[":s"] = patch.startsAt;
    }
    if (patch.endsAt !== undefined) {
      deploymentParts.push("eventEndsAt = :e");
      deploymentValues[":e"] = patch.endsAt;
    }
    return this.core.conditionalUpdate(
      jobId,
      {
        UpdateExpression: `SET ${deploymentParts.join(", ")}`,
        ConditionExpression: "tenantId = :tenantId",
        ExpressionAttributeValues: deploymentValues,
      },
      "not_found",
    );
  }

  async createBulkDeployments(
    tenantId: string,
    entries: readonly BulkDeploymentCreateEntry[],
  ): Promise<DeploymentMutationOutcome> {
    if (entries.length === 0) return { outcome: "updated" };
    const transactItems: TransactWriteCommandInput["TransactItems"] = [];
    for (const entry of entries) {
      transactItems.push({
        Put: {
          TableName: this.core.tableName,
          Item: recordToItem(entry.record),
          ConditionExpression: "attribute_not_exists(PK)",
        },
      });
      if (entry.replacesJobId) {
        transactItems.push({
          Delete: {
            TableName: this.core.tableName,
            Key: this.core.deploymentKey(entry.replacesJobId),
            ConditionExpression: "tenantId = :tenantId",
            ExpressionAttributeValues: { ":tenantId": tenantId },
          },
        });
      }
    }
    return this.core.transactWrite({ TransactItems: transactItems });
  }

  async compensateBulkCreateToFailed(
    jobId: string,
    tenantId: string,
    reason: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.conditionalUpdate(
      jobId,
      {
        UpdateExpression: "SET #s = :failed, updatedAt = :updatedAt, failureReason = :reason",
        ConditionExpression: "tenantId = :tenantId AND #s = :pending",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":failed": "FAILED",
          ":pending": "PENDING",
          ":tenantId": tenantId,
          ":updatedAt": at,
          ":reason": reason,
        },
      },
      "conflict",
    );
  }

  async stampEventEndsAt(
    jobId: string,
    tenantId: string,
    endsAt: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.conditionalUpdate(
      jobId,
      {
        UpdateExpression: "SET eventEndsAt = :e, updatedAt = :now",
        ConditionExpression: "tenantId = :tenantId",
        ExpressionAttributeValues: { ":e": endsAt, ":now": at, ":tenantId": tenantId },
      },
      "not_found",
    );
  }
}
