import { z } from "zod";
import {
  checkTeardownScope,
  pristineCreation,
  sameCreationReference,
  scoreOutcome,
  validateCompletion,
  validateHistoryCounts,
  verifyReferenceForJob,
} from "./deployment-work-helpers.js";
import {
  connectionSchema,
  creationSchema,
  jobSchema,
  receiptSchema,
  teardownSchema,
} from "./deployment-work-records.js";
import { NATIVE_COORDINATION_PROBLEM } from "./domain/coordination.js";
import {
  type AcceptDeployment,
  type CreationReservation,
  contentDigest,
  type DeploymentCompletion,
  DeploymentConflict,
  type DeploymentConnection,
  type DeploymentIdentity,
  type DeploymentJob,
  type DispatchIntent,
  deploymentStackName,
  type FlagOutcome,
  type FlagRequest,
  scoringBlock,
  type TeardownRecord,
} from "./domain/deployment-work.js";
import type { EventRecord } from "./domain/events.js";
import type { TeamRecord } from "./domain/teams.js";
import { sqlRegisteredAccountGuard } from "./sql-competitor-accounts-repository.js";
import { sqlCoordinationClosedGuard } from "./sql-coordination-schema.js";
import { sqlCloseFence } from "./sql-coordination-snapshot.js";
import { sqlConnectionGuard, sqlEventGuard, sqlTeamGuard } from "./sql-deployment-guards.js";
import type { SqlExecutor, SqlParam, SqlStatement } from "./sql-port.js";
import { sqlChangesGuard, sqlCommit, sqlGuard, sqlIntakeGuard } from "./sql-transaction.js";

export type { DeploymentCompletion } from "./domain/deployment-work.js";

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
const dispatchSchema = z.object({
  eventId: z.string(),
  teamId: z.string(),
  jobId: z.string(),
  attempt: z.number().int().positive(),
  operation: z.literal("delete").optional(),
  generation: z.number().int().positive().optional(),
  createdAt: z.string(),
});
function closingEventGuard(eventId: string): SqlStatement {
  return sqlGuard(
    "EXISTS (SELECT 1 FROM cloud_events WHERE event_id = ? AND json_extract(payload, '$.status') = 'TEARDOWN')",
    [eventId],
  );
}
function openEventGuard(eventId: string, now: number): SqlStatement {
  return sqlGuard(
    "EXISTS (SELECT 1 FROM cloud_events WHERE event_id = ? AND json_extract(payload, '$.status') IN ('DRAFT', 'DEPLOYING', 'READY') AND json_extract(payload, '$.expiresAt') > ?)",
    [eventId, Math.floor(now / 1000)],
  );
}
function receiptKey(eventId: string, teamId: string, operation: string, key: string): string {
  if (!key || key.length > 255) throw new Error("Request key must contain 1-255 characters.");
  return contentDigest(JSON.stringify([eventId, teamId, operation, key]));
}
function insertReceipt(key: string, requestHash: string, response: unknown): SqlStatement {
  return {
    sql: "INSERT INTO cloud_deployment_receipts (receipt_key, payload) VALUES (?, ?)",
    params: [key, JSON.stringify({ requestHash, response })],
  };
}
function deleteDispatch(identity: DeploymentIdentity): SqlStatement {
  return {
    sql: "DELETE FROM cloud_dispatch WHERE job_id = ? AND attempt = ? AND operation = ? AND generation = ?",
    params: [
      identity.jobId,
      identity.attempt,
      identity.operation ?? "create",
      identity.generation ?? 0,
    ],
  };
}
function insertDispatch(identity: DeploymentIdentity, createdAt: string): SqlStatement {
  return {
    sql: "INSERT INTO cloud_dispatch (job_id, attempt, operation, generation, payload) VALUES (?, ?, ?, ?, ?)",
    params: [
      identity.jobId,
      identity.attempt,
      identity.operation ?? "create",
      identity.generation ?? 0,
      JSON.stringify({
        eventId: identity.eventId,
        teamId: identity.teamId,
        jobId: identity.jobId,
        attempt: identity.attempt,
        ...(identity.operation
          ? { operation: identity.operation, generation: identity.generation }
          : {}),
        createdAt,
      }),
    ],
  };
}
function completedTeardownUpdate(eventId: string): SqlStatement[] {
  return [
    {
      sql: "UPDATE cloud_events SET payload = json_set(payload, '$.teardownCompleted', COALESCE(json_extract(payload, '$.teardownCompleted'), 0) + 1) WHERE event_id = ? AND json_extract(payload, '$.status') = 'TEARDOWN'",
      params: [eventId],
    },
    sqlChangesGuard(),
  ];
}

/** Native SQL workflow. Read snapshots are only CAS inputs; every decision is rechecked in one write transaction. */
export class SqlDeploymentWork {
  // Preserve exact persisted JSON for CAS, including its property order and additive fields.
  private readonly snapshots = new WeakMap<object, string>();
  constructor(private readonly sql: SqlExecutor) {}
  private async read<T extends object>(
    table: string,
    where: string,
    params: readonly SqlParam[],
    schema: z.ZodType<T>,
  ): Promise<T | undefined> {
    const row = await this.sql.get(`SELECT payload FROM ${table} WHERE ${where}`, params);
    if (!row) return undefined;
    const raw = z.string().parse(row.payload);
    const value = schema.parse(JSON.parse(raw));
    this.snapshots.set(value, raw);
    return value;
  }
  private snapshot(value: object): string {
    const raw = this.snapshots.get(value);
    if (raw === undefined) throw new Error("Missing persisted SQL snapshot.");
    return raw;
  }
  private check(
    table: string,
    where: string,
    params: readonly SqlParam[],
    value: object,
  ): SqlStatement {
    return sqlGuard(`EXISTS (SELECT 1 FROM ${table} WHERE ${where} AND payload = ?)`, [
      ...params,
      this.snapshot(value),
    ]);
  }
  private replace(
    table: string,
    where: string,
    params: readonly SqlParam[],
    previous: object,
    next: object,
  ): SqlStatement[] {
    return [
      {
        sql: `UPDATE ${table} SET payload = ? WHERE ${where} AND payload = ?`,
        params: [JSON.stringify(next), ...params, this.snapshot(previous)],
      },
      sqlChangesGuard(),
    ];
  }
  private jobCheck(job: DeploymentJob): SqlStatement {
    return this.check("cloud_deployments", "job_id = ?", [job.jobId], job);
  }
  private jobReplace(previous: DeploymentJob, next: DeploymentJob): SqlStatement[] {
    return this.replace("cloud_deployments", "job_id = ?", [previous.jobId], previous, next);
  }
  private commit(writes: readonly SqlStatement[]): Promise<boolean> {
    return sqlCommit(this.sql, writes);
  }
  async acceptingNewDeployments(): Promise<boolean> {
    return (
      (await this.sql.get("SELECT id FROM cloud_installation_control WHERE id = 1")) === undefined
    );
  }
  async getJob(jobId: string): Promise<DeploymentJob | undefined> {
    const job = await this.read("cloud_deployments", "job_id = ?", [jobId], jobSchema);
    if (job && job.jobId !== jobId) throw new Error("Deployment scope mismatch.");
    return job;
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
  async getTarget(
    eventId: string,
    teamId: string,
    problemId: string,
  ): Promise<DeploymentJob | undefined> {
    const target = await this.sql.get(
      "SELECT job_id, attempt FROM cloud_deployment_targets WHERE event_id = ? AND team_id = ? AND problem_id = ?",
      [eventId, teamId, problemId],
    );
    if (!target) return undefined;
    const job = await this.getJob(z.string().parse(target.job_id));
    if (
      !job ||
      job.eventId !== eventId ||
      job.teamId !== teamId ||
      job.problemId !== problemId ||
      job.attempt !== target.attempt
    )
      throw new Error("Corrupt deployment target ownership.");
    return job;
  }
  async getConnection(eventId: string, teamId: string): Promise<DeploymentConnection | undefined> {
    const connection = await this.read(
      "cloud_connections",
      "event_id = ? AND team_id = ?",
      [eventId, teamId],
      connectionSchema,
    );
    if (connection && (connection.eventId !== eventId || connection.teamId !== teamId))
      throw new Error("Connection scope mismatch.");
    return connection;
  }
  async saveVerifiedConnection(
    connection: DeploymentConnection,
    previousVersion?: number,
  ): Promise<void> {
    connectionSchema.parse(connection);
    if (connection.version !== (previousVersion ?? 0) + 1)
      throw new Error("Invalid connection version.");
    const writes: SqlStatement[] = [sqlIntakeGuard()];
    if (previousVersion === undefined)
      writes.push({
        sql: "INSERT INTO cloud_connections (event_id, team_id, payload) VALUES (?, ?, ?)",
        params: [connection.eventId, connection.teamId, JSON.stringify(connection)],
      });
    else
      writes.push(
        {
          sql: "UPDATE cloud_connections SET payload = ? WHERE event_id = ? AND team_id = ? AND json_extract(payload, '$.version') = ?",
          params: [
            JSON.stringify(connection),
            connection.eventId,
            connection.teamId,
            previousVersion,
          ],
        },
        sqlChangesGuard(),
      );
    if (!(await this.commit(writes))) throw new DeploymentConflict("connection_changed");
  }
  private async replay(key: string, hash: string): Promise<unknown | undefined> {
    const receipt = await this.read(
      "cloud_deployment_receipts",
      "receipt_key = ?",
      [key],
      receiptSchema,
    );
    if (!receipt) return undefined;
    if (receipt.requestHash !== hash) throw new DeploymentConflict("idempotency_key_reused");
    return receipt.response;
  }
  async pinRequest(
    eventId: string,
    key: string,
    hash: string,
    proposed: unknown,
  ): Promise<unknown> {
    if (Buffer.byteLength(JSON.stringify(proposed), "utf8") > 128 * 1024)
      throw new Error("Deployment plan exceeds bounds.");
    const storageKey = contentDigest(JSON.stringify([eventId, "BATCH", key]));
    const prior = await this.replay(storageKey, hash);
    if (prior !== undefined) return prior;
    if (await this.commit([insertReceipt(storageKey, hash, proposed)])) return proposed;
    const winner = await this.replay(storageKey, hash);
    if (winner === undefined) throw new DeploymentConflict("batch_reservation_conflict");
    return winner;
  }
  async accept(input: AcceptDeployment): Promise<{
    readonly kind: "accepted" | "replay";
    readonly jobId: string;
    readonly attempt: number;
  }> {
    const job = jobSchema.parse(input.job);
    this.validateAcceptance(input);
    const key = receiptKey(job.eventId, job.teamId, "DEPLOY", input.requestKey);
    const previous = await this.replay(key, input.requestHash);
    if (previous) return { kind: "replay", ...acceptedSchema.parse(previous) };
    const result = { jobId: job.jobId, attempt: job.attempt };
    const writes: SqlStatement[] = [
      sqlIntakeGuard(),
      sqlEventGuard(input.event, input.now),
      sqlTeamGuard(input.team, input.now),
      sqlConnectionGuard(job.connection),
    ];
    const registry = await sqlRegisteredAccountGuard(this.sql, job.connection);
    if (registry) writes.push(registry);
    if (input.retryOf === undefined) {
      writes.push({
        sql: "INSERT INTO cloud_deployments (job_id, event_id, team_id, problem_id, payload) VALUES (?, ?, ?, ?, ?)",
        params: [job.jobId, job.eventId, job.teamId, job.problemId, JSON.stringify(job)],
      });
      writes.push({
        sql: "INSERT INTO cloud_deployment_targets (event_id, team_id, problem_id, job_id, attempt) VALUES (?, ?, ?, ?, ?)",
        params: [job.eventId, job.teamId, job.problemId, job.jobId, job.attempt],
      });
    } else {
      const prior = await this.getJob(job.jobId);
      if (!prior || prior.attempt !== input.retryOf)
        throw new DeploymentConflict("retry_attempt_changed");
      if (
        prior.status !== "FAILED" ||
        prior.eventId !== job.eventId ||
        prior.teamId !== job.teamId ||
        prior.problemId !== job.problemId ||
        prior.score !== 0
      )
        throw new DeploymentConflict("deployment_acceptance_conflict");
      writes.push(
        {
          sql: "INSERT INTO cloud_deployment_attempts (job_id, attempt, payload) VALUES (?, ?, ?)",
          params: [prior.jobId, prior.attempt, this.snapshot(prior)],
        },
        ...this.jobReplace(prior, job),
      );
      writes.push(
        {
          sql: "UPDATE cloud_deployment_targets SET attempt = ? WHERE event_id = ? AND team_id = ? AND problem_id = ? AND job_id = ? AND attempt = ?",
          params: [job.attempt, job.eventId, job.teamId, job.problemId, job.jobId, input.retryOf],
        },
        sqlChangesGuard(),
      );
    }
    writes.push(
      insertDispatch(job, job.createdAt),
      {
        sql: "INSERT INTO cloud_team_scores (event_id, team_id, payload) VALUES (?, ?, ?) ON CONFLICT (event_id, team_id) DO NOTHING",
        params: [
          job.eventId,
          job.teamId,
          JSON.stringify({
            eventId: job.eventId,
            teamId: job.teamId,
            score: 0,
            completedProblems: 0,
          }),
        ],
      },
      {
        sql: "INSERT INTO cloud_creations (job_id, attempt, payload) VALUES (?, ?, ?)",
        params: [
          job.jobId,
          job.attempt,
          JSON.stringify({
            eventId: job.eventId,
            teamId: job.teamId,
            jobId: job.jobId,
            attempt: job.attempt,
            state: "NOT_STARTED",
            leaseUntil: 0,
          }),
        ],
      },
      insertReceipt(key, input.requestHash, result),
    );
    for (let retry = 0; retry < 12; retry++) {
      if (await this.commit(writes)) return { kind: "accepted", ...result };
      const replay = await this.replay(key, input.requestHash);
      if (replay) return { kind: "replay", ...acceptedSchema.parse(replay) };
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
  async listDispatch(
    limit = 25,
    options: { readonly deletesOnly?: boolean } = {},
  ): Promise<readonly DispatchIntent[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new Error("Invalid dispatch limit");
    const rows = await this.sql.all(
      `SELECT payload FROM cloud_dispatch${options.deletesOnly ? " WHERE operation = 'delete'" : ""} ORDER BY job_id, attempt, operation, generation LIMIT ?`,
      [limit],
    );
    return rows.map((row) => {
      const value = dispatchSchema.parse(JSON.parse(z.string().parse(row.payload)));
      if (options.deletesOnly && value.operation !== "delete")
        throw new Error("Unexpected creation in closed-installation dispatch");
      return value;
    });
  }
  async begin(
    identity: DeploymentIdentity,
    owner: string,
    at: string,
  ): Promise<"started" | "replay"> {
    if (!owner || owner.length > 512) throw new Error("An immutable workflow owner is required.");
    const job = await this.ownedJob(identity);
    if (job.status === "IN_PROGRESS" && job.owner === owner) return "replay";
    if (
      job.status !== "PENDING" ||
      !(await this.commit([
        ...this.jobReplace(job, { ...job, status: "IN_PROGRESS", owner, updatedAt: at }),
        deleteDispatch(identity),
        sqlConnectionGuard(job.connection),
        sqlIntakeGuard(),
        openEventGuard(job.eventId, Date.parse(at)),
      ]))
    )
      throw new DeploymentConflict("deployment_claim_conflict");
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
      job.status !== "PENDING" ||
      !(await this.commit([
        ...this.jobReplace(job, { ...job, status: "FAILED", failureReason: reason, updatedAt: at }),
        deleteDispatch(identity),
      ]))
    )
      throw new DeploymentConflict("pending_failure_conflict");
    return "updated";
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
    if (
      job.status === "IN_PROGRESS" &&
      (await this.commit(
        this.jobReplace(job, {
          ...job,
          ...completion,
          completionDigest: digest,
          updatedAt: at,
          ...(completion.status === "COMPLETE" ? { completedAt: at } : {}),
        }),
      ))
    )
      return "updated";
    const current = await this.ownedJob(identity);
    if (
      current.status === completion.status &&
      current.owner === owner &&
      current.completionDigest === digest
    )
      return "replay";
    throw new DeploymentConflict("deployment_transition_conflict");
  }
  async getCreation(identity: DeploymentIdentity): Promise<CreationReservation | undefined> {
    const creation = await this.read(
      "cloud_creations",
      "job_id = ? AND attempt = ?",
      [identity.jobId, identity.attempt],
      creationSchema,
    );
    if (
      creation &&
      (creation.eventId !== identity.eventId ||
        creation.teamId !== identity.teamId ||
        creation.jobId !== identity.jobId ||
        creation.attempt !== identity.attempt)
    )
      throw new DeploymentConflict("creation_scope_changed");
    return creation;
  }
  async reserveCreation(identity: DeploymentIdentity, owner: string, now: number): Promise<void> {
    const prior = await this.getCreation(identity);
    if (prior?.owner && prior.owner !== owner)
      throw new DeploymentConflict("creation_owner_changed");
    const job = await this.ownedJob(identity);
    if (job.owner !== owner || job.status !== "IN_PROGRESS")
      throw new DeploymentConflict("creation_closed_or_owner_changed");
    const next: CreationReservation = {
      ...identity,
      ...prior,
      state: prior?.state === "ACKNOWLEDGED" ? "ACKNOWLEDGED" : "REQUESTED",
      owner,
      leaseUntil: now + 120_000,
    };
    const writes = [sqlIntakeGuard(), openEventGuard(identity.eventId, now), this.jobCheck(job)];
    const registry = await sqlRegisteredAccountGuard(this.sql, job.connection);
    if (registry) writes.push(registry);
    if (prior)
      writes.push(
        ...this.replace(
          "cloud_creations",
          "job_id = ? AND attempt = ?",
          [identity.jobId, identity.attempt],
          prior,
          next,
        ),
      );
    else
      writes.push({
        sql: "INSERT INTO cloud_creations (job_id, attempt, payload) VALUES (?, ?, ?)",
        params: [identity.jobId, identity.attempt, JSON.stringify(next)],
      });
    if (!(await this.commit(writes)))
      throw new DeploymentConflict("creation_closed_or_owner_changed");
  }
  async recordCreation(
    identity: DeploymentIdentity,
    owner: string,
    reference: { readonly stackId: string; readonly fingerprint: string },
  ): Promise<void> {
    const job = await this.ownedJob(identity);
    verifyReferenceForJob(job, reference);
    const creation = await this.getCreation(identity);
    if (
      !creation ||
      creation.owner !== owner ||
      (creation.stackId !== undefined &&
        (creation.stackId !== reference.stackId || creation.fingerprint !== reference.fingerprint))
    )
      throw new DeploymentConflict("creation_receipt_changed");
    if (
      !(await this.commit([
        this.jobCheck(job),
        ...this.replace(
          "cloud_creations",
          "job_id = ? AND attempt = ?",
          [identity.jobId, identity.attempt],
          creation,
          { ...creation, state: "ACKNOWLEDGED", ...reference },
        ),
      ]))
    )
      throw new DeploymentConflict("creation_receipt_changed");
  }
  async closeEvent(event: EventRecord, at: string): Promise<"closing" | "archived"> {
    const nativeFence = event.problems.some(
      (problem) => problem.problemId === NATIVE_COORDINATION_PROBLEM,
    )
      ? await sqlCloseFence(this.sql, event.eventId, NATIVE_COORDINATION_PROBLEM)
      : [];
    if (event.status === "ARCHIVED") return "archived";
    if (event.status === "TEARDOWN") return "closing";
    if (
      await this.commit([
        ...nativeFence,
        {
          sql: "UPDATE cloud_events SET payload = json_set(payload, '$.status', 'TEARDOWN', '$.updatedAt', ?, '$.scoringLocked', json('true'), '$.teardownCompleted', COALESCE(json_extract(payload, '$.teardownCompleted'), 0)) WHERE event_id = ? AND json_extract(payload, '$.updatedAt') = ? AND json_extract(payload, '$.status') <> 'ARCHIVED'",
          params: [at, event.eventId, event.updatedAt],
        },
        sqlChangesGuard(),
      ])
    )
      return "closing";
    const current = await this.sql.get(
      "SELECT json_extract(payload, '$.status') AS status FROM cloud_events WHERE event_id = ?",
      [event.eventId],
    );
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
          sql: "UPDATE cloud_events SET payload = json_set(payload, '$.teardownExpected', ?, '$.teardownCompleted', COALESCE(json_extract(payload, '$.teardownCompleted'), 0)) WHERE event_id = ? AND json_extract(payload, '$.status') = 'TEARDOWN' AND (json_extract(payload, '$.teardownExpected') IS NULL OR json_extract(payload, '$.teardownExpected') = ?)",
          params: [count, eventId, count],
        },
        sqlChangesGuard(),
      ])
    )
      return;
    const current = await this.sql.get(
      "SELECT json_extract(payload, '$.status') AS status, json_extract(payload, '$.teardownExpected') AS expected FROM cloud_events WHERE event_id = ?",
      [eventId],
    );
    if (current?.status !== "ARCHIVED" || current.expected !== count)
      throw new DeploymentConflict("teardown_target_set_changed");
  }
  async archiveTeardown(eventId: string): Promise<boolean> {
    return this.commit([
      {
        sql: "UPDATE cloud_events SET payload = json_set(payload, '$.status', 'ARCHIVED') WHERE event_id = ? AND json_extract(payload, '$.status') = 'TEARDOWN' AND json_extract(payload, '$.teardownExpected') IS NOT NULL AND json_extract(payload, '$.teardownCompleted') = json_extract(payload, '$.teardownExpected')",
        params: [eventId],
      },
      sqlChangesGuard(),
      sqlCoordinationClosedGuard(eventId, NATIVE_COORDINATION_PROBLEM),
    ]);
  }
  async setSchedule(
    event: EventRecord,
    patch: {
      readonly startsAt?: string;
      readonly endsAt?: string;
      readonly scoreboardFreezeMinutes?: number;
      readonly scoringLocked?: boolean;
      readonly status?: "ENDED";
    },
    at: string,
  ): Promise<void> {
    if (
      !(await this.commit([
        {
          sql: "UPDATE cloud_events SET payload = json_patch(payload, ?) WHERE event_id = ? AND json_extract(payload, '$.updatedAt') = ? AND json_extract(payload, '$.status') IN ('DRAFT', 'DEPLOYING', 'READY')",
          params: [JSON.stringify({ ...patch, updatedAt: at }), event.eventId, event.updatedAt],
        },
        sqlChangesGuard(),
      ]))
    )
      throw new DeploymentConflict("event_schedule_changed");
  }
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
    const writes = [
      sqlIntakeGuard(),
      sqlEventGuard(event, now, true),
      sqlTeamGuard(team, now),
      sqlConnectionGuard(job.connection),
      sqlGuard(
        "EXISTS (SELECT 1 FROM cloud_deployments WHERE job_id = ? AND event_id = ? AND team_id = ? AND json_extract(payload, '$.attempt') = ? AND json_extract(payload, '$.status') = 'COMPLETE' AND json_extract(payload, '$.teardownStatus') IS NULL AND json_extract(payload, '$.completionDigest') = ? AND json_extract(payload, '$.stackId') = ? AND json_extract(payload, '$.connection') = json(?) AND json_extract(payload, '$.parameters') = json(?) AND json_extract(payload, '$.artifactDigest') = ? AND json_extract(payload, '$.expiresAt') > ?)",
        [
          job.jobId,
          event.eventId,
          team.teamId,
          job.attempt,
          job.completionDigest,
          job.stackId,
          JSON.stringify(job.connection),
          JSON.stringify(job.parameters),
          job.artifactDigest,
          Math.floor(now / 1000),
        ],
      ),
      sqlGuard(
        "EXISTS (SELECT 1 FROM cloud_deployment_targets WHERE event_id = ? AND team_id = ? AND problem_id = ? AND job_id = ? AND attempt = ?)",
        [event.eventId, team.teamId, job.problemId, job.jobId, job.attempt],
      ),
      sqlGuard(
        "EXISTS (SELECT 1 FROM cloud_creations WHERE job_id = ? AND attempt = ? AND json_extract(payload, '$.state') = 'ACKNOWLEDGED' AND json_extract(payload, '$.stackId') = ? AND json_extract(payload, '$.fingerprint') = ?)",
        [job.jobId, job.attempt, job.stackId, fingerprint],
      ),
    ];
    const registry = await sqlRegisteredAccountGuard(this.sql, job.connection);
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
    const hash = contentDigest(JSON.stringify([input.jobId, input.attempt, input.flag]));
    for (let retry = 0; retry < 24; retry++) {
      const job = await this.ownedJob({
        ...input.team,
        jobId: input.jobId,
        attempt: input.attempt,
      });
      if (job.status !== "COMPLETE" || !job.flagDigest)
        throw new DeploymentConflict("deployment_not_ready");
      const previous = await this.replay(key, hash);
      const guards = [
        sqlIntakeGuard(),
        sqlEventGuard(input.event, input.now, true),
        sqlTeamGuard(input.team, input.now),
      ];
      if (previous) {
        if (!(await this.commit(guards)))
          throw new DeploymentConflict("scoring_scope_or_access_changed");
        return flagOutcomeSchema.parse(previous);
      }
      const outcome = scoreOutcome(job, input.flag);
      const writes = this.scoringWrites(input, job, key, hash, outcome);
      if (await this.commit(writes)) return outcome;
    }
    throw new DeploymentConflict("scoring_scope_or_access_changed");
  }
  private scoringWrites(
    input: FlagRequest,
    job: DeploymentJob,
    key: string,
    hash: string,
    outcome: FlagOutcome,
  ): SqlStatement[] {
    const at = new Date(input.now).toISOString();
    const writes = [
      sqlIntakeGuard(),
      sqlEventGuard(input.event, input.now, true),
      sqlTeamGuard(input.team, input.now),
      ...this.jobReplace(job, {
        ...job,
        score: outcome.totalScore,
        revision: job.revision + 1,
        flagSubmitted: outcome.kind === "ok" || job.flagSubmitted === true,
        updatedAt: at,
      }),
      insertReceipt(key, hash, outcome),
    ];
    if (outcome.kind !== "already_scored") {
      const ledger = {
        jobId: job.jobId,
        eventId: job.eventId,
        teamId: job.teamId,
        problemId: job.problemId,
        attempt: job.attempt,
        source: outcome.kind === "ok" ? "flag" : "flag-wrong",
        result: outcome.kind,
        points: outcome.scoreDelta,
        occurredAt: at,
      };
      writes.push(
        {
          sql: "INSERT INTO cloud_score_events (job_id, request_hash, event_id, team_id, occurred_at, payload) VALUES (?, ?, ?, ?, ?, ?)",
          params: [
            job.jobId,
            contentDigest(input.requestKey),
            job.eventId,
            job.teamId,
            at,
            JSON.stringify(ledger),
          ],
        },
        {
          sql: "UPDATE cloud_team_scores SET payload = json_set(payload, '$.score', json_extract(payload, '$.score') + ?, '$.completedProblems', json_extract(payload, '$.completedProblems') + ?) WHERE event_id = ? AND team_id = ?",
          params: [outcome.scoreDelta, outcome.kind === "ok" ? 1 : 0, job.eventId, job.teamId],
        },
        sqlChangesGuard(),
      );
    }
    return writes;
  }
  async listScoreEvents(eventId: string, teamId: string, limit = 100) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error("Invalid history limit.");
    const rows = await this.sql.all(
      "SELECT payload FROM cloud_score_events WHERE event_id = ? AND team_id = ? ORDER BY occurred_at DESC, request_hash DESC LIMIT ?",
      [eventId, teamId, limit],
    );
    return rows.map((row) => {
      const value = z
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
        .parse(JSON.parse(z.string().parse(row.payload)));
      if (value.eventId !== eventId || value.teamId !== teamId)
        throw new Error("Score history ownership mismatch.");
      return {
        jobId: value.jobId,
        problemId: value.problemId,
        points: value.points,
        source: value.source,
        result: value.result,
        occurredAt: value.occurredAt,
      };
    });
  }
  async listTargetJobs(eventId: string, teamId: string): Promise<DeploymentJob[]> {
    const rows = await this.sql.all(
      "SELECT problem_id FROM cloud_deployment_targets WHERE event_id = ? AND team_id = ? ORDER BY problem_id",
      [eventId, teamId],
    );
    const jobs: DeploymentJob[] = [];
    for (const row of rows) {
      const job = await this.getTarget(eventId, teamId, z.string().parse(row.problem_id));
      if (!job) throw new Error("Corrupt teardown target ownership.");
      await this.listHistoricalAttempts(job);
      jobs.push(job);
    }
    return jobs;
  }
  private async listHistoricalAttempts(job: DeploymentJob): Promise<DeploymentJob[]> {
    const rows = await this.sql.all(
      "SELECT attempt, payload FROM cloud_deployment_attempts WHERE job_id = ? ORDER BY attempt",
      [job.jobId],
    );
    const history: DeploymentJob[] = [];
    const seen = new Set<number>();
    for (const row of rows) {
      const raw = z.string().parse(row.payload);
      const parsed = jobSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) throw new DeploymentConflict("historical_attempt_record_invalid");
      const prior = parsed.data;
      if (
        prior.jobId !== job.jobId ||
        prior.eventId !== job.eventId ||
        prior.teamId !== job.teamId ||
        prior.problemId !== job.problemId ||
        prior.attempt >= job.attempt ||
        prior.attempt !== row.attempt ||
        seen.has(prior.attempt)
      )
        throw new DeploymentConflict("historical_attempt_record_invalid");
      this.snapshots.set(prior, raw);
      seen.add(prior.attempt);
      history.push(prior);
    }
    if (seen.size !== job.attempt - 1)
      throw new DeploymentConflict("historical_attempt_history_incomplete");
    return history;
  }
  async getDeletionJob(
    identity: DeploymentIdentity,
  ): Promise<{ job: DeploymentJob; historical: boolean }> {
    const current = await this.getJob(identity.jobId);
    if (
      !current ||
      current.eventId !== identity.eventId ||
      current.teamId !== identity.teamId ||
      identity.attempt > current.attempt
    )
      throw new DeploymentConflict("deployment_scope_or_attempt_changed");
    if (current.attempt === identity.attempt) return { job: current, historical: false };
    const job = await this.read(
      "cloud_deployment_attempts",
      "job_id = ? AND attempt = ?",
      [identity.jobId, identity.attempt],
      jobSchema,
    );
    if (
      !job ||
      job.jobId !== current.jobId ||
      job.eventId !== current.eventId ||
      job.teamId !== current.teamId ||
      job.problemId !== current.problemId ||
      job.attempt !== identity.attempt
    )
      throw new DeploymentConflict("historical_attempt_record_invalid");
    return { job, historical: true };
  }
  private async historicalMarker(
    job: DeploymentIdentity,
    parentAttempt: number,
  ): Promise<TeardownRecord | undefined> {
    const marker = await this.read(
      "cloud_teardowns",
      "job_id = ? AND source_attempt = ?",
      [job.jobId, job.attempt],
      teardownSchema,
    );
    if (!marker) return undefined;
    checkTeardownScope(marker, job);
    if (
      marker.parentAttempt !== parentAttempt ||
      marker.attempt >= parentAttempt ||
      marker.historyExpected !== undefined ||
      marker.historyCompleted !== undefined
    )
      throw new DeploymentConflict("teardown_history_scope_changed");
    return marker;
  }
  async getTeardown(identity: DeploymentIdentity): Promise<TeardownRecord | undefined> {
    const root = await this.read(
      "cloud_teardowns",
      "job_id = ? AND source_attempt = 0",
      [identity.jobId],
      teardownSchema,
    );
    if (!root) return undefined;
    if (
      root.attempt > identity.attempt &&
      root.jobId === identity.jobId &&
      root.eventId === identity.eventId &&
      root.teamId === identity.teamId
    ) {
      const child = await this.historicalMarker(identity, root.attempt);
      if (!child) throw new DeploymentConflict("teardown_scope_or_generation_changed");
      return child;
    }
    checkTeardownScope(root, identity);
    validateHistoryCounts(root);
    return root;
  }
  private async requireTeardown(identity: DeploymentIdentity): Promise<TeardownRecord> {
    if (identity.operation !== "delete" || !identity.generation)
      throw new DeploymentConflict("invalid_teardown_identity");
    const marker = await this.getTeardown(identity);
    if (!marker) throw new DeploymentConflict("teardown_missing");
    return marker;
  }
  private markerCheck(marker: TeardownRecord): SqlStatement {
    return this.check(
      "cloud_teardowns",
      "job_id = ? AND source_attempt = ?",
      [marker.jobId, marker.parentAttempt === undefined ? 0 : marker.attempt],
      marker,
    );
  }
  private markerPut(next: TeardownRecord, previous?: TeardownRecord): SqlStatement[] {
    const source = next.parentAttempt === undefined ? 0 : next.attempt;
    if (previous)
      return this.replace(
        "cloud_teardowns",
        "job_id = ? AND source_attempt = ?",
        [next.jobId, source],
        previous,
        next,
      );
    return [
      {
        sql: "INSERT INTO cloud_teardowns (job_id, source_attempt, payload) VALUES (?, ?, ?)",
        params: [next.jobId, source, JSON.stringify(next)],
      },
    ];
  }
  private creationCheck(
    job: DeploymentIdentity,
    creation: CreationReservation | undefined,
  ): SqlStatement {
    return creation
      ? this.check(
          "cloud_creations",
          "job_id = ? AND attempt = ?",
          [job.jobId, job.attempt],
          creation,
        )
      : sqlGuard("NOT EXISTS (SELECT 1 FROM cloud_creations WHERE job_id = ? AND attempt = ?)", [
          job.jobId,
          job.attempt,
        ]);
  }
  private async historyProofs(
    job: DeploymentJob,
    completingAttempt?: number,
  ): Promise<SqlStatement[]> {
    const writes: SqlStatement[] = [];
    for (const prior of await this.listHistoricalAttempts(job)) {
      writes.push(
        this.check(
          "cloud_deployment_attempts",
          "job_id = ? AND attempt = ?",
          [prior.jobId, prior.attempt],
          prior,
        ),
      );
      if (prior.attempt === completingAttempt) continue;
      const creation = await this.getCreation(prior);
      writes.push(this.creationCheck(prior, creation));
      if (pristineCreation(prior, creation)) continue;
      const marker = await this.historicalMarker(prior, job.attempt);
      if (marker?.status !== "DELETED" || !marker.owner || !marker.stackId || !marker.fingerprint)
        throw new DeploymentConflict("historical_attempt_resources_unresolved");
      const reference = { stackId: marker.stackId, fingerprint: marker.fingerprint };
      verifyReferenceForJob(prior, reference);
      if (!sameCreationReference(prior, creation, reference))
        throw new DeploymentConflict("historical_attempt_resources_unresolved");
      writes.push(this.markerCheck(marker));
    }
    return writes;
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
      ...(previous?.historyExpected !== undefined
        ? { historyExpected: previous.historyExpected, historyCompleted: previous.historyCompleted }
        : {}),
    };
  }
  private teardownRequestWrites(
    job: DeploymentJob,
    marker: TeardownRecord,
    previous: TeardownRecord | undefined,
    cancelled: boolean,
    publish = true,
  ): SqlStatement[] {
    const next = {
      ...job,
      teardownStatus: marker.status,
      ...(cancelled ? { status: "DELETED" as const } : {}),
    };
    delete next.teardownFailureReason;
    const writes = [
      closingEventGuard(job.eventId),
      ...this.jobReplace(job, next),
      ...this.markerPut(marker, previous),
    ];
    if (cancelled) writes.push(...completedTeardownUpdate(job.eventId), deleteDispatch(job));
    else if (publish)
      writes.push(insertDispatch({ ...marker, operation: "delete" }, marker.requestedAt));
    return writes;
  }
  async requestTeardown(identity: DeploymentIdentity, at: string): Promise<"enqueued" | "skipped"> {
    if (identity.attempt > 1) return this.requestWithHistory(identity, at);
    return this.requestCurrentTeardown(identity, at);
  }
  private async requestCurrentTeardown(
    identity: DeploymentIdentity,
    at: string,
  ): Promise<"enqueued" | "skipped"> {
    for (let retry = 0; retry < 8; retry++) {
      const job = await this.ownedJob(identity);
      const previous = await this.getTeardown(identity);
      if (previous && previous.status !== "FAILED") return "skipped";
      const cancelled = job.status === "PENDING" || job.status === "DELETED";
      const marker = this.nextTeardown(
        job,
        previous,
        (previous?.generation ?? 0) + 1,
        cancelled,
        at,
      );
      const writes = this.teardownRequestWrites(job, marker, previous, cancelled);
      if (job.attempt > 1) writes.push(...(await this.historyProofs(job)));
      if (await this.commit(writes)) {
        if (cancelled) await this.archiveTeardown(job.eventId);
        return "enqueued";
      }
    }
    throw new DeploymentConflict("teardown_request_conflict");
  }
  private async requestWithHistory(
    identity: DeploymentIdentity,
    at: string,
  ): Promise<"enqueued" | "skipped"> {
    let changed = false;
    let root: TeardownRecord | undefined;
    let job: DeploymentJob | undefined;
    for (let retry = 0; retry < 8; retry++) {
      job = await this.ownedJob(identity);
      await this.listHistoricalAttempts(job);
      root = await this.getTeardown(identity);
      if (root) break;
      const proposed = {
        ...this.nextTeardown(job, undefined, 1, false, at),
        historyExpected: job.attempt - 1,
        historyCompleted: 0,
      };
      if (await this.commit(this.teardownRequestWrites(job, proposed, undefined, false, false))) {
        root = await this.getTeardown(identity);
        changed = true;
        break;
      }
    }
    if (!root || !job) throw new DeploymentConflict("teardown_request_conflict");
    if (root.historyExpected === undefined || root.historyCompleted === root.historyExpected) {
      await this.historyProofs(job);
      return this.requestCurrentTeardown(identity, at);
    }
    if (root.status !== "PENDING") throw new DeploymentConflict("teardown_history_not_ready");
    for (const prior of await this.listHistoricalAttempts(job))
      if (await this.requestHistoricalTeardown(prior, job.attempt, at)) changed = true;
    return changed ? "enqueued" : "skipped";
  }
  private async requestHistoricalTeardown(
    job: DeploymentJob,
    parentAttempt: number,
    at: string,
  ): Promise<boolean> {
    for (let retry = 0; retry < 16; retry++) {
      const result = await this.requestHistoricalOnce(job, parentAttempt, at);
      if (result !== undefined) return result;
    }
    throw new DeploymentConflict("historical_teardown_request_conflict");
  }
  private async requestHistoricalOnce(
    job: DeploymentJob,
    parentAttempt: number,
    at: string,
  ): Promise<boolean | undefined> {
    const previous = await this.historicalMarker(job, parentAttempt);
    if (previous?.status === "DELETED") return false;
    if (previous && previous.status !== "FAILED") {
      const intent = insertDispatch({ ...previous, operation: "delete" }, previous.requestedAt);
      // Its full immutable identity is the primary key, so duplicates may only reproduce that intent.
      const writes = [
        this.markerCheck(previous),
        {
          ...intent,
          sql: `${intent.sql} ON CONFLICT (job_id, attempt, operation, generation) DO NOTHING`,
        },
      ];
      if (await this.commit(writes)) return false;
      return undefined;
    }
    const marker = {
      ...this.nextTeardown(job, previous, (previous?.generation ?? 0) + 1, false, at),
      parentAttempt,
    };
    const creation = await this.getCreation(job);
    if (pristineCreation(job, creation))
      return this.completePristineHistory(job, marker, previous, creation);
    const root = await this.read(
      "cloud_teardowns",
      "job_id = ? AND source_attempt = 0",
      [job.jobId],
      teardownSchema,
    );
    if (
      !root ||
      root.attempt !== parentAttempt ||
      root.historyExpected !== parentAttempt - 1 ||
      root.historyCompleted === undefined ||
      root.historyCompleted >= root.historyExpected ||
      root.status !== "PENDING"
    )
      throw new DeploymentConflict("teardown_history_not_ready");
    if (
      await this.commit([
        closingEventGuard(job.eventId),
        this.markerCheck(root),
        ...this.markerPut(marker, previous),
        insertDispatch({ ...marker, operation: "delete" }, marker.requestedAt),
      ])
    )
      return true;
    return undefined;
  }
  private async completePristineHistory(
    job: DeploymentJob,
    marker: TeardownRecord,
    previous: TeardownRecord | undefined,
    creation: CreationReservation | undefined,
  ): Promise<boolean | undefined> {
    if (previous?.stackId !== undefined || previous?.fingerprint !== undefined)
      throw new DeploymentConflict("teardown_reference_changed");
    const writes = await this.historicalCompletionWrites(
      job,
      { ...marker, status: "DELETED" },
      previous,
    );
    if (!writes) return false;
    writes.push(this.creationCheck(job, creation));
    return (await this.commit(writes)) ? true : undefined;
  }
  private async historicalCompletionWrites(
    job: DeploymentJob,
    terminal: TeardownRecord,
    previous?: TeardownRecord,
  ): Promise<SqlStatement[] | undefined> {
    const current = await this.getJob(job.jobId);
    if (
      !current ||
      current.attempt !== terminal.parentAttempt ||
      current.eventId !== job.eventId ||
      current.teamId !== job.teamId ||
      current.problemId !== job.problemId
    )
      throw new DeploymentConflict("teardown_history_scope_changed");
    const root = await this.getTeardown(current);
    if (
      root?.status !== "PENDING" ||
      root.historyExpected !== current.attempt - 1 ||
      root.historyCompleted === undefined ||
      root.historyCompleted >= root.historyExpected
    ) {
      const winner = await this.historicalMarker(job, current.attempt);
      if (
        winner?.status === "DELETED" &&
        winner.generation === terminal.generation &&
        winner.owner === terminal.owner &&
        winner.stackId === terminal.stackId &&
        winner.fingerprint === terminal.fingerprint
      )
        return undefined;
      throw new DeploymentConflict("teardown_history_not_ready");
    }
    const next = root.historyCompleted + 1;
    const last = next === root.historyExpected;
    const writes = [
      closingEventGuard(job.eventId),
      this.jobCheck(current),
      this.check(
        "cloud_deployment_attempts",
        "job_id = ? AND attempt = ?",
        [job.jobId, job.attempt],
        job,
      ),
      ...this.markerPut(terminal, previous),
      ...this.markerPut({ ...root, historyCompleted: next }, root),
    ];
    if (last) {
      writes.push(
        ...(await this.historyProofs(current, job.attempt)),
        insertDispatch({ ...root, operation: "delete" }, root.requestedAt),
      );
      const projection = { ...current, teardownStatus: "PENDING" as const };
      delete projection.teardownFailureReason;
      writes.push(...this.jobReplace(current, projection));
    }
    return writes;
  }
  async beginTeardown(
    identity: DeploymentIdentity,
    owner: string,
    at: string,
  ): Promise<"started" | "replay"> {
    if (!owner || owner.length > 512) throw new Error("An immutable teardown owner is required.");
    const marker = await this.requireTeardown(identity);
    if (
      marker.parentAttempt === undefined &&
      marker.historyExpected !== undefined &&
      marker.historyCompleted !== marker.historyExpected
    )
      throw new DeploymentConflict("teardown_history_not_ready");
    if (marker.status === "IN_PROGRESS" && marker.owner === owner) return "replay";
    if (
      marker.status !== "PENDING" ||
      !(await this.commit([
        closingEventGuard(identity.eventId),
        ...this.markerPut({ ...marker, status: "IN_PROGRESS", owner, updatedAt: at }, marker),
        deleteDispatch(identity),
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
    const { job, historical } = await this.getDeletionJob(identity);
    const creation = await this.getCreation(identity);
    if (job.status === "IN_PROGRESS" || (creation && creation.leaseUntil > now)) return false;
    if (historical && job.status !== "FAILED")
      throw new DeploymentConflict("teardown_source_not_terminal");
    if (
      !["COMPLETE", "FAILED", "DELETING"].includes(job.status) &&
      !(job.status === "PENDING" && pristineCreation(job, creation))
    )
      throw new DeploymentConflict("teardown_source_not_terminal");
    const marker = await this.requireTeardown(identity);
    if (marker.owner !== owner || marker.status !== "IN_PROGRESS")
      throw new DeploymentConflict("teardown_prepare_conflict");
    const writes = [
      closingEventGuard(identity.eventId),
      this.markerCheck(marker),
      this.creationCheck(job, creation),
    ];
    if (historical)
      writes.push(
        this.check(
          "cloud_deployment_attempts",
          "job_id = ? AND attempt = ?",
          [job.jobId, job.attempt],
          job,
        ),
      );
    else
      writes.push(
        ...(await this.historyProofs(job)),
        ...this.jobReplace(job, { ...job, status: "DELETING", teardownStatus: "IN_PROGRESS" }),
      );
    if (!(await this.commit(writes))) throw new DeploymentConflict("teardown_prepare_conflict");
    return true;
  }
  async recordTeardownReference(
    identity: DeploymentIdentity,
    owner: string,
    reference: { readonly stackId: string; readonly fingerprint: string },
  ): Promise<void> {
    const { job, historical } = await this.getDeletionJob(identity);
    verifyReferenceForJob(job, reference);
    const creation = historical ? await this.getCreation(identity) : undefined;
    if (historical && !sameCreationReference(job, creation, reference))
      throw new DeploymentConflict("teardown_reference_changed");
    const marker = await this.requireTeardown(identity);
    if (
      marker.owner !== owner ||
      marker.status !== "IN_PROGRESS" ||
      (marker.stackId !== undefined && marker.stackId !== reference.stackId) ||
      (marker.fingerprint !== undefined && marker.fingerprint !== reference.fingerprint)
    )
      throw new DeploymentConflict("teardown_reference_changed");
    const writes = this.markerPut({ ...marker, ...reference }, marker);
    if (historical)
      writes.push(
        this.creationCheck(job, creation),
        this.check(
          "cloud_deployment_attempts",
          "job_id = ? AND attempt = ?",
          [job.jobId, job.attempt],
          job,
        ),
      );
    else writes.push(this.jobCheck(job));
    if (!(await this.commit(writes))) throw new DeploymentConflict("teardown_reference_changed");
  }
  async finishTeardown(
    identity: DeploymentIdentity,
    owner: string | undefined,
    result: TeardownCompletion,
    at: string,
  ): Promise<"updated" | "replay"> {
    if (result.status === "DELETED" && !owner)
      throw new DeploymentConflict("teardown_owner_required");
    if (result.status === "FAILED" && (!result.failureReason || result.failureReason.length > 2000))
      throw new Error("A bounded teardown failure reason is required.");
    for (let retry = 0; retry < 16; retry++) {
      const outcome = await this.finishTeardownOnce(identity, owner, result, at);
      if (outcome) return outcome;
    }
    throw new DeploymentConflict("teardown_finish_conflict");
  }
  private async finishTeardownOnce(
    identity: DeploymentIdentity,
    owner: string | undefined,
    result: TeardownCompletion,
    at: string,
  ): Promise<"updated" | "replay" | undefined> {
    const marker = await this.checkedTeardownMarker(identity, owner, result);
    if (marker.status === result.status) return this.replayTeardownCompletion(identity, marker);
    const { job, historical } = await this.getDeletionJob(identity);
    if (
      historical !== (marker.parentAttempt !== undefined) ||
      (historical && job.status !== "FAILED")
    )
      throw new DeploymentConflict("historical_attempt_record_invalid");
    const deleted = result.status === "DELETED";
    if (deleted && !historical && job.status !== "DELETING")
      throw new DeploymentConflict("teardown_not_deleting");
    const creation = await this.getCreation(identity);
    const terminal = this.checkedTerminal(job, marker, creation, result, at);
    const writes = historical
      ? await this.historicalFinishWrites(job, marker, creation, terminal)
      : await this.currentFinishWrites(job, marker, terminal);
    if (!writes) return "replay";
    writes.push(this.creationCheck(job, creation));
    if (historical || !owner) writes.push(deleteDispatch(identity));
    if (!(await this.commit(writes))) return undefined;
    if (!historical && deleted) await this.archiveTeardown(identity.eventId);
    return "updated";
  }
  private async checkedTeardownMarker(
    identity: DeploymentIdentity,
    owner: string | undefined,
    result: TeardownCompletion,
  ): Promise<TeardownRecord> {
    const marker = await this.requireTeardown(identity);
    if (marker.owner !== owner) throw new DeploymentConflict("teardown_owner_changed");
    if (result.stackId && marker.stackId && result.stackId !== marker.stackId)
      throw new DeploymentConflict("teardown_reference_changed");
    if (marker.status !== result.status && marker.status !== (owner ? "IN_PROGRESS" : "PENDING"))
      throw new DeploymentConflict("teardown_owner_changed");
    return marker;
  }
  private async replayTeardownCompletion(
    identity: DeploymentIdentity,
    marker: TeardownRecord,
  ): Promise<"replay"> {
    if (marker.parentAttempt === undefined && marker.status === "DELETED") {
      await this.historyProofs(await this.ownedJob(identity));
      await this.archiveTeardown(identity.eventId);
    }
    return "replay";
  }
  private checkedTerminal(
    job: DeploymentJob,
    marker: TeardownRecord,
    creation: CreationReservation | undefined,
    result: TeardownCompletion,
    at: string,
  ): TeardownRecord {
    const known = marker.stackId ?? job.stackId ?? creation?.stackId;
    if (result.stackId !== undefined && result.stackId !== known)
      throw new DeploymentConflict("teardown_reference_changed");
    if (result.status === "DELETED" && !known && !pristineCreation(job, creation))
      throw new DeploymentConflict("teardown_absence_unconfirmed");
    return {
      ...marker,
      status: result.status,
      ...(result.failureReason ? { failureReason: result.failureReason } : {}),
      ...(known ? { stackId: known } : {}),
      updatedAt: at,
    };
  }
  private async historicalFinishWrites(
    job: DeploymentJob,
    marker: TeardownRecord,
    creation: CreationReservation | undefined,
    terminal: TeardownRecord,
  ): Promise<SqlStatement[] | undefined> {
    if (terminal.status === "DELETED") {
      if (!terminal.stackId || !terminal.fingerprint)
        throw new DeploymentConflict("teardown_absence_unconfirmed");
      const reference = { stackId: terminal.stackId, fingerprint: terminal.fingerprint };
      verifyReferenceForJob(job, reference);
      if (!sameCreationReference(job, creation, reference))
        throw new DeploymentConflict("teardown_reference_changed");
      return this.historicalCompletionWrites(job, terminal, marker);
    }
    const current = await this.getJob(job.jobId);
    if (
      !current ||
      current.attempt !== marker.parentAttempt ||
      current.eventId !== job.eventId ||
      current.teamId !== job.teamId
    )
      throw new DeploymentConflict("teardown_history_scope_changed");
    return [
      ...this.markerPut(terminal, marker),
      ...this.jobReplace(current, {
        ...current,
        teardownStatus: "FAILED",
        teardownFailureReason: `historical_attempt_${job.attempt}: ${terminal.failureReason}`,
      }),
    ];
  }
  private async currentFinishWrites(
    job: DeploymentJob,
    marker: TeardownRecord,
    terminal: TeardownRecord,
  ): Promise<SqlStatement[]> {
    const deleted = terminal.status === "DELETED";
    const writes = [
      ...this.markerPut(terminal, marker),
      ...this.jobReplace(job, {
        ...job,
        teardownStatus: terminal.status,
        updatedAt: terminal.updatedAt,
        ...(deleted
          ? { status: "DELETED" as const }
          : { teardownFailureReason: terminal.failureReason }),
      }),
    ];
    if (deleted)
      writes.push(
        ...(await this.historyProofs(job)),
        ...completedTeardownUpdate(job.eventId),
        deleteDispatch(job),
      );
    return writes;
  }
}
