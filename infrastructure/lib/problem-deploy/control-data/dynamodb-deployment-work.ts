import { randomInt } from "node:crypto";
import {
  type DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import {
  closingEventGuard,
  connectionGuard,
  connectionKey,
  connectionSchema,
  creationKey,
  creationSchema,
  dispatchKey,
  eventGuard,
  indexedJob,
  jobKey,
  jobSchema,
  receiptKey,
  receiptSchema,
  scoreKey,
  targetKey,
  teamGuard,
  teardownDispatchKey,
  teardownKey,
  teardownSchema,
  type Write,
} from "./deployment-storage.js";
import {
  type AcceptDeployment,
  type CreationReservation,
  contentDigest,
  DeploymentConflict,
  type DeploymentConnection,
  type DeploymentIdentity,
  type DeploymentJob,
  type DispatchIntent,
  deploymentStackName,
  type FlagOutcome,
  type FlagRequest,
  flagMatchesDigest,
  scoringBlock,
  type TeardownRecord,
} from "./domain/deployment-work.js";
import type { EventRecord } from "./domain/events.js";
import type { TeamRecord } from "./domain/teams.js";
import { type CloudTableNames, conflict, eventKey } from "./dynamodb-cloud-repository.js";
import { registeredAccountGuard } from "./dynamodb-competitor-accounts-repository.js";
import { installationControlKey, installationIntakeGuard } from "./installation-control.js";

function parseDispatchIntent(row: unknown, deletesOnly: boolean): DispatchIntent {
  const intent = z
    .object({
      eventId: z.string(),
      teamId: z.string(),
      jobId: z.string(),
      attempt: z.number().int().positive(),
      operation: z.literal("delete").optional(),
      generation: z.number().int().positive().optional(),
      createdAt: z.string(),
    })
    .parse(row);
  if (deletesOnly && intent.operation !== "delete")
    throw new Error("Unexpected creation in closed-installation dispatch");
  return intent;
}

interface Accepted {
  readonly kind: "accepted" | "replay";
  readonly jobId: string;
  readonly attempt: number;
}
export interface DeploymentCompletion {
  readonly status: "COMPLETE" | "FAILED";
  readonly stackId?: string;
  readonly flagDigest?: string;
  readonly publicOutputs?: Readonly<Record<string, string>>;
  readonly failureReason?: string;
}
interface TeardownCompletion {
  readonly status: "DELETED" | "FAILED";
  readonly failureReason?: string;
  readonly stackId?: string;
}
const acceptedSchema = z.object({ jobId: z.string(), attempt: z.number() });
const flagOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ok"), scoreDelta: z.number(), totalScore: z.number() }),
  z.object({ kind: z.literal("wrong"), scoreDelta: z.number(), totalScore: z.number() }),
  z.object({ kind: z.literal("already_scored"), totalScore: z.number() }),
]);
/** Async historical DEPLOYMENT#/META and EVENT# ledger, fenced across Lambda invocations. */
export class DynamoDeploymentWork {
  constructor(
    private readonly ddb: DynamoDBDocumentClient,
    private readonly tables: CloudTableNames,
  ) {}
  private async read(
    table: string,
    key: Record<string, string>,
  ): Promise<Record<string, unknown> | undefined> {
    return (
      await this.ddb.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }))
    ).Item;
  }
  private async commit(writes: Write[]): Promise<boolean> {
    try {
      await this.ddb.send(new TransactWriteCommand({ TransactItems: writes }));
      return true;
    } catch (error) {
      if (conflict(error)) return false;
      throw error;
    }
  }
  async closeEvent(
    event: import("./domain/events.js").EventRecord,
    at: string,
  ): Promise<"closing" | "archived"> {
    if (event.status === "ARCHIVED") return "archived";
    if (event.status === "TEARDOWN") return "closing";
    const closed = await this.commit([
      {
        Update: {
          TableName: this.tables.events,
          Key: eventKey(event.eventId),
          UpdateExpression:
            "SET #status = :closing, updatedAt = :at, scoringLocked = :yes, teardownCompleted = if_not_exists(teardownCompleted, :zero)",
          ConditionExpression: "updatedAt = :previous AND #status <> :archived",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":closing": "TEARDOWN",
            ":archived": "ARCHIVED",
            ":at": at,
            ":previous": event.updatedAt,
            ":yes": true,
            ":zero": 0,
          },
        },
      },
    ]);
    if (closed) return "closing";
    const current = await this.read(this.tables.events, eventKey(event.eventId));
    if (current?.status === "TEARDOWN") return "closing";
    if (current?.status === "ARCHIVED") return "archived";
    throw new DeploymentConflict("event_teardown_conflict");
  }
  async setTeardownExpected(eventId: string, count: number): Promise<void> {
    if (!Number.isInteger(count) || count < 0 || count > 2450)
      throw new Error("Invalid teardown target count.");
    if (
      await this.commit([
        {
          Update: {
            TableName: this.tables.events,
            Key: eventKey(eventId),
            UpdateExpression:
              "SET teardownExpected = :count, teardownCompleted = if_not_exists(teardownCompleted, :zero)",
            ConditionExpression:
              "#status = :closing AND (attribute_not_exists(teardownExpected) OR teardownExpected = :count)",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: { ":closing": "TEARDOWN", ":count": count, ":zero": 0 },
          },
        },
      ])
    )
      return;
    const current = await this.read(this.tables.events, eventKey(eventId));
    if (current?.status !== "ARCHIVED" || current.teardownExpected !== count)
      throw new DeploymentConflict("teardown_target_set_changed");
  }
  async archiveTeardown(eventId: string): Promise<boolean> {
    return this.commit([
      {
        Update: {
          TableName: this.tables.events,
          Key: eventKey(eventId),
          UpdateExpression: "SET #status = :archived",
          ConditionExpression:
            "#status = :closing AND attribute_exists(teardownExpected) AND teardownCompleted = teardownExpected",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":closing": "TEARDOWN", ":archived": "ARCHIVED" },
        },
      },
    ]);
  }
  /** The base-table TARGET rows are strong reads; an eventually-consistent GSI cannot prove complete cleanup. */
  async listTargetJobs(eventId: string, teamId: string): Promise<DeploymentJob[]> {
    const jobs: DeploymentJob[] = [];
    let cursor: Record<string, unknown> | undefined;
    do {
      const page = await this.ddb.send(
        new QueryCommand({
          TableName: this.tables.deployments,
          ConsistentRead: true,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
          ExpressionAttributeValues: {
            ":pk": `EVENT#${eventId}#TEAM#${teamId}`,
            ":prefix": "TARGET#",
          },
          Limit: 100,
          ExclusiveStartKey: cursor,
        }),
      );
      for (const row of page.Items ?? []) {
        const target = z
          .object({ jobId: z.string(), SK: z.string(), attempt: z.number() })
          .parse(row);
        const job = await this.getJob(target.jobId);
        if (
          !job ||
          job.eventId !== eventId ||
          job.teamId !== teamId ||
          job.attempt !== target.attempt ||
          targetKey(eventId, teamId, job.problemId).SK !== target.SK
        )
          throw new Error("Corrupt teardown target ownership.");
        await this.assertHistoricalAttemptsEmpty(job);
        jobs.push(job);
      }
      cursor = page.LastEvaluatedKey;
    } while (cursor);
    return jobs;
  }
  /** A current target cannot certify cleanup in an older account/region. Unknown historical sends remain explicit blockers. */
  private async assertHistoricalAttemptsEmpty(job: DeploymentJob): Promise<void> {
    let cursor: Record<string, unknown> | undefined;
    const seen = new Set<number>();
    do {
      const page = await this.ddb.send(
        new QueryCommand({
          TableName: this.tables.deployments,
          ConsistentRead: true,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
          ExpressionAttributeValues: { ":pk": jobKey(job.jobId).PK, ":prefix": "ATTEMPT#" },
          Limit: 100,
          ExclusiveStartKey: cursor,
        }),
      );
      for (const row of page.Items ?? []) {
        const parsed = jobSchema.safeParse(row);
        if (!parsed.success) throw new DeploymentConflict("historical_attempt_record_invalid");
        const previous = parsed.data;
        if (
          previous.jobId !== job.jobId ||
          previous.eventId !== job.eventId ||
          previous.teamId !== job.teamId ||
          previous.problemId !== job.problemId ||
          previous.attempt >= job.attempt ||
          row.SK !== `ATTEMPT#${previous.attempt}` ||
          seen.has(previous.attempt)
        )
          throw new DeploymentConflict("historical_attempt_record_invalid");
        seen.add(previous.attempt);
        await this.assertNeverCreated(previous);
      }
      cursor = page.LastEvaluatedKey;
    } while (cursor);
    if (seen.size !== job.attempt - 1)
      throw new DeploymentConflict("historical_attempt_history_incomplete");
  }
  private async assertNeverCreated(previous: DeploymentJob): Promise<void> {
    if (previous.stackId) throw new DeploymentConflict("historical_attempt_resources_unresolved");
    const creation = await this.getCreation(previous);
    if (
      creation?.state !== "NOT_STARTED" ||
      creation.stackId ||
      creation.fingerprint ||
      creation.owner ||
      creation.leaseUntil !== 0
    )
      throw new DeploymentConflict("historical_attempt_resources_unresolved");
  }
  async getCreation(identity: DeploymentIdentity): Promise<CreationReservation | undefined> {
    const row = await this.read(
      this.tables.deployments,
      creationKey(identity.jobId, identity.attempt),
    );
    if (!row) return undefined;
    const reservation = creationSchema.parse(row);
    if (
      reservation.jobId !== identity.jobId ||
      reservation.eventId !== identity.eventId ||
      reservation.teamId !== identity.teamId ||
      reservation.attempt !== identity.attempt
    )
      throw new DeploymentConflict("creation_scope_changed");
    return reservation;
  }
  /** Reserve before remote create. Closing the event and this transaction serialize, so no recovery can restart creation. */
  async reserveCreation(identity: DeploymentIdentity, owner: string, now: number): Promise<void> {
    const prior = await this.getCreation(identity);
    if (prior?.owner && prior.owner !== owner)
      throw new DeploymentConflict("creation_owner_changed");
    const job = await this.ownedJob(identity);
    const registryGuard = await registeredAccountGuard(this.ddb, this.tables, job.connection);
    const item: CreationReservation = {
      ...identity,
      ...prior,
      state: prior?.state === "ACKNOWLEDGED" ? "ACKNOWLEDGED" : "REQUESTED",
      owner,
      leaseUntil: now + 120_000,
    };
    if (
      !(await this.commit([
        installationIntakeGuard(this.tables.events),
        this.openEventCheck(identity.eventId, now),
        this.jobOwnerCheck(identity, owner, "IN_PROGRESS"),
        ...(registryGuard ? [registryGuard] : []),
        {
          Put: {
            TableName: this.tables.deployments,
            Item: { ...item, ...creationKey(identity.jobId, identity.attempt) },
            ConditionExpression: prior
              ? "#state = :previous AND (attribute_not_exists(#owner) OR #owner = :owner)"
              : "attribute_not_exists(PK)",
            ...(prior
              ? {
                  ExpressionAttributeNames: { "#owner": "owner", "#state": "state" },
                  ExpressionAttributeValues: { ":owner": owner, ":previous": prior.state },
                }
              : {}),
          },
        },
      ]))
    )
      throw new DeploymentConflict("creation_closed_or_owner_changed");
  }
  async recordCreation(
    identity: DeploymentIdentity,
    owner: string,
    reference: { readonly stackId: string; readonly fingerprint: string },
  ): Promise<void> {
    await this.verifyStoredReference(identity, reference);
    if (
      !(await this.commit([
        {
          Update: {
            TableName: this.tables.deployments,
            Key: creationKey(identity.jobId, identity.attempt),
            UpdateExpression: "SET #state = :ack, stackId = :stack, fingerprint = :fingerprint",
            ConditionExpression:
              "#owner = :owner AND (attribute_not_exists(stackId) OR (stackId = :stack AND fingerprint = :fingerprint))",
            ExpressionAttributeNames: { "#state": "state", "#owner": "owner" },
            ExpressionAttributeValues: {
              ":ack": "ACKNOWLEDGED",
              ":owner": owner,
              ":stack": reference.stackId,
              ":fingerprint": reference.fingerprint,
            },
          },
        },
      ]))
    )
      throw new DeploymentConflict("creation_receipt_changed");
  }
  async getTeardown(identity: DeploymentIdentity): Promise<TeardownRecord | undefined> {
    const row = await this.read(this.tables.deployments, teardownKey(identity.jobId));
    if (!row) return undefined;
    const record = teardownSchema.parse(row);
    if (
      record.jobId !== identity.jobId ||
      record.eventId !== identity.eventId ||
      record.teamId !== identity.teamId ||
      record.attempt !== identity.attempt ||
      (identity.generation !== undefined && identity.generation !== record.generation)
    )
      throw new DeploymentConflict("teardown_scope_or_generation_changed");
    return record;
  }
  async requestTeardown(identity: DeploymentIdentity, at: string): Promise<"enqueued" | "skipped"> {
    for (let retry = 0; retry < 8; retry++) {
      const job = await this.ownedJob(identity);
      const previous = await this.getTeardown(identity);
      if (previous && previous.status !== "FAILED") return "skipped";
      const generation = (previous?.generation ?? 0) + 1;
      const cancelled = job.status === "PENDING" || job.status === "DELETED";
      const marker = this.nextTeardown(job, previous, generation, cancelled, at);
      const writes = this.teardownRequestWrites(job, marker, previous, cancelled);
      if (await this.commit(writes)) {
        if (cancelled) await this.archiveTeardown(job.eventId);
        return "enqueued";
      }
      await pause(retry);
    }
    throw new DeploymentConflict("teardown_request_conflict");
  }
  private nextTeardown(
    job: DeploymentJob,
    previous: TeardownRecord | undefined,
    generation: number,
    cancelled: boolean,
    at: string,
  ): TeardownRecord {
    return {
      eventId: job.eventId,
      teamId: job.teamId,
      jobId: job.jobId,
      attempt: job.attempt,
      generation,
      status: cancelled ? "DELETED" : "PENDING",
      requestedAt: previous?.requestedAt ?? at,
      updatedAt: at,
      ...(previous?.stackId ? { stackId: previous.stackId } : {}),
      ...(previous?.fingerprint ? { fingerprint: previous.fingerprint } : {}),
    };
  }
  private teardownRequestWrites(
    job: DeploymentJob,
    marker: TeardownRecord,
    previous: TeardownRecord | undefined,
    cancelled: boolean,
  ): Write[] {
    const writes: Write[] = [
      closingEventGuard(this.tables.events, job.eventId),
      {
        Update: {
          TableName: this.tables.deployments,
          Key: jobKey(job.jobId),
          UpdateExpression: `SET teardownStatus = :teardown${cancelled ? ", #status = :deleted" : ""} REMOVE teardownFailureReason`,
          ConditionExpression:
            "attempt = :attempt AND #status = :previous AND revision = :revision",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":teardown": marker.status,
            ":attempt": job.attempt,
            ":previous": job.status,
            ":revision": job.revision,
            ...(cancelled ? { ":deleted": "DELETED" } : {}),
          },
        },
      },
      {
        Put: {
          TableName: this.tables.deployments,
          Item: { ...marker, ...teardownKey(job.jobId) },
          ConditionExpression: previous
            ? "generation = :generation AND #status = :failed"
            : "attribute_not_exists(PK)",
          ...(previous
            ? {
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":generation": previous.generation,
                  ":failed": "FAILED",
                },
              }
            : {}),
        },
      },
    ];
    if (cancelled) {
      // Replace the event ConditionCheck: DynamoDB cannot check and update the same item separately.
      writes[0] = this.completedTeardownUpdate(job.eventId);
      writes.push({
        Delete: { TableName: this.tables.deployments, Key: dispatchKey(job.jobId, job.attempt) },
      });
    } else
      writes.push({
        Put: {
          TableName: this.tables.deployments,
          Item: {
            ...teardownDispatchKey(job.jobId, job.attempt, marker.generation),
            eventId: job.eventId,
            teamId: job.teamId,
            jobId: job.jobId,
            attempt: job.attempt,
            operation: "delete",
            generation: marker.generation,
            createdAt: marker.requestedAt,
          },
          ConditionExpression: "attribute_not_exists(PK)",
        },
      });
    return writes;
  }
  async beginTeardown(
    identity: DeploymentIdentity,
    owner: string,
    at: string,
  ): Promise<"started" | "replay"> {
    if (!owner || owner.length > 512) throw new Error("An immutable teardown owner is required.");
    const marker = await this.requireTeardown(identity);
    if (marker.status === "IN_PROGRESS" && marker.owner === owner) return "replay";
    if (
      !(await this.commit([
        closingEventGuard(this.tables.events, identity.eventId),
        {
          Update: {
            TableName: this.tables.deployments,
            Key: teardownKey(identity.jobId),
            UpdateExpression: "SET #status = :running, #owner = :owner, updatedAt = :at",
            ConditionExpression: "generation = :generation AND #status = :pending",
            ExpressionAttributeNames: { "#status": "status", "#owner": "owner" },
            ExpressionAttributeValues: {
              ":running": "IN_PROGRESS",
              ":pending": "PENDING",
              ":owner": owner,
              ":at": at,
              ":generation": marker.generation,
            },
          },
        },
        {
          Delete: {
            TableName: this.tables.deployments,
            Key: teardownDispatchKey(identity.jobId, identity.attempt, marker.generation),
          },
        },
      ]))
    )
      throw new DeploymentConflict("teardown_claim_conflict");
    return "started";
  }
  async prepareDeletion(
    identity: DeploymentIdentity,
    owner: string,
    now: number,
  ): Promise<boolean> {
    const job = await this.ownedJob(identity);
    const creation = await this.getCreation(identity);
    if (job.status === "IN_PROGRESS" || (creation && creation.leaseUntil > now)) return false;
    if (!["COMPLETE", "FAILED", "DELETING"].includes(job.status))
      throw new DeploymentConflict("teardown_source_not_terminal");
    if (
      !(await this.commit([
        closingEventGuard(this.tables.events, identity.eventId),
        this.teardownOwnerCheck(identity, owner),
        {
          Update: {
            TableName: this.tables.deployments,
            Key: jobKey(job.jobId),
            UpdateExpression: "SET #status = :deleting, teardownStatus = :running",
            ConditionExpression: "attempt = :attempt AND #status = :previous",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":deleting": "DELETING",
              ":running": "IN_PROGRESS",
              ":attempt": job.attempt,
              ":previous": job.status,
            },
          },
        },
      ]))
    )
      throw new DeploymentConflict("teardown_prepare_conflict");
    return true;
  }
  async recordTeardownReference(
    identity: DeploymentIdentity,
    owner: string,
    reference: { readonly stackId: string; readonly fingerprint: string },
  ): Promise<void> {
    await this.verifyStoredReference(identity, reference);
    if (
      !(await this.commit([
        {
          Update: {
            TableName: this.tables.deployments,
            Key: teardownKey(identity.jobId),
            UpdateExpression: "SET stackId = :stack, fingerprint = :fingerprint",
            ConditionExpression:
              "generation = :generation AND #status = :running AND #owner = :owner AND (attribute_not_exists(stackId) OR (stackId = :stack AND fingerprint = :fingerprint))",
            ExpressionAttributeNames: { "#status": "status", "#owner": "owner" },
            ExpressionAttributeValues: {
              ":generation": identity.generation,
              ":running": "IN_PROGRESS",
              ":owner": owner,
              ":stack": reference.stackId,
              ":fingerprint": reference.fingerprint,
            },
          },
        },
      ]))
    )
      throw new DeploymentConflict("teardown_reference_changed");
  }
  async finishTeardown(
    identity: DeploymentIdentity,
    owner: string | undefined,
    result: TeardownCompletion,
    at: string,
  ): Promise<"updated" | "replay"> {
    if (result.status === "DELETED" && !owner)
      throw new DeploymentConflict("teardown_owner_required");
    for (let retry = 0; retry < 16; retry++) {
      const outcome = await this.finishTeardownOnce(identity, owner, result, at);
      if (outcome) return outcome;
      await pause(retry);
    }
    throw new DeploymentConflict("teardown_finish_conflict");
  }
  private async finishTeardownOnce(
    identity: DeploymentIdentity,
    owner: string | undefined,
    result: TeardownCompletion,
    at: string,
  ): Promise<"updated" | "replay" | undefined> {
    if (result.status === "FAILED" && (!result.failureReason || result.failureReason.length > 2000))
      throw new Error("A bounded teardown failure reason is required.");
    const marker = await this.requireTeardown(identity);
    if (marker.owner !== owner) throw new DeploymentConflict("teardown_owner_changed");
    if (result.stackId && marker.stackId && result.stackId !== marker.stackId)
      throw new DeploymentConflict("teardown_reference_changed");
    if (marker.status === result.status) {
      if (result.status === "DELETED") await this.archiveTeardown(identity.eventId);
      return "replay";
    }
    const job = await this.ownedJob(identity);
    const deleted = result.status === "DELETED";
    if (deleted && job.status !== "DELETING") throw new DeploymentConflict("teardown_not_deleting");
    const completion = await this.checkedTeardownCompletion(identity, job, marker, result);
    const writes = this.teardownFinishWrites(identity, owner, marker, job, completion, at);
    if (deleted) writes.push(this.completedTeardownUpdate(identity.eventId));
    if (!owner)
      writes.push({
        Delete: {
          TableName: this.tables.deployments,
          Key: teardownDispatchKey(identity.jobId, identity.attempt, marker.generation),
        },
      });
    if (!(await this.commit(writes))) return undefined;
    if (deleted) await this.archiveTeardown(identity.eventId);
    return "updated";
  }
  private async checkedTeardownCompletion(
    identity: DeploymentIdentity,
    job: DeploymentJob,
    marker: TeardownRecord,
    result: TeardownCompletion,
  ): Promise<TeardownCompletion> {
    let known = marker.stackId ?? job.stackId;
    let creation: CreationReservation | undefined;
    if (!known && (result.status === "DELETED" || result.stackId)) {
      creation = await this.getCreation(identity);
      known = creation?.stackId;
    }
    if (result.stackId !== undefined && result.stackId !== known)
      throw new DeploymentConflict("teardown_reference_changed");
    if (result.status === "DELETED" && !known && creation?.state !== "NOT_STARTED")
      throw new DeploymentConflict("teardown_absence_unconfirmed");
    return {
      status: result.status,
      ...(result.failureReason ? { failureReason: result.failureReason } : {}),
      ...(known ? { stackId: known } : {}),
    };
  }
  private teardownFinishWrites(
    identity: DeploymentIdentity,
    owner: string | undefined,
    marker: TeardownRecord,
    job: DeploymentJob,
    result: TeardownCompletion,
    at: string,
  ): Write[] {
    const deleted = result.status === "DELETED";
    return [
      {
        Put: {
          TableName: this.tables.deployments,
          Item: {
            ...marker,
            status: result.status,
            ...(result.failureReason ? { failureReason: result.failureReason } : {}),
            ...(result.stackId ? { stackId: result.stackId } : {}),
            updatedAt: at,
            ...teardownKey(identity.jobId),
          },
          ConditionExpression: `generation = :generation AND #status = :expected AND ${owner ? "#owner = :owner" : "attribute_not_exists(#owner)"}`,
          ExpressionAttributeNames: { "#status": "status", "#owner": "owner" },
          ExpressionAttributeValues: {
            ":generation": marker.generation,
            ":expected": owner ? "IN_PROGRESS" : "PENDING",
            ...(owner ? { ":owner": owner } : {}),
          },
        },
      },
      {
        Update: {
          TableName: this.tables.deployments,
          Key: jobKey(identity.jobId),
          UpdateExpression: `SET teardownStatus = :teardown, updatedAt = :at${deleted ? ", #status = :deleted" : ", teardownFailureReason = :reason"}`,
          ConditionExpression: "attempt = :attempt AND #status = :previous",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":teardown": result.status,
            ":at": at,
            ":attempt": job.attempt,
            ":previous": job.status,
            ...(deleted ? { ":deleted": "DELETED" } : { ":reason": result.failureReason }),
          },
        },
      },
    ];
  }
  private async verifyStoredReference(
    identity: DeploymentIdentity,
    reference: { readonly stackId: string; readonly fingerprint: string },
  ): Promise<void> {
    const job = await this.ownedJob(identity);
    const prefix = `arn:aws:cloudformation:${job.region}:${job.awsAccountId}:stack/${job.stackName}/`;
    if (
      !reference.stackId.startsWith(prefix) ||
      !/^[A-Za-z0-9-]+$/u.test(reference.stackId.slice(prefix.length)) ||
      !/^[a-f0-9]{64}$/u.test(reference.fingerprint)
    )
      throw new DeploymentConflict("stack_reference_scope_changed");
  }
  private async requireTeardown(identity: DeploymentIdentity): Promise<TeardownRecord> {
    if (identity.operation !== "delete" || !identity.generation)
      throw new DeploymentConflict("invalid_teardown_identity");
    const marker = await this.getTeardown(identity);
    if (!marker) throw new DeploymentConflict("teardown_missing");
    return marker;
  }
  private teardownOwnerCheck(identity: DeploymentIdentity, owner: string): Write {
    return {
      ConditionCheck: {
        TableName: this.tables.deployments,
        Key: teardownKey(identity.jobId),
        ConditionExpression: "generation = :generation AND #status = :running AND #owner = :owner",
        ExpressionAttributeNames: { "#status": "status", "#owner": "owner" },
        ExpressionAttributeValues: {
          ":generation": identity.generation,
          ":running": "IN_PROGRESS",
          ":owner": owner,
        },
      },
    };
  }
  private completedTeardownUpdate(eventId: string): Write {
    return {
      Update: {
        TableName: this.tables.events,
        Key: eventKey(eventId),
        UpdateExpression: "ADD teardownCompleted :one",
        ConditionExpression: "#status = :closing",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":one": 1, ":closing": "TEARDOWN" },
      },
    };
  }
  private openEventCheck(eventId: string, now: number): Write {
    return {
      ConditionCheck: {
        TableName: this.tables.events,
        Key: eventKey(eventId),
        ConditionExpression: "#status IN (:draft, :deploying, :ready) AND expiresAt > :now",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":draft": "DRAFT",
          ":deploying": "DEPLOYING",
          ":ready": "READY",
          ":now": Math.floor(now / 1000),
        },
      },
    };
  }
  /** Dispatcher may skip new creation while continuing the same installation's delete work. */
  async acceptingNewDeployments(): Promise<boolean> {
    return (await this.read(this.tables.events, installationControlKey)) === undefined;
  }
  private jobOwnerCheck(identity: DeploymentIdentity, owner: string, status: string): Write {
    return {
      ConditionCheck: {
        TableName: this.tables.deployments,
        Key: jobKey(identity.jobId),
        ConditionExpression:
          "attempt = :attempt AND eventId = :event AND teamId = :team AND #owner = :owner AND #status = :status",
        ExpressionAttributeNames: { "#owner": "owner", "#status": "status" },
        ExpressionAttributeValues: {
          ":attempt": identity.attempt,
          ":event": identity.eventId,
          ":team": identity.teamId,
          ":owner": owner,
          ":status": status,
        },
      },
    };
  }
  async setSchedule(
    event: import("./domain/events.js").EventRecord,
    patch: {
      readonly startsAt?: string;
      readonly endsAt?: string;
      readonly scoreboardFreezeMinutes?: number;
      readonly scoringLocked?: boolean;
    },
    at: string,
  ): Promise<void> {
    const sets = ["updatedAt = :at"];
    const values: Record<string, unknown> = {
      ":at": at,
      ":previous": event.updatedAt,
      ":draft": "DRAFT",
      ":deploying": "DEPLOYING",
      ":ready": "READY",
    };
    for (const [name, value] of Object.entries(patch)) {
      if (value !== undefined) {
        sets.push(`${name} = :${name}`);
        values[`:${name}`] = value;
      }
    }
    if (
      !(await this.commit([
        {
          Update: {
            TableName: this.tables.events,
            Key: { PK: `EVENT#${event.eventId}`, SK: "META" },
            UpdateExpression: `SET ${sets.join(", ")}`,
            ConditionExpression:
              "updatedAt = :previous AND #status IN (:draft, :deploying, :ready)",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: values,
          },
        },
      ]))
    )
      throw new DeploymentConflict("event_schedule_changed");
  }
  async pinRequest(
    eventId: string,
    key: string,
    hash: string,
    proposed: unknown,
  ): Promise<unknown> {
    if (Buffer.byteLength(JSON.stringify(proposed), "utf8") > 128 * 1024)
      throw new Error("Deployment plan exceeds bounds.");
    const storageKey = { PK: `EVENT#${eventId}`, SK: `BATCH#${contentDigest(key)}` };
    const prior = await this.replay(storageKey, hash);
    if (prior !== undefined) return prior;
    if (
      await this.commit([
        {
          Put: {
            TableName: this.tables.deployments,
            Item: { ...storageKey, requestHash: hash, response: proposed },
            ConditionExpression: "attribute_not_exists(PK)",
          },
        },
      ])
    )
      return proposed;
    const winner = await this.replay(storageKey, hash);
    if (winner === undefined) throw new DeploymentConflict("batch_reservation_conflict");
    return winner;
  }
  async getJob(jobId: string): Promise<DeploymentJob | undefined> {
    const row = await this.read(this.tables.deployments, jobKey(jobId));
    return row ? jobSchema.parse(row) : undefined;
  }
  async getTarget(
    eventId: string,
    teamId: string,
    problemId: string,
  ): Promise<DeploymentJob | undefined> {
    const row = await this.read(this.tables.deployments, targetKey(eventId, teamId, problemId));
    if (!row) return undefined;
    const job = await this.getJob(z.object({ jobId: z.string() }).parse(row).jobId);
    if (!job || job.eventId !== eventId || job.teamId !== teamId || job.problemId !== problemId)
      throw new Error("Corrupt deployment target ownership.");
    return job;
  }
  async getConnection(eventId: string, teamId: string): Promise<DeploymentConnection | undefined> {
    const row = await this.read(this.tables.events, connectionKey(eventId, teamId));
    if (!row) return undefined;
    const connection = connectionSchema.parse(row);
    if (connection.eventId !== eventId || connection.teamId !== teamId)
      throw new Error("Connection scope mismatch.");
    return connection;
  }
  /** Only the verified-connection composition may call this after successful role verification. */
  async saveVerifiedConnection(
    connection: DeploymentConnection,
    previousVersion?: number,
  ): Promise<void> {
    connectionSchema.parse(connection);
    if (connection.version !== (previousVersion ?? 0) + 1)
      throw new Error("Invalid connection version.");
    const stored = await this.commit([
      installationIntakeGuard(this.tables.events),
      {
        Put: {
          TableName: this.tables.events,
          Item: { ...connection, ...connectionKey(connection.eventId, connection.teamId) },
          ConditionExpression:
            previousVersion === undefined ? "attribute_not_exists(PK)" : "version = :version",
          ...(previousVersion === undefined
            ? {}
            : { ExpressionAttributeValues: { ":version": previousVersion } }),
        },
      },
    ]);
    if (!stored) throw new DeploymentConflict("connection_changed");
  }
  private async replay(key: Record<string, string>, hash: string): Promise<unknown | undefined> {
    const row = await this.read(this.tables.deployments, key);
    if (!row) return undefined;
    const receipt = receiptSchema.parse(row);
    if (receipt.requestHash !== hash) throw new DeploymentConflict("idempotency_key_reused");
    return receipt.response;
  }
  async accept(input: AcceptDeployment): Promise<Accepted> {
    const job = jobSchema.parse(input.job);
    this.validateAcceptance(input);
    const key = receiptKey(job.eventId, job.teamId, "DEPLOY", input.requestKey);
    const previous = await this.replay(key, input.requestHash);
    if (previous) return { kind: "replay", ...acceptedSchema.parse(previous) };
    const result = { jobId: job.jobId, attempt: job.attempt };
    const writes = this.acceptanceWrites(input);
    const registryGuard = await registeredAccountGuard(this.ddb, this.tables, job.connection);
    if (registryGuard) writes.push(registryGuard);
    if (input.retryOf !== undefined) {
      const prior = await this.getJob(job.jobId);
      if (!prior || prior.attempt !== input.retryOf)
        throw new DeploymentConflict("retry_attempt_changed");
      writes.push({
        Put: {
          TableName: this.tables.deployments,
          Item: { ...prior, PK: jobKey(job.jobId).PK, SK: `ATTEMPT#${prior.attempt}` },
          ConditionExpression: "attribute_not_exists(PK)",
        },
      });
    }
    writes.push({
      Put: {
        TableName: this.tables.deployments,
        Item: {
          ...creationKey(job.jobId, job.attempt),
          eventId: job.eventId,
          teamId: job.teamId,
          jobId: job.jobId,
          attempt: job.attempt,
          state: "NOT_STARTED",
          leaseUntil: 0,
        },
        ConditionExpression: "attribute_not_exists(PK)",
      },
    });
    writes.push({
      Put: {
        TableName: this.tables.deployments,
        Item: { ...key, requestHash: input.requestHash, response: result },
        ConditionExpression: "attribute_not_exists(PK)",
      },
    });
    for (let retry = 0; retry < 12; retry++) {
      if (await this.commit(writes)) return { kind: "accepted", ...result };
      const replay = await this.replay(key, input.requestHash);
      if (replay) return { kind: "replay", ...acceptedSchema.parse(replay) };
      await pause(retry);
    }
    throw new DeploymentConflict("deployment_acceptance_conflict");
  }
  private validateAcceptance(input: AcceptDeployment): void {
    const { job, event, team } = input;
    if (
      job.eventId !== event.eventId ||
      job.teamId !== team.teamId ||
      team.eventId !== event.eventId ||
      job.connection.eventId !== event.eventId ||
      job.connection.teamId !== team.teamId ||
      job.awsAccountId !== job.connection.accountId ||
      job.region !== job.connection.region ||
      !event.problems.some((problem) => problem.problemId === job.problemId) ||
      job.stackName !== deploymentStackName(event.eventId, team.teamId, job.problemId) ||
      job.expiresAt !== event.expiresAt ||
      job.status !== "PENDING" ||
      job.score !== 0 ||
      job.revision !== 0 ||
      job.attempt !== (input.retryOf ?? 0) + 1
    )
      throw new Error("Invalid deployment acceptance ownership or initial state.");
  }
  private acceptanceWrites(input: AcceptDeployment): Write[] {
    const { job, event, team, retryOf } = input;
    const target = targetKey(job.eventId, job.teamId, job.problemId);
    return [
      installationIntakeGuard(this.tables.events),
      eventGuard(this.tables.events, event, input.now),
      teamGuard(this.tables.teams, team, input.now),
      connectionGuard(this.tables.events, job.connection),
      {
        Put: {
          TableName: this.tables.deployments,
          Item: indexedJob(job),
          ConditionExpression:
            retryOf === undefined
              ? "attribute_not_exists(PK)"
              : "attempt = :attempt AND #status = :failed AND eventId = :event AND teamId = :team AND score = :zero",
          ...(retryOf === undefined
            ? {}
            : {
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":attempt": retryOf,
                  ":failed": "FAILED",
                  ":event": job.eventId,
                  ":team": job.teamId,
                  ":zero": 0,
                },
              }),
        },
      },
      {
        Put: {
          TableName: this.tables.deployments,
          Item: { ...target, jobId: job.jobId, attempt: job.attempt },
          ConditionExpression:
            retryOf === undefined
              ? "attribute_not_exists(PK)"
              : "jobId = :job AND attempt = :attempt",
          ...(retryOf === undefined
            ? {}
            : { ExpressionAttributeValues: { ":job": job.jobId, ":attempt": retryOf } }),
        },
      },
      {
        Put: {
          TableName: this.tables.deployments,
          Item: {
            ...dispatchKey(job.jobId, job.attempt),
            jobId: job.jobId,
            attempt: job.attempt,
            eventId: job.eventId,
            teamId: job.teamId,
            createdAt: job.createdAt,
          },
          ConditionExpression: "attribute_not_exists(PK)",
        },
      },
      {
        Update: {
          TableName: this.tables.teams,
          Key: scoreKey(job.eventId, job.teamId),
          UpdateExpression:
            "SET eventId = :event, teamId = :team, score = if_not_exists(score, :zero), completedProblems = if_not_exists(completedProblems, :zero)",
          ExpressionAttributeValues: { ":event": job.eventId, ":team": job.teamId, ":zero": 0 },
        },
      },
    ];
  }
  async listScoreEvents(eventId: string, teamId: string, limit = 100) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error("Invalid history limit.");
    const result = await this.ddb.send(
      new QueryCommand({
        TableName: this.tables.deployments,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": `SCORES#EVENT#${eventId}#TEAM#${teamId}` },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    return (result.Items ?? []).map((item) => {
      const row = z
        .object({
          eventId: z.string(),
          teamId: z.string(),
          jobId: z.string(),
          problemId: z.string(),
          points: z.number(),
          source: z.enum(["flag", "flag-wrong"]),
          result: z.enum(["ok", "wrong"]),
          occurredAt: z.string(),
        })
        .parse(item);
      if (row.eventId !== eventId || row.teamId !== teamId)
        throw new Error("Score history ownership mismatch.");
      return {
        jobId: row.jobId,
        problemId: row.problemId,
        points: row.points,
        source: row.source,
        result: row.result,
        occurredAt: row.occurredAt,
      };
    });
  }
  async listDispatch(
    limit = 25,
    options: { readonly deletesOnly?: boolean } = {},
  ): Promise<readonly DispatchIntent[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new Error("Invalid dispatch limit");
    const intents: DispatchIntent[] = [];
    let cursor: Record<string, unknown> | undefined;
    do {
      const result = await this.ddb.send(
        new QueryCommand({
          TableName: this.tables.deployments,
          ConsistentRead: true,
          KeyConditionExpression: "PK = :pk",
          ExpressionAttributeValues: {
            ":pk": "DISPATCH#PENDING",
            ...(options.deletesOnly ? { ":delete": "delete" } : {}),
          },
          ...(options.deletesOnly
            ? {
                FilterExpression: "#operation = :delete",
                ExpressionAttributeNames: { "#operation": "operation" },
              }
            : {}),
          Limit: limit - intents.length,
          ...(cursor ? { ExclusiveStartKey: cursor } : {}),
        }),
      );
      intents.push(
        ...(result.Items ?? []).map((row) =>
          parseDispatchIntent(row, options.deletesOnly ?? false),
        ),
      );
      cursor = result.LastEvaluatedKey;
    } while (intents.length < limit && cursor && Object.keys(cursor).length > 0);
    return intents;
  }
  async begin(
    identity: DeploymentIdentity,
    owner: string,
    at: string,
  ): Promise<"started" | "replay"> {
    if (!owner || owner.length > 512) throw new Error("An immutable workflow owner is required.");
    const job = await this.ownedJob(identity);
    if (job.status === "IN_PROGRESS" && job.owner === owner) return "replay";
    const done = await this.commit([
      {
        Update: {
          TableName: this.tables.deployments,
          Key: jobKey(job.jobId),
          UpdateExpression: "SET #status = :running, #owner = :owner, updatedAt = :at",
          ConditionExpression:
            "attempt = :attempt AND #status = :pending AND eventId = :event AND teamId = :team",
          ExpressionAttributeNames: { "#status": "status", "#owner": "owner" },
          ExpressionAttributeValues: {
            ":running": "IN_PROGRESS",
            ":pending": "PENDING",
            ":owner": owner,
            ":at": at,
            ":attempt": identity.attempt,
            ":event": identity.eventId,
            ":team": identity.teamId,
          },
        },
      },
      { Delete: { TableName: this.tables.deployments, Key: dispatchKey(job.jobId, job.attempt) } },
      connectionGuard(this.tables.events, job.connection),
      installationIntakeGuard(this.tables.events),
      this.openEventCheck(job.eventId, Date.parse(at)),
    ]);
    if (!done) throw new DeploymentConflict("deployment_claim_conflict");
    return "started";
  }
  async failPending(
    identity: DeploymentIdentity,
    reason: string,
    at: string,
  ): Promise<"updated" | "replay"> {
    if (!reason || reason.length > 2000) throw new Error("A bounded failure reason is required.");
    const job = await this.ownedJob(identity);
    if (job.status === "FAILED" && !job.owner) return "replay";
    if (
      !(await this.commit([
        {
          Update: {
            TableName: this.tables.deployments,
            Key: jobKey(job.jobId),
            UpdateExpression: "SET #status = :failed, failureReason = :reason, updatedAt = :at",
            ConditionExpression:
              "attempt = :attempt AND #status = :pending AND eventId = :event AND teamId = :team",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":failed": "FAILED",
              ":pending": "PENDING",
              ":reason": reason,
              ":at": at,
              ":attempt": identity.attempt,
              ":event": identity.eventId,
              ":team": identity.teamId,
            },
          },
        },
        {
          Delete: { TableName: this.tables.deployments, Key: dispatchKey(job.jobId, job.attempt) },
        },
      ]))
    )
      throw new DeploymentConflict("pending_failure_conflict");
    return "updated";
  }
  private async ownedJob(identity: DeploymentIdentity): Promise<DeploymentJob> {
    const job = await this.getJob(identity.jobId);
    if (
      !job ||
      job.eventId !== identity.eventId ||
      job.teamId !== identity.teamId ||
      job.attempt !== identity.attempt
    )
      throw new DeploymentConflict("deployment_scope_or_attempt_changed");
    return job;
  }
  async finish(
    identity: DeploymentIdentity,
    owner: string,
    completion: DeploymentCompletion,
    at: string,
  ): Promise<"updated" | "replay"> {
    const job = await this.ownedJob(identity);
    if (job.owner !== owner) throw new DeploymentConflict("deployment_owner_changed");
    validateCompletion(job, completion);
    const digest = contentDigest(JSON.stringify(completion));
    if (job.status === completion.status) {
      if (job.completionDigest !== digest)
        throw new DeploymentConflict("completion_payload_changed");
      return "replay";
    }
    const values: Record<string, unknown> = {
      ":attempt": identity.attempt,
      ":owner": owner,
      ":running": "IN_PROGRESS",
      ":revision": job.revision,
      ":status": completion.status,
      ":digest": digest,
      ":at": at,
    };
    const sets = ["#status = :status", "completionDigest = :digest", "updatedAt = :at"];
    for (const [name, value] of Object.entries(completion)) {
      if (name !== "status" && value !== undefined) {
        sets.push(`${name} = :${name}`);
        values[`:${name}`] = value;
      }
    }
    if (completion.status === "COMPLETE") sets.push("completedAt = :at");
    const writes: Write[] = [
      {
        Update: {
          TableName: this.tables.deployments,
          Key: jobKey(job.jobId),
          UpdateExpression: `SET ${sets.join(", ")}`,
          ConditionExpression:
            "attempt = :attempt AND #owner = :owner AND #status = :running AND revision = :revision",
          ExpressionAttributeNames: { "#owner": "owner", "#status": "status" },
          ExpressionAttributeValues: values,
        },
      },
    ];
    if (!(await this.commit(writes))) {
      const current = await this.ownedJob(identity);
      if (
        current.status === completion.status &&
        current.owner === owner &&
        current.completionDigest === digest
      )
        return "replay";
      throw new DeploymentConflict("deployment_transition_conflict");
    }
    return "updated";
  }
  /** One atomic authorization point immediately before releasing a participant STS session. */
  async assertParticipantAccessCurrent(input: {
    readonly team: TeamRecord;
    readonly event: EventRecord;
    readonly job: DeploymentJob;
    readonly fingerprint: string;
    readonly now: number;
  }): Promise<void> {
    const { team, event, job, now, fingerprint } = input;
    if (
      team.eventId !== event.eventId ||
      job.eventId !== event.eventId ||
      job.teamId !== team.teamId ||
      job.connection.eventId !== event.eventId ||
      job.connection.teamId !== team.teamId ||
      job.status !== "COMPLETE" ||
      job.teardownStatus ||
      !job.stackId ||
      !job.completionDigest ||
      !job.parameters ||
      !/^[a-f0-9]{64}$/u.test(fingerprint) ||
      scoringBlock(event, now)
    )
      throw new DeploymentConflict("participant_access_changed");
    const writes: Write[] = [
      installationIntakeGuard(this.tables.events),
      eventGuard(this.tables.events, event, now, true),
      teamGuard(this.tables.teams, team, now),
      connectionGuard(this.tables.events, job.connection),
      {
        ConditionCheck: {
          TableName: this.tables.deployments,
          Key: jobKey(job.jobId),
          ConditionExpression:
            "eventId = :event AND teamId = :team AND attempt = :attempt AND #status = :complete AND attribute_not_exists(teardownStatus) AND completionDigest = :digest AND stackId = :stack AND #connection = :connection AND #parameters = :parameters AND artifactDigest = :artifact AND expiresAt > :now",
          ExpressionAttributeNames: {
            "#status": "status",
            "#connection": "connection",
            "#parameters": "parameters",
          },
          ExpressionAttributeValues: {
            ":event": event.eventId,
            ":team": team.teamId,
            ":attempt": job.attempt,
            ":complete": "COMPLETE",
            ":digest": job.completionDigest,
            ":stack": job.stackId,
            ":connection": job.connection,
            ":parameters": job.parameters,
            ":artifact": job.artifactDigest,
            ":now": Math.floor(now / 1000),
          },
        },
      },
      {
        ConditionCheck: {
          TableName: this.tables.deployments,
          Key: targetKey(event.eventId, team.teamId, job.problemId),
          ConditionExpression: "jobId = :job AND attempt = :attempt",
          ExpressionAttributeValues: { ":job": job.jobId, ":attempt": job.attempt },
        },
      },
      {
        ConditionCheck: {
          TableName: this.tables.deployments,
          Key: creationKey(job.jobId, job.attempt),
          ConditionExpression: "#state = :ack AND stackId = :stack AND fingerprint = :fingerprint",
          ExpressionAttributeNames: { "#state": "state" },
          ExpressionAttributeValues: {
            ":ack": "ACKNOWLEDGED",
            ":stack": job.stackId,
            ":fingerprint": fingerprint,
          },
        },
      },
    ];
    const registry = await registeredAccountGuard(this.ddb, this.tables, job.connection);
    if (registry) writes.push(registry);
    if (!(await this.commit(writes))) throw new DeploymentConflict("participant_access_changed");
  }
  async submitFlag(input: FlagRequest): Promise<FlagOutcome> {
    if (
      input.event.eventId !== input.team.eventId ||
      input.flag.length > 4096 ||
      !Number.isInteger(input.attempt) ||
      input.attempt < 1
    )
      throw new DeploymentConflict("invalid_scoring_scope_or_request");
    const block = scoringBlock(input.event, input.now);
    if (block) throw new DeploymentConflict(block);
    const key = receiptKey(input.team.eventId, input.team.teamId, "FLAG", input.requestKey);
    const requestHash = contentDigest(JSON.stringify([input.jobId, input.attempt, input.flag]));
    for (let retry = 0; retry < 24; retry++) {
      const job = await this.ownedJob({
        ...input.team,
        jobId: input.jobId,
        attempt: input.attempt,
      });
      if (job.status !== "COMPLETE" || !job.flagDigest)
        throw new DeploymentConflict("deployment_not_ready");
      const previous = await this.replay(key, requestHash);
      if (previous) {
        if (
          !(await this.commit([
            installationIntakeGuard(this.tables.events),
            eventGuard(this.tables.events, input.event, input.now, true),
            teamGuard(this.tables.teams, input.team, input.now),
          ]))
        )
          throw new DeploymentConflict("scoring_scope_or_access_changed");
        return flagOutcomeSchema.parse(previous);
      }
      const outcome = scoreOutcome(job, input.flag);
      if (await this.commit(this.scoringWrites(input, job, key, requestHash, outcome)))
        return outcome;
      await pause(retry);
    }
    throw new DeploymentConflict("scoring_scope_or_access_changed");
  }
  private scoringWrites(
    input: FlagRequest,
    job: DeploymentJob,
    key: Record<string, string>,
    requestHash: string,
    outcome: FlagOutcome,
  ): Write[] {
    if (input.event.eventId !== job.eventId) throw new DeploymentConflict("event_scope_mismatch");
    const delta = outcome.kind === "already_scored" ? 0 : outcome.scoreDelta;
    const at = new Date(input.now).toISOString();
    const writes: Write[] = [
      installationIntakeGuard(this.tables.events),
      eventGuard(this.tables.events, input.event, input.now, true),
      teamGuard(this.tables.teams, input.team, input.now),
      {
        Update: {
          TableName: this.tables.deployments,
          Key: jobKey(job.jobId),
          UpdateExpression:
            "SET score = :score, revision = :next, flagSubmitted = :solved, updatedAt = :at",
          ConditionExpression:
            "revision = :revision AND attempt = :attempt AND #status = :complete AND eventId = :event AND teamId = :team",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":score": outcome.totalScore,
            ":next": job.revision + 1,
            ":solved": outcome.kind === "ok" || job.flagSubmitted === true,
            ":at": at,
            ":revision": job.revision,
            ":attempt": job.attempt,
            ":complete": "COMPLETE",
            ":event": job.eventId,
            ":team": job.teamId,
          },
        },
      },
      {
        Put: {
          TableName: this.tables.deployments,
          Item: {
            ...key,
            requestHash,
            response: outcome,
            jobId: job.jobId,
            attempt: job.attempt,
            occurredAt: at,
          },
          ConditionExpression: "attribute_not_exists(PK)",
        },
      },
    ];
    if (outcome.kind !== "already_scored")
      writes.push(
        {
          Put: {
            TableName: this.tables.deployments,
            Item: {
              PK: jobKey(job.jobId).PK,
              SK: `EVENT#${contentDigest(input.requestKey)}`,
              jobId: job.jobId,
              eventId: job.eventId,
              teamId: job.teamId,
              problemId: job.problemId,
              attempt: job.attempt,
              GSI1PK: `SCORES#EVENT#${job.eventId}#TEAM#${job.teamId}`,
              GSI1SK: `${at}#${contentDigest(input.requestKey)}`,
              source: outcome.kind === "ok" ? "flag" : "flag-wrong",
              result: outcome.kind === "ok" ? "ok" : "wrong",
              points: delta,
              occurredAt: at,
            },
            ConditionExpression: "attribute_not_exists(PK)",
          },
        },
        {
          Update: {
            TableName: this.tables.teams,
            Key: scoreKey(job.eventId, job.teamId),
            UpdateExpression: "ADD score :delta, completedProblems :solved",
            ExpressionAttributeValues: {
              ":delta": delta,
              ":solved": outcome.kind === "ok" ? 1 : 0,
            },
          },
        },
      );
    return writes;
  }
}
function validateCompletion(job: DeploymentJob, completion: DeploymentCompletion): void {
  if (completion.status === "FAILED") {
    if (!completion.failureReason || completion.failureReason.length > 2000)
      throw new Error("A bounded failure reason is required.");
    return;
  }
  if (
    !completion.stackId?.startsWith(
      `arn:aws:cloudformation:${job.region}:${job.awsAccountId}:stack/${job.stackName}/`,
    ) ||
    !/^[a-f0-9]{64}$/u.test(completion.flagDigest ?? "")
  )
    throw new Error("Completion requires an owned stack ARN and verifier flag digest.");
  if (
    completion.publicOutputs?.[job.scoring.flagOutputKey] !== undefined ||
    Object.keys(completion.publicOutputs ?? {}).length > 20 ||
    Object.values(completion.publicOutputs ?? {}).some((value) => value.length > 4096)
  )
    throw new Error("Public deployment outputs exceed bounds.");
}
function scoreOutcome(job: DeploymentJob, flag: string): FlagOutcome {
  if (job.flagSubmitted) return { kind: "already_scored", totalScore: job.score };
  const correct = flagMatchesDigest(flag, job.flagDigest ?? "");
  const totalScore = Math.max(
    0,
    job.score + (correct ? job.scoring.points : -job.scoring.wrongPenalty),
  );
  return { kind: correct ? "ok" : "wrong", scoreDelta: totalScore - job.score, totalScore };
}
async function pause(retry: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, Math.min(50, 2 ** retry) + randomInt(10)));
}
