import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { buildScoreEventItem } from "../handlers/shared/score-event.js";
import {
  type DynamoDbDeploymentsCore,
  deploymentPk,
  EVENT_SK_PREFIX,
  INBOX_SK_PREFIX,
  itemToInboxEvent,
  itemToScoreEvent,
} from "./dynamodb-deployments-core.js";
import type {
  DeploymentKindScoringResult,
  DeploymentMutationOutcome,
  DeploymentRecord,
  DeploymentsRepository,
  DeploymentsScoringPort,
  InboxEventRecord,
  ScoreEventRecord,
} from "./types.js";

/**
 * [#2527 Slice 3] DynamoDB {@link DeploymentsScoringPort} adapter — score mutations plus the score-event and inbox sub-aggregates,
 * moved verbatim from the pre-split `DynamoDbDeploymentsRepository`. Engine
 * primitives (keys, conditional writes, pagination) live on
 * {@link DynamoDbDeploymentsCore}.
 */
export class DynamoDbDeploymentsScoring implements DeploymentsScoringPort {
  constructor(private readonly core: DynamoDbDeploymentsCore) {}

  // -- Base partition: sparse sub-aggregates -------------------------------

  async listScoreEvents(
    jobId: string,
    opts: { readonly pageSize: number; readonly maxPages?: number },
  ): Promise<readonly ScoreEventRecord[]> {
    const items = await this.core.queryAllPages(
      {
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :evpfx)",
        ExpressionAttributeValues: { ":pk": deploymentPk(jobId), ":evpfx": EVENT_SK_PREFIX },
        ScanIndexForward: false,
        Limit: opts.pageSize,
      },
      opts.maxPages,
    );
    return items.map(itemToScoreEvent);
  }

  async listScoreEventsInRange(
    jobId: string,
    fromSk: string,
    toSk: string,
  ): Promise<readonly ScoreEventRecord[]> {
    const items = await this.core.queryRange(jobId, fromSk, toSk);
    return items.map(itemToScoreEvent);
  }

  async listInboxEventsInRange(
    jobId: string,
    fromSk: string,
    toSk: string,
  ): Promise<readonly InboxEventRecord[]> {
    const items = await this.core.queryRange(jobId, fromSk, toSk);
    return items.map(itemToInboxEvent);
  }

  async applyMultiFlagCorrectScore(
    jobId: string,
    points: number,
    flagId: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.conditionalUpdate(
      jobId,
      {
        UpdateExpression:
          "ADD score :pts, solvedFlagIds :flagIdSet SET lastScoredAt = :now, updatedAt = :now",
        ConditionExpression:
          "attribute_not_exists(solvedFlagIds) OR NOT contains(solvedFlagIds, :flagId)",
        ExpressionAttributeValues: {
          ":pts": points,
          ":flagIdSet": new Set([flagId]),
          ":flagId": flagId,
          ":now": at,
        },
        ReturnValues: "ALL_NEW",
      },
      "conflict",
    );
  }

  async applyMultiFlagWrongPenalty(
    jobId: string,
    penalty: number,
    flagId: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.conditionalUpdate(
      jobId,
      {
        UpdateExpression: "ADD wrongAnswerCount :one, score :neg SET updatedAt = :now",
        ConditionExpression:
          "attribute_not_exists(solvedFlagIds) OR NOT contains(solvedFlagIds, :flagId)",
        ExpressionAttributeValues: {
          ":one": 1,
          ":neg": -penalty,
          ":flagId": flagId,
          ":now": at,
        },
        ReturnValues: "ALL_NEW",
      },
      "conflict",
    );
  }

  async applyFlagWrongPenalty(
    jobId: string,
    penalty: number,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.conditionalUpdate(
      jobId,
      {
        UpdateExpression: "ADD wrongAnswerCount :one, score :neg SET updatedAt = :now",
        ConditionExpression: "attribute_not_exists(flagSubmitted) OR flagSubmitted = :false",
        ExpressionAttributeValues: { ":one": 1, ":neg": -penalty, ":false": false, ":now": at },
        ReturnValues: "ALL_NEW",
      },
      "conflict",
    );
  }

  async applyFlagCorrectScore(
    jobId: string,
    points: number,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.conditionalUpdate(
      jobId,
      {
        UpdateExpression:
          "ADD score :pts SET flagSubmitted = :true, lastScoredAt = :now, updatedAt = :now",
        ConditionExpression: "attribute_not_exists(flagSubmitted) OR flagSubmitted = :false",
        ExpressionAttributeValues: {
          ":pts": points,
          ":true": true,
          ":false": false,
          ":now": at,
        },
        ReturnValues: "ALL_NEW",
      },
      "conflict",
    );
  }

  async applyHintPenalty(
    jobId: string,
    hint: Parameters<DeploymentsRepository["applyHintPenalty"]>[1],
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.conditionalUpdate(
      jobId,
      {
        UpdateExpression:
          "SET hintsRevealed = list_append(if_not_exists(hintsRevealed, :empty), :record), updatedAt = :now " +
          "ADD score :neg",
        ConditionExpression:
          "attribute_not_exists(hintsRevealed) OR NOT contains(hintsRevealed, :recordForContains)",
        ExpressionAttributeValues: {
          ":empty": [],
          ":record": [hint],
          ":recordForContains": hint,
          ":now": at,
          ":neg": hint.penaltyApplied === 0 ? 0 : -hint.penaltyApplied,
        },
        ReturnValues: "ALL_NEW",
      },
      "conflict",
    );
  }

  async updateDisplayTeamName(
    jobId: string,
    name: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.conditionalUpdate(
      jobId,
      {
        UpdateExpression: "SET displayTeamName = :name, updatedAt = :now",
        ExpressionAttributeValues: { ":name": name, ":now": at },
        ReturnValues: "ALL_NEW",
      },
      "conflict",
    );
  }

  async applyKindScoringResult(
    jobId: string,
    result: DeploymentKindScoringResult,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    const setParts: string[] = ["lastScoredAt = :now", "updatedAt = :now"];
    const values: Record<string, unknown> = { ":now": at };
    const addScore = result.scoreDelta !== 0 ? "ADD score :pts " : "";
    if (result.scoreDelta !== 0) values[":pts"] = result.scoreDelta;
    if (result.lastResult) {
      setParts.push("lastResult = :lr");
      values[":lr"] = result.lastResult;
    }
    if (result.endpointsHealthJson !== undefined) {
      setParts.push("endpointsHealth = :health");
      values[":health"] = result.endpointsHealthJson;
    }
    if (result.attackProbesJson !== undefined) {
      setParts.push("attackProbes = :attackProbes");
      values[":attackProbes"] = result.attackProbesJson;
    }
    if (result.postureJson !== undefined) {
      setParts.push("posture = :posture");
      values[":posture"] = result.postureJson;
    }
    if (result.platform !== undefined) {
      setParts.push("platform = :platform");
      values[":platform"] = result.platform;
    }
    if (result.newState !== undefined) {
      setParts.push("scoringState = :state");
      values[":state"] = JSON.stringify(result.newState);
    }
    return this.core.conditionalUpdate(
      jobId,
      {
        UpdateExpression: `${addScore}SET ${setParts.join(", ")}`,
        ExpressionAttributeValues: values,
      },
      "conflict",
    );
  }

  async latchGateCompleted(jobId: string, at: string): Promise<DeploymentMutationOutcome> {
    return this.core.conditionalUpdate(
      jobId,
      {
        UpdateExpression: "SET gateCompletedAt = :now, updatedAt = :now",
        ConditionExpression: "attribute_not_exists(gateCompletedAt)",
        ExpressionAttributeValues: { ":now": at },
      },
      "conflict",
    );
  }

  async awardGateBonusAtomic(
    parent: Pick<DeploymentRecord, "jobId" | "problemId" | "teamId" | "eventId" | "expiresAt">,
    bonus: number,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    const scoreEvent = buildScoreEventItem(parent, "gate-bonus", bonus, at);
    return this.core.transactWrite({
      TransactItems: [
        {
          Update: {
            TableName: this.core.tableName,
            Key: this.core.deploymentKey(parent.jobId),
            UpdateExpression: "ADD score :bonus SET gateBonusAwardedAt = :now, updatedAt = :now",
            ConditionExpression: "attribute_not_exists(gateBonusAwardedAt)",
            ExpressionAttributeValues: { ":bonus": bonus, ":now": at },
          },
        },
        { Put: { TableName: this.core.tableName, Item: scoreEvent } },
      ],
    });
  }

  async setScoringState(
    jobId: string,
    stateJson: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.conditionalUpdate(
      jobId,
      {
        UpdateExpression: "SET scoringState = :state, updatedAt = :now",
        ExpressionAttributeValues: { ":state": stateJson, ":now": at },
      },
      "conflict",
    );
  }

  // -- Sub-aggregate writes (verbatim Puts) ----------------------------------

  /**
   * [Issue #2441 / Phase B3] The physical SK (`EVENT#<occurredAt>#<ulid>`) is
   * derived here, not by the caller — mirrors `handlers/shared/score-event.ts`
   * `buildScoreEventItem`'s SK construction, minus the PK/SK the domain
   * `ScoreEventRecord` never carries.
   */
  async appendScoreEvent(record: ScoreEventRecord): Promise<void> {
    await this.core.ddb.send(
      new PutCommand({
        TableName: this.core.tableName,
        Item: {
          PK: deploymentPk(record.jobId),
          SK: `${EVENT_SK_PREFIX}${record.occurredAt}#${ulid()}`,
          ...record,
        },
      }),
    );
  }

  /**
   * [Issue #2441 / Phase B3] `jobId` is the recipient (target) deployment, not
   * part of `InboxEventRecord` — mirrors `participant-handler/cast-event.ts`
   * `castEvent`'s Put, which addresses the target's partition. `inboxId` is
   * generated by the caller (it round-trips into the domain-visible
   * `CastEventOutcome`), so it is a parameter rather than derived here.
   */
  async appendInboxEvent(jobId: string, inboxId: string, record: InboxEventRecord): Promise<void> {
    await this.core.ddb.send(
      new PutCommand({
        TableName: this.core.tableName,
        Item: {
          PK: deploymentPk(jobId),
          SK: `${INBOX_SK_PREFIX}${record.occurredAt}#${inboxId}`,
          eventId: record.eventId,
          fromTeamId: record.fromTeamId,
          fromJobId: record.fromJobId,
          kind: record.kind,
          payload: record.payload ?? {},
          occurredAt: record.occurredAt,
          ttl: record.ttl,
        },
      }),
    );
  }
}
