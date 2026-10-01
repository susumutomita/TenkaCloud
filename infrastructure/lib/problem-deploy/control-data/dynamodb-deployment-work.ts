import { randomInt } from "node:crypto";
import {
  type DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import {
  connectionGuard,
  connectionKey,
  connectionSchema,
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
  type Write,
} from "./deployment-storage.js";
import {
  type AcceptDeployment,
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
} from "./domain/deployment-work.js";
import { type CloudTableNames, conflict } from "./dynamodb-cloud-repository.js";

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
  async listDispatch(limit = 25): Promise<readonly DispatchIntent[]> {
    const result = await this.ddb.send(
      new QueryCommand({
        TableName: this.tables.deployments,
        ConsistentRead: true,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": "DISPATCH#PENDING" },
        Limit: limit,
      }),
    );
    return (result.Items ?? []).map((row) =>
      z
        .object({
          eventId: z.string(),
          teamId: z.string(),
          jobId: z.string(),
          attempt: z.number().int().positive(),
          createdAt: z.string(),
        })
        .parse(row),
    );
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
    const next: DeploymentJob = {
      ...job,
      ...completion,
      completionDigest: digest,
      updatedAt: at,
      ...(completion.status === "COMPLETE" ? { completedAt: at } : {}),
    };
    const writes: Write[] = [
      {
        Put: {
          TableName: this.tables.deployments,
          Item: indexedJob(next),
          ConditionExpression:
            "attempt = :attempt AND #owner = :owner AND #status = :running AND revision = :revision",
          ExpressionAttributeNames: { "#owner": "owner", "#status": "status" },
          ExpressionAttributeValues: {
            ":attempt": identity.attempt,
            ":owner": owner,
            ":running": "IN_PROGRESS",
            ":revision": job.revision,
          },
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
