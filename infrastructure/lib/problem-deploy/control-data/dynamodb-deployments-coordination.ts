import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { CoordinationRunKey, CoordinationRunPointer } from "./domain/coordination-run.js";
import {
  assertConditionableVersion,
  type CoordinationStateScope,
  DEFAULT_COORDINATION_RUN_ID,
} from "./domain/coordination-scope.js";
import {
  COORD_RUN_SK,
  COORD_SECRET_SK,
  COORD_STATE_SK,
  coordinationPk,
  coordinationRunPk,
  type DynamoDbDeploymentsCore,
  isConditionalCheckFailed,
  preScopeCoordinationPk,
} from "./dynamodb-deployments-core.js";
import { sweepExpiredRows } from "./dynamodb-ttl-sweep.js";
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
 *
 * [Issue #3123] Every method now takes a whole {@link CoordinationStateScope};
 * the partition key carries problem and run, so two problems (or two runs)
 * inside one event no longer share a row.
 */
export class DynamoDbDeploymentsCoordination implements DeploymentsCoordinationPort {
  constructor(private readonly core: DynamoDbDeploymentsCore) {}

  // -- COORD#: coordination state -----------------------------------------

  async readCoordinationState(
    scope: CoordinationStateScope,
  ): Promise<CoordinationStateRecord | undefined> {
    const out = await this.core.ddb.send(
      new GetCommand({
        TableName: this.core.tableName,
        Key: { PK: coordinationPk(scope), SK: COORD_STATE_SK },
      }),
    );
    const item = out.Item as Record<string, unknown> | undefined;
    if (!item) return undefined;
    return {
      state: item.state,
      version: Number(item.version ?? 0),
      // Absent on a row written before the TTL existed; the tick treats that as
      // "refresh on sight", which is also how such a row acquires one. A
      // non-positive value is normalised to absent for the same reason the SQL
      // adapter does it: 0 is the schema default there, and on DynamoDB a TTL
      // of 0 is an epoch-1970 timestamp the table would treat as long expired.
      expiresAt:
        typeof item.expiresAt === "number" && item.expiresAt > 0 ? item.expiresAt : undefined,
    };
  }

  /**
   * [Issue #3123] See `DeploymentsCoordinationPort.touchCoordinationState`.
   *
   * `attribute_exists(version)` keeps this from creating a row: a namespace
   * that does not exist has nothing to keep alive, and conjuring an empty item
   * with only a TTL would leave a row no read can interpret. The
   * `ConditionalCheckFailed` that raises is folded to a no-op rather than
   * thrown — losing a race against a delete is the expected outcome here, not
   * an error.
   */
  async touchCoordinationState(scope: CoordinationStateScope, expiresAt: number): Promise<void> {
    try {
      await this.core.ddb.send(
        new UpdateCommand({
          TableName: this.core.tableName,
          Key: { PK: coordinationPk(scope), SK: COORD_STATE_SK },
          UpdateExpression: "SET expiresAt = :expiresAt",
          ConditionExpression: "attribute_exists(version)",
          ExpressionAttributeValues: { ":expiresAt": expiresAt },
        }),
      );
    } catch (err) {
      if (isConditionalCheckFailed(err)) return;
      throw err;
    }
  }

  /**
   * [Issue #2441 / Phase B3] Verbatim relocation of
   * `participant-handler/coordination-store.ts`'s optimistic-lock Put — the
   * `ConditionalCheckFailedException` catch folds into `{ outcome: "conflict" }`
   * instead of throwing (A2/B2 union contract). Never `not_found`: an absent
   * row is a valid target for the first write (`expectedVersion` 0).
   *
   * [Issue #3123] `expiresAt` rides the same Put so the row picks up the
   * deployments table's native TTL (`deployments-table.ts`
   * `timeToLiveAttribute: "expiresAt"`), letting an abandoned namespace drop on
   * its own even if no teardown ever deletes it.
   *
   * A write is not the only thing that pushes the deadline out, and must not
   * be: a plugin with no `tick` hook writes only when a participant acts, so in
   * an open-ended event a live match would age out under itself. The tick
   * refreshes the TTL through {@link touchCoordinationState}; see
   * `coordination-scope.ts` for why the clock is anchored to the event rather
   * than to the participants.
   */
  async writeCoordinationState(
    scope: CoordinationStateScope,
    state: unknown,
    expectedVersion: number,
    at: string,
    expiresAt: number,
  ): Promise<DeploymentMutationOutcome> {
    try {
      await this.core.ddb.send(
        new PutCommand({
          TableName: this.core.tableName,
          Item: {
            PK: coordinationPk(scope),
            SK: COORD_STATE_SK,
            state,
            version: expectedVersion + 1,
            updatedAt: at,
            expiresAt,
          },
          // [Issue #3126] The condition is split on `expectedVersion`, not the
          // permissive `attribute_not_exists(version) OR version = :expected`
          // it used to be. Only a first write (expectedVersion 0) may create the
          // row; a write carrying a version read earlier must match a row that
          // still exists.
          //
          // Without the split, a run reset races: an op reads state at version
          // 3, the operator resets (deleting the row), and the op's write then
          // satisfies `attribute_not_exists(version)` and resurrects the match
          // the reset just ended — with the reset still reporting success. Now
          // that write conflicts, the participant retries, and the retry
          // re-initializes cleanly from `plugin.initialState`.
          ...(expectedVersion === 0
            ? { ConditionExpression: "attribute_not_exists(version)" }
            : {
                ConditionExpression: "version = :expected",
                ExpressionAttributeValues: { ":expected": expectedVersion },
              }),
        }),
      );
      return { outcome: "updated" };
    } catch (err) {
      if (isConditionalCheckFailed(err)) return { outcome: "conflict" };
      throw err;
    }
  }

  /**
   * [Issue #3133] See `DeploymentsCoordinationPort.ensureCoordinationMatchSecret`.
   *
   * Read first, mint only when absent. Every op after the first is then one
   * Get and no write — minting unconditionally and letting the condition reject
   * it would put a doomed Put on the hot path of every single operation.
   *
   * `attribute_not_exists(matchSecret)` still guards the mint, because the read
   * is not a lock: two concurrent first ops can both see "absent". The
   * condition makes exactly one of them the writer, and the loser re-reads and
   * adopts the winner's value — both derive their hidden material from the same
   * secret, which is the property that matters. Without it the second write
   * would silently replace a secret the first op has already derived from.
   */
  async ensureCoordinationMatchSecret(
    scope: CoordinationStateScope,
    candidate: string,
    expiresAt: number,
  ): Promise<string> {
    const existing = await this.readCoordinationMatchSecret(scope);
    if (existing !== undefined) return existing;
    try {
      await this.core.ddb.send(
        new PutCommand({
          TableName: this.core.tableName,
          Item: {
            PK: coordinationPk(scope),
            SK: COORD_SECRET_SK,
            matchSecret: candidate,
            expiresAt,
          },
          ConditionExpression: "attribute_not_exists(matchSecret)",
        }),
      );
      return candidate;
    } catch (err) {
      if (!isConditionalCheckFailed(err)) throw err;
    }
    // Lost the mint race. Whatever the winner stored wins — returning
    // `candidate` here would hand this op a secret nothing else holds.
    const stored = await this.readCoordinationMatchSecret(scope);
    if (stored !== undefined) return stored;
    // The condition failed but nothing is readable: a teardown deleted the row
    // between the Put and the Get. Failing beats returning a secret that is not
    // the match's; the caller retries against the re-created match.
    throw new Error("coordination match secret vanished between write and read");
  }

  /** [Issue #3133] See `DeploymentsCoordinationPort.readCoordinationMatchSecret`. */
  async readCoordinationMatchSecret(scope: CoordinationStateScope): Promise<string | undefined> {
    const out = await this.core.ddb.send(
      new GetCommand({
        TableName: this.core.tableName,
        Key: { PK: coordinationPk(scope), SK: COORD_SECRET_SK },
      }),
    );
    const secret = (out.Item as Record<string, unknown> | undefined)?.matchSecret;
    return typeof secret === "string" && secret.length > 0 ? secret : undefined;
  }

  /**
   * [Issue #3123] Deletes this scope's row, plus the pre-scope
   * `COORD#<tenant>#<event>` row for the same event.
   *
   * The second delete is how an orphaned pre-#3123 row leaves the table: those
   * rows predate `expiresAt`, so DynamoDB's TTL will never reap them, and
   * nothing reads them any more. Both deletes are unconditional — DynamoDB
   * `DeleteItem` on an absent key succeeds — which is what makes a retried or
   * half-finished teardown converge instead of erroring.
   */
  async deleteCoordinationState(scope: CoordinationStateScope): Promise<void> {
    await this.core.ddb.send(
      new DeleteCommand({
        TableName: this.core.tableName,
        Key: { PK: coordinationPk(scope), SK: COORD_STATE_SK },
      }),
    );
    await this.core.ddb.send(
      new DeleteCommand({
        TableName: this.core.tableName,
        Key: { PK: preScopeCoordinationPk(scope.tenantId, scope.eventId), SK: COORD_STATE_SK },
      }),
    );
    // [Issue #3133] The secret goes with the match it belongs to. Leaving it
    // would let a re-created scope inherit the deleted match's hidden material.
    await this.core.ddb.send(
      new DeleteCommand({
        TableName: this.core.tableName,
        Key: { PK: coordinationPk(scope), SK: COORD_SECRET_SK },
      }),
    );
  }

  /**
   * [Issue #3149] See `DeploymentsCoordinationPort.deleteCoordinationStateIfUnchanged`.
   *
   * The condition is on the state row's `version`, so a match that was played
   * between the caller's read and this call keeps its row. The secret is
   * deleted only after the state delete has been accepted — on a conflict the
   * match is still live and still deriving from that secret, and removing it
   * would be worse than leaving the state behind, because the next
   * `ensureCoordinationMatchSecret` would mint a different one under a match
   * whose existing shares were derived from the old value.
   */
  async deleteCoordinationStateIfUnchanged(
    scope: CoordinationStateScope,
    expectedVersion: number,
  ): Promise<DeploymentMutationOutcome> {
    assertConditionableVersion(expectedVersion);
    try {
      await this.core.ddb.send(
        new DeleteCommand({
          TableName: this.core.tableName,
          Key: { PK: coordinationPk(scope), SK: COORD_STATE_SK },
          ConditionExpression: "version = :expected",
          ExpressionAttributeValues: { ":expected": expectedVersion },
        }),
      );
    } catch (err) {
      if (isConditionalCheckFailed(err)) return { outcome: "conflict" };
      throw err;
    }
    await this.core.ddb.send(
      new DeleteCommand({
        TableName: this.core.tableName,
        Key: { PK: coordinationPk(scope), SK: COORD_SECRET_SK },
      }),
    );
    return { outcome: "updated" };
  }

  // -- COORDRUN#: which run of a problem is current ------------------------

  /** [Issue #3153] See `DeploymentsCoordinationPort.readCoordinationRun`. */
  async readCoordinationRun(key: CoordinationRunKey): Promise<CoordinationRunPointer | undefined> {
    const out = await this.core.ddb.send(
      new GetCommand({
        TableName: this.core.tableName,
        Key: { PK: coordinationRunPk(key), SK: COORD_RUN_SK },
      }),
    );
    const item = out.Item as Record<string, unknown> | undefined;
    if (!item || typeof item.runId !== "string") return undefined;
    return {
      runId: item.runId,
      startedAt: String(item.startedAt ?? ""),
      history: Array.isArray(item.history)
        ? item.history.filter((entry): entry is string => typeof entry === "string")
        : [],
    };
  }

  /**
   * [Issue #3153] See `DeploymentsCoordinationPort.rotateCoordinationRun`.
   *
   * The condition splits on whether the caller expects the pre-pointer state.
   * Rotating away from {@link DEFAULT_COORDINATION_RUN_ID} has to accept both
   * "no row" and "a row still naming the default", because a match that has
   * never been reset can be in either: absent if nothing ever wrote a pointer,
   * present if something wrote one and then rotated back to nothing. Any other
   * expectation is an exact match on `runId`.
   */
  async rotateCoordinationRun(
    key: CoordinationRunKey,
    expectedRunId: string,
    pointer: CoordinationRunPointer,
    expiresAt: number,
  ): Promise<DeploymentMutationOutcome> {
    const fromInitial = expectedRunId === DEFAULT_COORDINATION_RUN_ID;
    try {
      await this.core.ddb.send(
        new PutCommand({
          TableName: this.core.tableName,
          Item: {
            PK: coordinationRunPk(key),
            SK: COORD_RUN_SK,
            runId: pointer.runId,
            startedAt: pointer.startedAt,
            history: [...pointer.history],
            expiresAt,
          },
          ConditionExpression: fromInitial
            ? "attribute_not_exists(runId) OR runId = :expected"
            : "runId = :expected",
          ExpressionAttributeValues: { ":expected": expectedRunId },
        }),
      );
      return { outcome: "updated" };
    } catch (err) {
      if (isConditionalCheckFailed(err)) return { outcome: "conflict" };
      throw err;
    }
  }

  /** [Issue #3153] See `DeploymentsCoordinationPort.deleteCoordinationRun`. */
  async deleteCoordinationRun(key: CoordinationRunKey): Promise<void> {
    await this.core.ddb.send(
      new DeleteCommand({
        TableName: this.core.tableName,
        Key: { PK: coordinationRunPk(key), SK: COORD_RUN_SK },
      }),
    );
  }

  /**
   * [Issue #3123] Duplicates what the table's native TTL already does, so the
   * SQLite backend (no native TTL) can reach the same end state through the
   * same port method. Filters on `begins_with(PK, "COORD#")` so it only ever
   * touches coordination rows — the deployments table holds several other PK
   * prefixes whose retention is not this port's business.
   */
  async sweepExpiredCoordinationState(nowEpochSeconds: number): Promise<number> {
    return sweepExpiredRows({
      ddb: this.core.ddb,
      tableName: this.core.tableName,
      nowEpochSeconds,
      filterExpression: "begins_with(PK, :coordPrefix) AND expiresAt > :zero AND expiresAt <= :now",
      expressionAttributeValues: { ":coordPrefix": "COORD#" },
    });
  }
}
