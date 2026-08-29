import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  COORD_STATE_SK,
  coordinationPk,
  type DynamoDbDeploymentsCore,
  isConditionalCheckFailed,
} from "./dynamodb-deployments-core.js";
import type {
  CoordinationStateRecord,
  DeploymentMutationOutcome,
  DeploymentsCoordinationPort,
} from "./types.js";

/**
 * [#2527 Slice 3] DynamoDB {@link DeploymentsCoordinationPort} adapter — optimistic-lock coordination plugin state,
 * moved verbatim from the pre-split `DynamoDbDeploymentsRepository`. Engine
 * primitives (keys, conditional writes, pagination) live on
 * {@link DynamoDbDeploymentsCore}.
 */
export class DynamoDbDeploymentsCoordination implements DeploymentsCoordinationPort {
  constructor(private readonly core: DynamoDbDeploymentsCore) {}

  // -- COORD#: coordination state -----------------------------------------

  async readCoordinationState(
    tenantId: string,
    eventId: string,
    problemId = "legacy",
    runId = "legacy",
  ): Promise<CoordinationStateRecord | undefined> {
    const out = await this.core.ddb.send(
      new GetCommand({
        TableName: this.core.tableName,
        Key: { PK: coordinationPk(tenantId, eventId, problemId, runId), SK: COORD_STATE_SK },
      }),
    );
    const item = out.Item as Record<string, unknown> | undefined;
    if (!item) return undefined;
    return { state: item.state, version: Number(item.version ?? 0) };
  }

  /**
   * [Issue #2441 / Phase B3] Verbatim relocation of
   * `participant-handler/coordination-store.ts`'s optimistic-lock Put — the
   * `ConditionalCheckFailedException` catch folds into `{ outcome: "conflict" }`
   * instead of throwing (A2/B2 union contract). Never `not_found`: an absent
   * row is a valid target for the first write (`expectedVersion` 0).
   */
  async writeCoordinationState(
    tenantId: string,
    eventId: string,
    state: unknown,
    expectedVersion: number,
    at: string,
    problemId = "legacy",
    runId = "legacy",
  ): Promise<DeploymentMutationOutcome> {
    try {
      await this.core.ddb.send(
        new PutCommand({
          TableName: this.core.tableName,
          Item: {
            PK: coordinationPk(tenantId, eventId, problemId, runId),
            SK: COORD_STATE_SK,
            state,
            version: expectedVersion + 1,
            updatedAt: at,
          },
          ConditionExpression: "attribute_not_exists(version) OR version = :expected",
          ExpressionAttributeValues: { ":expected": expectedVersion },
        }),
      );
      return { outcome: "updated" };
    } catch (err) {
      if (isConditionalCheckFailed(err)) return { outcome: "conflict" };
      throw err;
    }
  }

  async deleteCoordinationState(
    tenantId: string,
    eventId: string,
    problemId: string,
    runId: string,
  ): Promise<void> {
    await this.core.ddb.send(
      new DeleteCommand({
        TableName: this.core.tableName,
        Key: { PK: coordinationPk(tenantId, eventId, problemId, runId), SK: COORD_STATE_SK },
      }),
    );
  }
}
