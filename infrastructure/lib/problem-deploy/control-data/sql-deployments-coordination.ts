import { randomInt, randomUUID } from "node:crypto";
import { ulid } from "ulid";
import { z } from "zod";
import {
  type MatchTransition,
  transitionMatch,
} from "../../../../scripts/local-host/coordination-core.js";
import { eventSchema, teamSchema } from "./cloud-records.js";
import { purgeRunReference } from "./coordination-purge.js";
import {
  assertOperationRun,
  assertResetOpen,
  initializedMatch,
  resetRun,
} from "./coordination-runs.js";
import {
  assertArtifact,
  assertOpen,
  assertParticipantGate,
  assertPin,
  assertRoster,
  assertSchedule,
  assertSelected,
  checkedRoster,
  closedStatuses,
  defined,
  digestSchema,
  elapsed,
  hash,
  id,
  jsonBytes,
  matchDigest,
  nextTime,
  projection,
  scheduledClock,
  validateOperation,
} from "./coordination-state.js";
import {
  COORDINATION_MAX_BYTES,
  coordinationHeadKey,
  type NativeCoordinationArtifact,
  NativeCoordinationError,
  type NativeCoordinationResetInput,
  type NativeCoordinationResetResult,
  type NativeCoordinationResponse,
  type NativeCoordinationRun,
  type NativeCoordinationSummary,
  type NativeSchedulePatch,
  SQL_COORDINATION_MAX_BYTES,
} from "./domain/coordination.js";
import { type EventRecord, SQL_EVENT_LIMITS } from "./domain/events.js";
import type { TeamRecord } from "./domain/teams.js";
import type { CoordinationTiming } from "./dynamodb-deployments-coordination.js";
import { sqlPayload } from "./sql-cloud-records.js";
import {
  assertSnapshotScope,
  assertSqlPayloadAvailable,
  decodeSqlSnapshot,
  headSchema,
  readSqlRunSnapshot,
  readSqlSnapshot,
  readSqlSummary,
  type StoredRun,
  sqlCloseFence,
  sqlHeadAbsent,
  sqlHeadCheck,
} from "./sql-coordination-snapshot.js";
import type { SqlExecutor, SqlStatement } from "./sql-port.js";
import { sqlChangesGuard, sqlCommit, sqlGuard, sqlIntakeGuard } from "./sql-transaction.js";

interface Admission {
  readonly owner: string;
  attempted: boolean;
  published: boolean;
}
type RunIdentity = Pick<NativeCoordinationRun, "eventId" | "problemId" | "runId">;
interface Operation {
  readonly key: string;
  readonly hash: string;
  readonly op: unknown;
  readonly runId?: string;
}
interface RequestInput {
  readonly event: EventRecord;
  readonly team: TeamRecord;
  readonly artifact: NativeCoordinationArtifact;
  readonly now: () => number;
  readonly operation?: Operation;
}
interface BoundedRequest extends RequestInput {
  readonly deadline: number;
}
interface ScheduleInput {
  readonly event: EventRecord;
  readonly artifact: NativeCoordinationArtifact;
  readonly patch: NativeSchedulePatch;
  readonly now: () => number;
  readonly close?: boolean;
}
interface Receipt {
  readonly key: string;
  readonly hash: string;
  readonly team: TeamRecord;
  readonly response: NativeCoordinationResponse;
}

/** Exact native lifecycle; no CloudFormation job, account, TARGET row or process-local authority. */
export class SqlDeploymentsCoordination {
  constructor(
    private readonly sql: SqlExecutor,
    private readonly timing?: (sample: CoordinationTiming) => void,
  ) {}
  private timed<T>(phase: CoordinationTiming["phase"], action: () => T): T {
    const start = performance.now();
    try {
      return action();
    } finally {
      this.timing?.({ phase, elapsedMs: performance.now() - start });
    }
  }
  private async backoff(attempt: number, admission = false): Promise<void> {
    const start = performance.now();
    if (admission)
      await new Promise((resolve) =>
        setTimeout(resolve, randomInt(1, Math.min(240, 8 * 2 ** Math.min(attempt, 5)))),
      );
    else await pause(attempt);
    this.timing?.({ phase: "backoff", elapsedMs: performance.now() - start });
  }
  private async readHead(eventId: string, problemId: string) {
    coordinationHeadKey(eventId, problemId);
    const raw = await this.sql.get(
      "SELECT payload FROM cloud_coordination_runs WHERE event_id = ? AND problem_id = ?",
      [eventId, problemId],
    );
    if (!raw) return undefined;
    const head = headSchema.parse(sqlPayload(raw));
    assertSnapshotScope(head, eventId, problemId);
    assertSqlPayloadAvailable(head);
    return head;
  }

  private async commit(writes: SqlStatement[]): Promise<boolean> {
    const start = performance.now();
    try {
      return await sqlCommit(this.sql, writes);
    } finally {
      this.timing?.({ phase: "commit", elapsedMs: performance.now() - start });
    }
  }

  async read(eventId: string, problemId: string): Promise<NativeCoordinationRun | undefined> {
    return this.readSnapshot(eventId, problemId);
  }
  summary(eventId: string, problemId: string): Promise<NativeCoordinationSummary | undefined> {
    return readSqlSummary(this.sql, eventId, problemId, this.timing);
  }

  /** Erase only verified private payloads, retaining a permanent closed identity and score audit. */
  async purge(eventId: string, problemId: string): Promise<void> {
    coordinationHeadKey(eventId, problemId);
    for (let attempt = 0; attempt < 24; attempt++) {
      if (await this.purgeOnce(eventId, problemId)) return;
      await this.backoff(attempt);
    }
    throw new NativeCoordinationError(409, "coordination_conflict");
  }

  private async purgeOnce(eventId: string, problemId: string): Promise<boolean> {
    const raw = await this.sql.get(
      "SELECT payload, snapshot FROM cloud_coordination_runs WHERE event_id = ? AND problem_id = ?",
      [eventId, problemId],
    );
    if (!raw) return this.purgeAbsent(eventId, problemId);
    const head = headSchema.parse(sqlPayload(raw));
    assertSnapshotScope(head, eventId, problemId);
    if (head.purge?.state === "pending")
      throw new NativeCoordinationError(503, "coordination_purge_pending");
    if (head.purge?.state === "complete") {
      if (raw.snapshot !== "") throw new NativeCoordinationError(503, "coordination_purge_invalid");
      return true;
    }
    if (await this.sql.get("SELECT 1 FROM cloud_installation_control WHERE id = 1"))
      throw new NativeCoordinationError(409, "coordination_purge_intake_closed");
    const current = decodeSqlSnapshot(raw, eventId, problemId, this.timing);
    if (!current.closed) throw new NativeCoordinationError(409, "coordination_not_settled");
    const history = await this.purgeHistoryOrRetry(head);
    if (!history) return false;
    const { runs, guards } = history;
    const retained = headSchema
      .omit({ admissionOwner: true, admissionExpiresAt: true })
      .parse(head);
    const manifest = { ...retained, purge: { state: "complete" as const, runs } };
    assertSnapshotScope(manifest, eventId, problemId);
    return this.commit([
      sqlIntakeGuard(),
      sqlGuard(
        `EXISTS (SELECT 1 FROM cloud_coordination_runs WHERE event_id = ? AND problem_id = ?
          AND payload = ? AND snapshot = ? AND json_extract(payload, '$.purge') IS NULL)`,
        [eventId, problemId, String(raw.payload), String(raw.snapshot)],
      ),
      ...guards,
      {
        sql: "DELETE FROM cloud_coordination_history WHERE event_id = ? AND problem_id = ?",
        params: [eventId, problemId],
      },
      {
        sql: "DELETE FROM cloud_coordination_receipts WHERE event_id = ? AND problem_id = ?",
        params: [eventId, problemId],
      },
      {
        sql: `UPDATE cloud_coordination_runs SET payload = ?, snapshot = ''
          WHERE event_id = ? AND problem_id = ? AND payload = ?
            AND json_extract(payload, '$.purge') IS NULL`,
        params: [JSON.stringify(manifest), eventId, problemId, String(raw.payload)],
      },
      sqlChangesGuard(),
    ]);
  }

  private async purgeAbsent(eventId: string, problemId: string): Promise<boolean> {
    const absent = `NOT EXISTS (SELECT 1 FROM cloud_coordination_history WHERE event_id = ? AND problem_id = ?)
      AND NOT EXISTS (SELECT 1 FROM cloud_coordination_receipts WHERE event_id = ? AND problem_id = ?)`;
    const params = [eventId, problemId, eventId, problemId];
    const row = await this.sql.get(`SELECT (${absent}) AS absent`, params);
    if (row?.absent !== 1) throw new NativeCoordinationError(503, "coordination_history_invalid");
    return this.commit([sqlHeadAbsent(eventId, problemId), sqlGuard(absent, params)]);
  }

  private async purgeHistory(head: z.infer<typeof headSchema>) {
    const { eventId, problemId } = head;
    const runIds = [...(head.history ?? []), ...(head.retiredRuns ?? [])];
    if (new Set([head.runId, ...runIds]).size !== runIds.length + 1)
      throw new NativeCoordinationError(503, "coordination_history_invalid");
    // Four rows suffice to reject extra history beyond the bounded three-run inventory.
    const history = await this.sql.all(
      `SELECT run_id FROM cloud_coordination_history
        WHERE event_id = ? AND problem_id = ? LIMIT 4`,
      [eventId, problemId],
    );
    if (history.length !== runIds.length)
      throw new NativeCoordinationError(503, "coordination_history_invalid");
    const guards = [
      sqlGuard(
        `(SELECT COUNT(*) FROM cloud_coordination_history WHERE event_id = ? AND problem_id = ?) = ?`,
        [eventId, problemId, runIds.length],
      ),
    ];
    const runs = [purgeRunReference(head)];
    for (const runId of runIds) {
      if (!history.some((row) => row.run_id === runId))
        throw new NativeCoordinationError(503, "coordination_history_invalid");
      // Keep each HTTP response within the existing single-snapshot size policy.
      const saved = await this.sql.get(
        `SELECT payload, snapshot FROM cloud_coordination_history
          WHERE event_id = ? AND problem_id = ? AND run_id = ?`,
        [eventId, problemId, runId],
      );
      if (!saved) throw new NativeCoordinationError(503, "coordination_history_invalid");
      const run = decodeSqlSnapshot(saved, eventId, problemId, this.timing);
      if (run.runId !== runId || !run.closed)
        throw new NativeCoordinationError(503, "coordination_history_invalid");
      runs.push(purgeRunReference(run));
      guards.push(
        sqlGuard(
          `EXISTS (SELECT 1 FROM cloud_coordination_history
            WHERE event_id = ? AND problem_id = ? AND run_id = ? AND payload = ? AND snapshot = ?)`,
          [eventId, problemId, runId, String(saved.payload), String(saved.snapshot)],
        ),
      );
    }
    return { runs, guards };
  }

  private async purgeHistoryOrRetry(head: z.infer<typeof headSchema>) {
    try {
      return await this.purgeHistory(head);
    } catch (error) {
      if (
        error instanceof NativeCoordinationError &&
        ["coordination_history_invalid", "coordination_snapshot_invalid"].includes(error.code) &&
        (await this.historyCleanupAdvanced(head))
      )
        return undefined;
      throw error;
    }
  }

  /** Separate history reads may straddle another verified purge or a retired-run cleanup. */
  private async historyCleanupAdvanced(previous: z.infer<typeof headSchema>): Promise<boolean> {
    const { eventId, problemId } = previous;
    const raw = await this.sql.get(
      "SELECT payload, snapshot FROM cloud_coordination_runs WHERE event_id = ? AND problem_id = ?",
      [eventId, problemId],
    );
    if (!raw) return false;
    const head = headSchema.parse(sqlPayload(raw));
    assertSnapshotScope(head, eventId, problemId);
    if (
      JSON.stringify(purgeRunReference(head)) !== JSON.stringify(purgeRunReference(previous)) ||
      head.closed !== previous.closed
    )
      return false;
    if (head.purge?.state === "complete") {
      if (raw.snapshot !== "") throw new NativeCoordinationError(503, "coordination_purge_invalid");
      return true;
    }
    if (
      head.purge ||
      previous.retiredRuns?.length !== 1 ||
      (head.retiredRuns?.length ?? 0) !== 0 ||
      JSON.stringify(head.history ?? []) !== JSON.stringify(previous.history ?? [])
    )
      return false;
    decodeSqlSnapshot(raw, eventId, problemId, this.timing);
    return true;
  }
  readRun(
    eventId: string,
    problemId: string,
    runId: string,
  ): Promise<NativeCoordinationRun | undefined> {
    return readSqlRunSnapshot(this.sql, eventId, problemId, runId, this.timing);
  }

  async reset(input: NativeCoordinationResetInput): Promise<NativeCoordinationResetResult> {
    id.parse(input.expectedRunId);
    assertArtifact(input.artifact);
    assertSelected(input.event, input.artifact.problemId);
    assertResetOpen(input.event, input.now());
    // A retry completes any committed cleanup obligation before checking its stale run ID.
    await this.pruneHistory(input.event.eventId, input.artifact.problemId);
    const previous = await this.readSnapshot(input.event.eventId, input.artifact.problemId);
    if (!previous) throw new NativeCoordinationError(404, "coordination_not_initialized");
    if (previous.runId !== input.expectedRunId)
      throw new NativeCoordinationError(409, "run_rotation_conflict");
    const { run, deltas } = resetRun(previous, input.event, input.artifact, input.now());
    const writes: SqlStatement[] = [
      {
        sql: `INSERT INTO cloud_coordination_history
          (event_id, problem_id, run_id, payload, snapshot)
          SELECT event_id, problem_id, ?, json_set(json_remove(payload, '$.admissionOwner', '$.admissionExpiresAt'), '$.closed', json('true')), snapshot
          FROM cloud_coordination_runs WHERE event_id = ? AND problem_id = ?
            AND json_extract(payload, '$.purge') IS NULL`,
        params: [previous.runId, previous.eventId, previous.problemId],
      },
      ...this.transitionWrites(run, previous, deltas, input.now()),
    ];
    const commitAt = input.now();
    assertResetOpen(input.event, commitAt);
    writes.push(sqlIntakeGuard(), this.eventCheck(input.event, commitAt));
    // A losing CAS must not loop and rotate the winning request's new run.
    if (!(await this.commit(writes)))
      throw new NativeCoordinationError(409, "run_rotation_conflict");
    await this.pruneHistory(run.eventId, run.problemId);
    return {
      eventId: run.eventId,
      problemId: run.problemId,
      runId: run.runId,
      previousRunId: previous.runId,
    };
  }

  async pruneHistory(eventId: string, problemId: string): Promise<void> {
    for (let attempt = 0; attempt < 24; attempt++) {
      const head = await this.readHead(eventId, problemId);
      if (!head?.retiredRuns?.length) return;
      const writes: SqlStatement[] = [];
      for (const runId of head.retiredRuns) {
        if (runId === head.runId || head.history?.includes(runId))
          throw new NativeCoordinationError(503, "coordination_snapshot_invalid");
        writes.push(
          {
            sql: "DELETE FROM cloud_coordination_history WHERE event_id = ? AND problem_id = ? AND run_id = ?",
            params: [eventId, problemId, runId],
          },
          {
            sql: "DELETE FROM cloud_coordination_receipts WHERE event_id = ? AND problem_id = ? AND run_id = ?",
            params: [eventId, problemId, runId],
          },
        );
      }
      writes.push(
        {
          sql: `UPDATE cloud_coordination_runs SET payload = json_remove(payload, '$.retiredRuns')
            WHERE event_id = ? AND problem_id = ? AND json_extract(payload, '$.runId') = ?
              AND json_extract(payload, '$.revision') = ?
              AND json_extract(payload, '$.purge') IS NULL
              AND json_extract(payload, '$.retiredRuns') = json(?)`,
          params: [eventId, problemId, head.runId, head.revision, JSON.stringify(head.retiredRuns)],
        },
        sqlChangesGuard(),
      );
      try {
        if (await this.commit(writes)) return;
      } catch {
        throw new NativeCoordinationError(503, "coordination_history_prune_failed");
      }
      await this.backoff(attempt);
    }
    throw new NativeCoordinationError(503, "coordination_history_prune_failed");
  }
  /** Cleanup needs a complete, closed native snapshot, never merely an event status. */
  closeFence(eventId: string, problemId: string): Promise<SqlStatement[]> {
    return sqlCloseFence(this.sql, eventId, problemId, this.timing);
  }
  private readSnapshot(eventId: string, problemId: string): Promise<StoredRun | undefined> {
    return readSqlSnapshot(this.sql, eventId, problemId, this.timing);
  }

  async initialize(input: {
    readonly event: EventRecord;
    readonly teams: readonly TeamRecord[];
    readonly artifact: NativeCoordinationArtifact;
    readonly now: number;
  }): Promise<NativeCoordinationRun> {
    const { event, teams, artifact, now } = input;
    assertArtifact(artifact);
    assertSelected(event, artifact.problemId);
    assertOpen(event, now);
    const roster = checkedRoster(event, teams, SQL_EVENT_LIMITS.maxTeams);
    const estimate =
      artifact.stateBudget.baseBytes + artifact.stateBudget.bytesPerTeam * roster.length;
    if (!Number.isSafeInteger(estimate) || estimate > SQL_COORDINATION_MAX_BYTES)
      throw new NativeCoordinationError(503, "coordination_state_budget_exceeded");
    for (let attempt = 0; attempt < 12; attempt++) {
      const prior = await this.readSnapshot(event.eventId, artifact.problemId);
      if (prior) {
        assertPin(prior, artifact);
        assertRoster(prior, roster);
        if (await this.commit([sqlIntakeGuard(), this.eventCheck(event, now), sqlHeadCheck(prior)]))
          return prior;
        await this.assertEventUnchanged(event, now);
        await this.backoff(attempt);
        continue;
      }
      const match = initializedMatch(artifact, roster, event.eventId);
      const run: NativeCoordinationRun = {
        eventId: event.eventId,
        problemId: artifact.problemId,
        runId: ulid(now),
        revision: 0,
        artifactDigest: artifact.artifactDigest,
        pluginKey: artifact.pluginKey,
        catalogKey: artifact.catalogKey,
        roster,
        match,
        clock: { pausedMs: 0, elapsedMs: 0 },
        closed: false,
        updatedAt: new Date(now).toISOString(),
      };
      const writes = [...this.snapshotWrites(run), ...this.scoreWrites(run, match.scores, now)];
      writes.push(sqlIntakeGuard(), this.eventCheck(event, now));
      if (
        event.status === "DRAFT" &&
        event.problems.every((problem) => problem.problemId === artifact.problemId)
      ) {
        writes.pop();
        writes.push(
          ...this.eventUpdate(event, {
            ...event,
            status: "READY",
            updatedAt: nextTime(event, now),
          }),
        );
      }
      if (await this.commit(writes)) return run;
      await this.assertEventUnchanged(event, now);
      await this.backoff(attempt);
    }
    throw new NativeCoordinationError(409, "coordination_conflict");
  }
  async request(input: RequestInput): Promise<NativeCoordinationResponse> {
    assertArtifact(input.artifact);
    assertSelected(input.event, input.artifact.problemId);
    if (input.team.eventId !== input.event.eventId)
      throw new NativeCoordinationError(401, "unauthorized");
    if (input.operation) validateOperation(input.operation);
    const bounded: BoundedRequest = { ...input, deadline: performance.now() + 20000 };
    for (let attempt = 0; attempt < 24; attempt++) {
      assertRequestBudget(bounded);
      const now = input.now();
      assertParticipantGate(input.event, now, input.operation !== undefined);
      const response = await this.tryRequest(bounded, now);
      if (response) return response;
      await this.assertActorUnchanged(input, now);
      await this.backoff(attempt);
    }
    throw new NativeCoordinationError(409, "coordination_conflict");
  }
  private async currentRun(input: RequestInput): Promise<StoredRun> {
    const run = await this.readSnapshot(input.event.eventId, input.artifact.problemId);
    if (!run) throw new NativeCoordinationError(409, "not_running");
    assertPin(run, input.artifact);
    if (input.operation) assertOperationRun(run, input.operation);
    if (!run.roster.some((team) => team.teamId === input.team.teamId))
      throw new NativeCoordinationError(401, "unauthorized");
    if (input.operation && run.closed) throw new NativeCoordinationError(422, "event_ended");
    return run;
  }
  private async tryRequest(input: BoundedRequest, now: number) {
    if (input.operation) {
      const head = await this.readHead(input.event.eventId, input.artifact.problemId);
      if (!head) throw new NativeCoordinationError(409, "not_running");
      assertOperationRun(head, input.operation);
      const replay = await this.readReceipt(head, input.team, input.operation);
      if (!replay) return this.withAdmission(input);
      const run = await this.currentRun(input);
      assertRequestBudget(input);
      return (await this.readAuthorization(input, run)) ? replay : undefined;
    }
    return this.requestOnce(input, await this.currentRun(input), now);
  }
  private async withAdmission(
    input: BoundedRequest,
  ): Promise<NativeCoordinationResponse | undefined> {
    const admission: Admission = { owner: randomUUID(), attempted: false, published: false };
    try {
      if (!(await this.acquireAdmission(input, admission))) return undefined;
      const run = await this.currentRun(input);
      const replay = input.operation
        ? await this.readReceipt(run, input.team, input.operation)
        : undefined;
      assertRequestBudget(input);
      if (replay) return (await this.readAuthorization(input, run)) ? replay : undefined;
      return await this.requestOnce(input, run, input.now(), admission);
    } finally {
      if (admission.attempted && !admission.published)
        await this.releaseAdmission(input, admission.owner);
    }
  }
  private async acquireAdmission(input: BoundedRequest, admission: Admission): Promise<boolean> {
    for (let attempt = 0; attempt < 64; attempt++) {
      assertRequestBudget(input);
      const head = await this.readHead(input.event.eventId, input.artifact.problemId);
      if (!head) throw new NativeCoordinationError(409, "not_running");
      if (input.operation) assertOperationRun(head, input.operation);
      const now = input.now();
      assertParticipantGate(input.event, now, input.operation !== undefined);
      if (head.closed) return false;
      if (head.admissionOwner && (head.admissionExpiresAt ?? Infinity) > now) {
        await this.backoff(attempt, true);
        continue;
      }
      admission.attempted = true;
      if (
        await this.commit([
          {
            sql: `UPDATE cloud_coordination_runs
            SET payload = json_set(payload, '$.admissionOwner', ?, '$.admissionExpiresAt', ?)
            WHERE event_id = ? AND problem_id = ?
              AND json_extract(payload, '$.runId') = ? AND json_extract(payload, '$.revision') = ?
              AND json_extract(payload, '$.closed') = 0
              AND json_extract(payload, '$.purge') IS NULL
              AND (json_extract(payload, '$.admissionOwner') IS NULL OR json_extract(payload, '$.admissionExpiresAt') <= ?)`,
            params: [
              admission.owner,
              now + 5000,
              head.eventId,
              head.problemId,
              head.runId,
              head.revision,
              now,
            ],
          },
          sqlChangesGuard(),
          this.eventCheck(input.event, now, true),
          this.teamCheck(input.team, now),
          sqlIntakeGuard(),
        ])
      )
        return true;
      await this.assertActorUnchanged(input, input.now());
      await this.backoff(attempt, true);
    }
    throw new NativeCoordinationError(409, "coordination_conflict");
  }

  private async releaseAdmission(input: RequestInput, owner: string): Promise<void> {
    await this.sql.run(
      `UPDATE cloud_coordination_runs
      SET payload = json_remove(payload, '$.admissionOwner', '$.admissionExpiresAt')
      WHERE event_id = ? AND problem_id = ? AND json_extract(payload, '$.admissionOwner') = ?
        AND json_extract(payload, '$.purge') IS NULL`,
      [input.event.eventId, input.artifact.problemId, owner],
    );
  }

  private async requestOnce(
    input: BoundedRequest,
    previous: StoredRun,
    now: number,
    admission?: Admission,
  ): Promise<NativeCoordinationResponse | undefined> {
    assertRequestBudget(input);
    now = input.now();
    assertParticipantGate(input.event, now, input.operation !== undefined);
    const elapsedMs = elapsed(input.event, previous, now);
    const frozen = previous.closed || input.event.scoringLocked;
    const move = input.operation
      ? { teamId: input.team.teamId, op: input.operation.op }
      : undefined;
    const transition: MatchTransition = frozen
      ? { match: previous.match, deltas: {} }
      : this.timed("reduce", () =>
          transitionMatch(
            input.artifact.plugin,
            previous.match,
            previous.roster.map((team) => team.teamId),
            elapsedMs,
            move,
          ),
        );
    const ending =
      closedStatuses.has(input.event.status) ||
      (input.event.endsAt !== undefined && now >= Date.parse(input.event.endsAt));
    let next: NativeCoordinationRun = {
      ...previous,
      match: transition.match,
      revision: transition.match.version,
      clock: { ...previous.clock, elapsedMs },
      closed: previous.closed || ending,
      updatedAt: new Date(now).toISOString(),
    };
    const changed =
      input.operation !== undefined ||
      next.closed !== previous.closed ||
      this.timed("compare", () => matchDigest(next.match) !== matchDigest(previous.match));
    if (!changed) {
      const response = projection(input.artifact, previous, input.team.teamId);
      assertRequestBudget(input);
      return (await this.readAuthorization(input, previous)) ? response : undefined;
    }
    if (!admission) return this.withAdmission(input);
    next = {
      ...next,
      revision: previous.revision + 1,
      match: { ...next.match, version: previous.revision + 1 },
    };
    const response: NativeCoordinationResponse =
      "rejection" in transition && transition.rejection
        ? { status: 422, body: { error: transition.rejection }, revision: next.revision }
        : projection(input.artifact, next, input.team.teamId);
    const writes = this.transitionWrites(
      next,
      previous,
      transition.deltas,
      now,
      admission.owner,
      0,
    );
    if (input.operation)
      writes.push(...this.receiptWrites(next, { ...input.operation, team: input.team, response }));
    assertRequestBudget(input);
    const commitAt = input.now();
    assertParticipantGate(input.event, commitAt, input.operation !== undefined);
    admissionCommitTime(writes, commitAt);
    writes.push(...this.requestGuards(input, previous, commitAt, false));
    if (!(await this.commit(writes))) return undefined;
    admission.published = true;
    return response;
  }
  async changeSchedule(input: ScheduleInput): Promise<EventRecord> {
    assertArtifact(input.artifact);
    assertSelected(input.event, input.artifact.problemId);
    const now = input.now();
    assertSchedule(input.event, input.patch, now);
    for (let attempt = 0; attempt < 24; attempt++) {
      const previous = await this.readSnapshot(input.event.eventId, input.artifact.problemId);
      const nextEvent: EventRecord = {
        ...input.event,
        ...defined(input.patch),
        updatedAt: nextTime(input.event, input.now()),
      };
      let writes: SqlStatement[];
      if (!previous) {
        writes = [
          sqlHeadAbsent(input.event.eventId, input.artifact.problemId),
          ...this.eventUpdate(input.event, nextEvent),
        ];
      } else {
        assertPin(previous, input.artifact);
        if (previous.closed && !input.close)
          throw new NativeCoordinationError(409, "coordination_run_closed");
        const advanced: MatchTransition =
          input.event.scoringLocked || previous.closed
            ? { match: previous.match, deltas: {} }
            : this.timed("reduce", () =>
                transitionMatch(
                  input.artifact.plugin,
                  previous.match,
                  previous.roster.map((team) => team.teamId),
                  elapsed(input.event, previous, input.now()),
                ),
              );
        const run: NativeCoordinationRun = {
          ...previous,
          match: { ...advanced.match, version: previous.revision + 1 },
          revision: previous.revision + 1,
          clock: scheduledClock(input.event, previous, input.patch, input.now()),
          closed: previous.closed || input.close === true,
          updatedAt: nextEvent.updatedAt,
        };
        writes = this.transitionWrites(run, previous, advanced.deltas, input.now());
        writes.push(...this.eventUpdate(input.event, nextEvent));
      }
      if (!input.close) writes.push(sqlIntakeGuard());
      if (await this.commit(writes)) return nextEvent;
      await this.assertEventUnchanged(input.event, input.now(), input.close);
      await this.backoff(attempt);
    }
    throw new NativeCoordinationError(409, "coordination_conflict");
  }
  async listScoreEvents(eventId: string, problemId: string, teamId: string, limit = 100) {
    coordinationHeadKey(eventId, problemId);
    id.parse(teamId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("Invalid native score history limit.");
    const rows = await this.sql.all(
      `SELECT payload FROM cloud_coordination_scores
      WHERE event_id = ? AND problem_id = ? ORDER BY revision DESC LIMIT ?`,
      [eventId, problemId, limit],
    );
    return rows.flatMap((raw) => {
      const row = z
        .object({
          eventId: id,
          problemId: z.string(),
          runId: id,
          deltas: z.record(z.number().finite()),
          occurredAt: z.string(),
        })
        .parse(sqlPayload(raw));
      if (row.eventId !== eventId || row.problemId !== problemId)
        throw new NativeCoordinationError(503, "coordination_scope_invalid");
      const points = row.deltas[teamId];
      return points
        ? [
            {
              jobId: row.runId,
              problemId,
              points,
              source: "coordination" as const,
              result: points > 0 ? ("ok" as const) : ("wrong" as const),
              occurredAt: row.occurredAt,
            },
          ]
        : [];
    });
  }

  private snapshotWrites(
    run: NativeCoordinationRun,
    previous?: StoredRun,
    owner?: string,
    atMs?: number,
  ): SqlStatement[] {
    const bytes = this.timed("encode", () => jsonBytes(run.match));
    if (bytes.byteLength > SQL_COORDINATION_MAX_BYTES)
      throw new NativeCoordinationError(503, "coordination_state_too_large");
    const fields = Object.fromEntries(
      Object.entries(run).filter(([key]) => key !== "match" && !key.startsWith("admission")),
    );
    const payload = JSON.stringify({
      ...fields,
      snapshotDigest: hash(bytes),
      byteLength: bytes.byteLength,
      chunkCount: 1,
    });
    if (!previous)
      return [
        {
          sql: "INSERT INTO cloud_coordination_runs (event_id, problem_id, payload, snapshot) VALUES (?, ?, ?, ?)",
          params: [run.eventId, run.problemId, payload, bytes.toString("utf8")],
        },
      ];
    return [
      {
        sql:
          `UPDATE cloud_coordination_runs SET payload = ?, snapshot = ?
        WHERE event_id = ? AND problem_id = ? AND json_extract(payload, '$.runId') = ?
          AND json_extract(payload, '$.revision') = ? AND json_extract(payload, '$.snapshotDigest') = ?
          AND json_extract(payload, '$.closed') = ?
          AND json_extract(payload, '$.purge') IS NULL
          AND COALESCE(json_extract(payload, '$.retiredRuns'), '[]') = ?` +
          (owner
            ? " AND json_extract(payload, '$.admissionOwner') = ? AND json_extract(payload, '$.admissionExpiresAt') > ?"
            : ""),
        params: [
          payload,
          bytes.toString("utf8"),
          run.eventId,
          run.problemId,
          previous.runId,
          previous.revision,
          previous.snapshotDigest,
          Number(previous.closed),
          JSON.stringify(previous.retiredRuns ?? []),
          ...(owner ? [owner, atMs ?? 0] : []),
        ],
      },
      sqlChangesGuard(),
    ];
  }

  private transitionWrites(
    run: NativeCoordinationRun,
    previous: StoredRun,
    deltas: Record<string, number>,
    now: number,
    owner?: string,
    atMs?: number,
  ): SqlStatement[] {
    return [
      ...this.snapshotWrites(run, previous, owner, atMs),
      ...this.scoreWrites(run, deltas, now),
    ];
  }

  private scoreWrites(
    run: NativeCoordinationRun,
    deltas: Record<string, number>,
    now: number,
  ): SqlStatement[] {
    const writes: SqlStatement[] = [];
    const changed = Object.entries(deltas).filter(([, value]) => value !== 0);
    for (const [teamId, delta] of changed)
      writes.push({
        sql: `INSERT INTO cloud_team_scores (event_id, team_id, payload) VALUES (?, ?, ?)
        ON CONFLICT (event_id, team_id) DO UPDATE SET payload = json_set(cloud_team_scores.payload,
          '$.score', COALESCE(json_extract(cloud_team_scores.payload, '$.score'), 0) + ?,
          '$.completedProblems', COALESCE(json_extract(cloud_team_scores.payload, '$.completedProblems'), 0))`,
        params: [
          run.eventId,
          teamId,
          JSON.stringify({ eventId: run.eventId, teamId, score: delta, completedProblems: 0 }),
          delta,
        ],
      });
    if (changed.length)
      writes.push({
        sql: "INSERT INTO cloud_coordination_scores (event_id, problem_id, revision, payload) VALUES (?, ?, ?, ?)",
        params: [
          run.eventId,
          run.problemId,
          run.revision,
          JSON.stringify({
            eventId: run.eventId,
            problemId: run.problemId,
            runId: run.runId,
            revision: run.revision,
            deltas: Object.fromEntries(changed),
            occurredAt: new Date(now).toISOString(),
          }),
        ],
      });
    return writes;
  }

  private async readAuthorization(input: RequestInput, run: StoredRun): Promise<boolean> {
    // Scalar subqueries share one SQLite read snapshot, including the installation fence.
    const row = await this.sql.get(
      `SELECT
      (SELECT payload FROM cloud_events WHERE event_id = ?) AS event,
      (SELECT payload FROM cloud_teams WHERE event_id = ? AND team_id = ?) AS team,
      (SELECT payload FROM cloud_coordination_runs WHERE event_id = ? AND problem_id = ?) AS head,
      (SELECT payload FROM cloud_installation_control WHERE id = 1) AS installation`,
      [input.event.eventId, input.event.eventId, input.team.teamId, run.eventId, run.problemId],
    );
    const now = input.now();
    assertParticipantGate(input.event, now, input.operation !== undefined);
    if (
      !row ||
      typeof row.event !== "string" ||
      typeof row.team !== "string" ||
      typeof row.head !== "string"
    )
      return false;
    const event = eventSchema.parse(JSON.parse(row.event) as unknown);
    const team = teamSchema.parse(JSON.parse(row.team) as unknown);
    const head = headSchema.parse(JSON.parse(row.head) as unknown);
    return (
      event.eventId === input.event.eventId &&
      event.updatedAt === input.event.updatedAt &&
      event.status === input.event.status &&
      event.expiresAt > Math.floor(now / 1000) &&
      team.eventId === input.event.eventId &&
      team.teamId === input.team.teamId &&
      team.authVersion === input.team.authVersion &&
      !team.accessRevoked &&
      team.expiresAt > Math.floor(now / 1000) &&
      head.eventId === run.eventId &&
      head.problemId === run.problemId &&
      head.runId === run.runId &&
      head.revision === run.revision &&
      head.snapshotDigest === run.snapshotDigest &&
      head.closed === run.closed &&
      head.purge === undefined &&
      ((!input.operation && run.closed) || row.installation == null)
    );
  }

  private requestGuards(
    input: RequestInput,
    run: StoredRun,
    now: number,
    head = true,
  ): SqlStatement[] {
    const writes = [this.eventCheck(input.event, now, true), this.teamCheck(input.team, now)];
    if (!run.closed || input.operation) writes.push(sqlIntakeGuard());
    if (head) writes.push(sqlHeadCheck(run));
    return writes;
  }
  private teamCheck(team: TeamRecord, now: number): SqlStatement {
    return sqlGuard(
      `EXISTS (SELECT 1 FROM cloud_teams WHERE event_id = ? AND team_id = ?
      AND json_extract(payload, '$.authVersion') = ? AND json_extract(payload, '$.accessRevoked') = 0
      AND json_extract(payload, '$.expiresAt') > ?)`,
      [team.eventId, team.teamId, team.authVersion, Math.floor(now / 1000)],
    );
  }

  private eventCheck(event: EventRecord, now: number, closedAllowed = false): SqlStatement {
    if (!closedAllowed) assertOpen(event, now);
    return sqlGuard(
      `EXISTS (SELECT 1 FROM cloud_events WHERE event_id = ?
      AND json_extract(payload, '$.updatedAt') = ? AND json_extract(payload, '$.status') = ?
      AND json_extract(payload, '$.expiresAt') > ?)`,
      [event.eventId, event.updatedAt, event.status, Math.floor(now / 1000)],
    );
  }

  private eventUpdate(previous: EventRecord, next: EventRecord): SqlStatement[] {
    return [
      {
        sql: `UPDATE cloud_events SET payload = json_patch(payload, ?)
        WHERE event_id = ? AND json_extract(payload, '$.updatedAt') = ? AND json_extract(payload, '$.status') = ?`,
        params: [
          JSON.stringify(
            defined({
              status: next.status,
              updatedAt: next.updatedAt,
              startsAt: next.startsAt,
              endsAt: next.endsAt,
              scoringLocked: next.scoringLocked,
              scoreboardFreezeMinutes: next.scoreboardFreezeMinutes,
            }),
          ),
          previous.eventId,
          previous.updatedAt,
          previous.status,
        ],
      },
      sqlChangesGuard(),
    ];
  }

  private async assertEventUnchanged(
    event: EventRecord,
    now: number,
    close = false,
  ): Promise<void> {
    const raw = await this.sql.get("SELECT payload FROM cloud_events WHERE event_id = ?", [
      event.eventId,
    ]);
    const current = raw ? eventSchema.parse(sqlPayload(raw)) : undefined;
    if (!current || current.updatedAt !== event.updatedAt || current.status !== event.status)
      throw new NativeCoordinationError(409, "event_changed");
    if (!close && current.expiresAt <= Math.floor(now / 1000))
      throw new NativeCoordinationError(409, "event_expired");
  }
  private async assertActorUnchanged(input: RequestInput, now: number): Promise<void> {
    const raw = await this.sql.get(
      "SELECT payload FROM cloud_teams WHERE event_id = ? AND team_id = ?",
      [input.event.eventId, input.team.teamId],
    );
    const team = raw ? teamSchema.parse(sqlPayload(raw)) : undefined;
    if (
      !team ||
      team.accessRevoked ||
      team.authVersion !== input.team.authVersion ||
      team.expiresAt <= Math.floor(now / 1000)
    )
      throw new NativeCoordinationError(401, "unauthorized");
    await this.assertEventUnchanged(input.event, now);
  }
  private receiptWrites(run: NativeCoordinationRun, receipt: Receipt): SqlStatement[] {
    const bytes = jsonBytes(receipt.response);
    if (bytes.byteLength > COORDINATION_MAX_BYTES)
      throw new NativeCoordinationError(503, "coordination_response_too_large");
    return [
      {
        sql: `INSERT INTO cloud_coordination_receipts
        (event_id, problem_id, run_id, team_id, operation_hash, payload, response) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        params: [
          run.eventId,
          run.problemId,
          run.runId,
          receipt.team.teamId,
          hash(receipt.key),
          JSON.stringify({
            runId: run.runId,
            revision: run.revision,
            requestHash: receipt.hash,
            snapshotDigest: hash(bytes),
            byteLength: bytes.byteLength,
          }),
          bytes.toString("utf8"),
        ],
      },
    ];
  }

  private async readReceipt(
    run: RunIdentity,
    team: TeamRecord,
    operation: Operation,
  ): Promise<NativeCoordinationResponse | undefined> {
    const raw = await this.sql.get(
      `SELECT payload, response FROM cloud_coordination_receipts
      WHERE event_id = ? AND problem_id = ? AND run_id = ? AND team_id = ? AND operation_hash = ?`,
      [run.eventId, run.problemId, run.runId, team.teamId, hash(operation.key)],
    );
    if (!raw) return undefined;
    const saved = z
      .object({
        runId: id,
        revision: z.number().int().nonnegative(),
        requestHash: digestSchema,
        snapshotDigest: digestSchema,
        byteLength: z.number().int().positive().max(COORDINATION_MAX_BYTES),
      })
      .parse(sqlPayload(raw));
    if (saved.requestHash !== operation.hash)
      throw new NativeCoordinationError(422, "idempotency_key_reused");
    if (saved.runId !== run.runId)
      throw new NativeCoordinationError(409, "coordination_run_changed");
    if (
      typeof raw.response !== "string" ||
      Buffer.byteLength(raw.response, "utf8") !== saved.byteLength ||
      hash(raw.response) !== saved.snapshotDigest
    )
      throw new NativeCoordinationError(503, "coordination_receipt_invalid");
    const response = z
      .object({
        status: z.union([z.literal(200), z.literal(422)]),
        body: z.object({ projection: z.unknown().optional(), error: z.string().optional() }),
        revision: z.number().int().nonnegative(),
      })
      .parse(JSON.parse(raw.response) as unknown);
    if (response.revision !== saved.revision)
      throw new NativeCoordinationError(503, "coordination_receipt_invalid");
    return response;
  }
}

function assertRequestBudget(input: BoundedRequest): void {
  if (performance.now() >= input.deadline)
    throw new NativeCoordinationError(409, "coordination_conflict");
}
async function pause(attempt: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, Math.min(40, 2 ** attempt) + randomInt(8)));
}

/** Timestamp ownership after snapshot/receipt encoding, immediately before publication. */
function admissionCommitTime(writes: SqlStatement[], now: number): void {
  const snapshot = writes[0];
  if (
    !snapshot?.sql.includes("json_extract(payload, '$.admissionExpiresAt') > ?") ||
    !snapshot.params
  )
    throw new Error("Missing native publication ownership predicate");
  writes[0] = { ...snapshot, params: [...snapshot.params.slice(0, -1), now] };
}
