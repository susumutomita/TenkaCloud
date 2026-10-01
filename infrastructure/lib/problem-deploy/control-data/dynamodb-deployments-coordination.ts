import { createHash, randomInt, randomUUID } from "node:crypto";
import {
  type DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactGetCommand,
  type TransactGetCommandOutput,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { z } from "zod";
import { pluginStateSchemaVersion } from "../../../../scripts/lib/coordination-state-schema.js";
import {
  createMatch,
  type LocalMatch,
  type MatchTransition,
  transitionMatch,
} from "../../../../scripts/local-host/coordination-core.js";
import { scoreKey, teamGuard, type Write } from "./deployment-storage.js";
import {
  COORDINATION_CHUNK_BYTES,
  COORDINATION_MAX_BYTES,
  coordinationHeadKey,
  type NativeCoordinationArtifact,
  NativeCoordinationError,
  type NativeCoordinationResponse,
  type NativeCoordinationRun,
  type NativeSchedulePatch,
} from "./domain/coordination.js";
import type { EventRecord } from "./domain/events.js";
import type { TeamRecord } from "./domain/teams.js";
import {
  type CloudTableNames,
  conflict,
  DynamoCloudRepository,
  eventKey,
  teamKey,
} from "./dynamodb-cloud-repository.js";
import { installationControlKey, installationIntakeGuard } from "./installation-control.js";

const id = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const headSchema = z.object({
  eventId: id,
  problemId: z.literal("ac26-crypto-battle"),
  runId: id,
  revision: z.number().int().nonnegative(),
  artifactDigest: digestSchema,
  pluginKey: z.string(),
  catalogKey: z.string(),
  roster: z
    .array(z.object({ teamId: id, teamName: z.string() }))
    .min(1)
    .max(48),
  clock: z.object({
    pausedMs: z.number().nonnegative(),
    elapsedMs: z.number().nonnegative(),
    lockedAt: z.number().optional(),
  }),
  closed: z.boolean(),
  admissionOwner: z.string().uuid().optional(),
  admissionExpiresAt: z.number().int().nonnegative().optional(),
  updatedAt: z.string().datetime(),
  snapshotDigest: digestSchema,
  byteLength: z.number().int().positive().max(COORDINATION_MAX_BYTES),
  chunkCount: z.number().int().positive().max(8),
});
const matchSchema = z.object({
  state: z.unknown().refine((value) => value !== undefined),
  matchSecret: z.string().regex(/^[a-f0-9]{64}$/u),
  version: z.number().int().nonnegative(),
  stateSchemaVersion: z.number().int().positive(),
  scores: z.record(z.number().finite()),
});
interface StoredRun extends NativeCoordinationRun {
  readonly admissionOwner?: string;
  readonly admissionExpiresAt?: number;
  readonly snapshotDigest: string;
  readonly chunkCount: number;
  readonly byteLength: number;
}
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
export interface CoordinationTiming {
  readonly phase: "decode" | "encode" | "compare" | "reduce" | "commit" | "backoff";
  readonly elapsedMs: number;
}
export interface CoordinationWriteMeasurement {
  readonly items: number;
  readonly maxItemBytes: number;
  readonly bytesUpperBound: number;
}
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const closedStatuses = new Set(["ENDED", "TEARDOWN", "ARCHIVED"]);

/** Exact native lifecycle; no CloudFormation job, account, TARGET row or process-local authority. */
export class DynamoDeploymentsCoordination {
  private readonly repository: DynamoCloudRepository;
  constructor(
    private readonly ddb: DynamoDBDocumentClient,
    private readonly tables: CloudTableNames,
    private readonly observe?: (measurement: CoordinationWriteMeasurement) => void,
    private readonly timing?: (sample: CoordinationTiming) => void,
  ) {
    this.repository = new DynamoCloudRepository(ddb, tables);
  }
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
  private async get(Key: Record<string, string>) {
    return (
      await this.ddb.send(
        new GetCommand({ TableName: this.tables.deployments, Key, ConsistentRead: true }),
      )
    ).Item;
  }
  private async commit(writes: Write[], onConflict?: (error: unknown) => void): Promise<boolean> {
    const measurement = measureWrites(writes);
    this.observe?.(measurement);
    if (
      measurement.items > 100 ||
      measurement.maxItemBytes > 400 * 1024 ||
      measurement.bytesUpperBound > 4 * 1024 * 1024
    )
      throw new NativeCoordinationError(503, "coordination_transaction_too_large");
    const start = performance.now();
    try {
      await this.ddb.send(new TransactWriteCommand({ TransactItems: writes }));
      return true;
    } catch (error) {
      if (conflict(error)) {
        onConflict?.(error);
        return false;
      }
      throw error;
    } finally {
      this.timing?.({ phase: "commit", elapsedMs: performance.now() - start });
    }
  }
  async read(eventId: string, problemId: string): Promise<NativeCoordinationRun | undefined> {
    return this.readSnapshot(eventId, problemId);
  }
  /** Cleanup needs a complete, closed native snapshot, never merely an event status. */
  async closeFence(eventId: string, problemId: string): Promise<Write> {
    const run = await this.readSnapshot(eventId, problemId);
    if (!run) return this.headAbsent(eventId, problemId);
    if (!run.closed) throw new NativeCoordinationError(409, "coordination_not_settled");
    return this.headCheck(run);
  }
  private async readSnapshot(eventId: string, problemId: string): Promise<StoredRun | undefined> {
    const key = coordinationHeadKey(eventId, problemId);
    for (let attempt = 0; attempt < 8; attempt++) {
      const raw = await this.get(key);
      if (!raw) return undefined;
      const head = headSchema.parse(raw);
      assertSnapshotScope(head, eventId, problemId);
      const values = await this.ddb.send(
        new TransactGetCommand({
          TransactItems: [
            ...Array.from({ length: head.chunkCount }, (_, index) => ({
              Get: { TableName: this.tables.deployments, Key: snapshotKey(key.PK, index) },
            })),
            { Get: { TableName: this.tables.deployments, Key: key } },
          ],
        }),
      );
      const after = headSchema.safeParse(values.Responses?.at(-1)?.Item);
      if (!after.success || after.data.chunkCount !== head.chunkCount) continue;
      // HEAD and every selected chunk share this transaction's snapshot. The first
      // read only sizes the transaction; an intervening admission or publication
      // does not invalidate an otherwise complete, internally consistent result.
      const current = after.data;
      assertSnapshotScope(current, eventId, problemId);
      const chunks = values.Responses?.slice(0, current.chunkCount).map((item) => item.Item) ?? [];
      const bytes = decodedChunks(chunks, current.runId, current.revision);
      if (
        !bytes ||
        bytes.byteLength !== current.byteLength ||
        hash(bytes) !== current.snapshotDigest
      ) {
        if (attempt < 7) continue;
        throw new NativeCoordinationError(503, "coordination_snapshot_invalid");
      }
      return this.timed("decode", () => parsedRun(current, bytes));
    }
    throw new NativeCoordinationError(409, "coordination_snapshot_changed");
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
    const roster = checkedRoster(event, teams);
    const estimate =
      artifact.stateBudget.baseBytes + artifact.stateBudget.bytesPerTeam * roster.length;
    if (!Number.isSafeInteger(estimate) || estimate > COORDINATION_MAX_BYTES)
      throw new NativeCoordinationError(503, "coordination_state_budget_exceeded");
    for (let attempt = 0; attempt < 12; attempt++) {
      const prior = await this.readSnapshot(event.eventId, artifact.problemId);
      if (prior) {
        assertPin(prior, artifact);
        assertRoster(prior, roster);
        if (
          await this.commit([
            installationIntakeGuard(this.tables.events),
            this.eventCheck(event, now),
            this.headCheck(prior),
          ])
        )
          return prior;
        await this.assertEventUnchanged(event, now);
        await this.backoff(attempt);
        continue;
      }
      const match = createMatch(artifact.plugin, {
        eventId: event.eventId,
        teamIds: roster.map((team) => team.teamId),
        teamNames: Object.fromEntries(roster.map((team) => [team.teamId, team.teamName])),
      });
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
      const writes = this.snapshotWrites(run);
      writes.push(installationIntakeGuard(this.tables.events), this.eventCheck(event, now));
      if (
        event.status === "DRAFT" &&
        event.problems.every((problem) => problem.problemId === artifact.problemId)
      ) {
        writes.pop();
        writes.push(
          this.eventUpdate(event, { ...event, status: "READY", updatedAt: nextTime(event, now) }),
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
    if (!run.roster.some((team) => team.teamId === input.team.teamId))
      throw new NativeCoordinationError(401, "unauthorized");
    if (input.operation && run.closed) throw new NativeCoordinationError(422, "event_ended");
    return run;
  }
  private async tryRequest(input: BoundedRequest, now: number) {
    if (input.operation) {
      const raw = await this.get(
        coordinationHeadKey(input.event.eventId, input.artifact.problemId),
      );
      if (!raw) throw new NativeCoordinationError(409, "not_running");
      const head = headSchema.parse(raw);
      assertSnapshotScope(head, input.event.eventId, input.artifact.problemId);
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
    const key = coordinationHeadKey(input.event.eventId, input.artifact.problemId);
    for (let attempt = 0; attempt < 64; attempt++) {
      assertRequestBudget(input);
      const raw = await this.get(key);
      if (!raw) throw new NativeCoordinationError(409, "not_running");
      const head = headSchema.parse(raw);
      const now = input.now();
      assertSnapshotScope(head, input.event.eventId, input.artifact.problemId);
      assertParticipantGate(input.event, now, input.operation !== undefined);
      if (head.closed) return false;
      if (head.admissionOwner && (head.admissionExpiresAt ?? Infinity) > now) {
        await this.backoff(attempt, true);
        continue;
      }
      admission.attempted = true;
      let headCollision = false;
      const claimed = await this.commit(
        [
          {
            Update: {
              TableName: this.tables.deployments,
              Key: key,
              UpdateExpression: "SET admissionOwner = :owner, admissionExpiresAt = :until",
              ConditionExpression:
                "runId = :run AND revision = :revision AND closed = :no AND (attribute_not_exists(admissionOwner) OR admissionExpiresAt <= :now)",
              ExpressionAttributeValues: {
                ":owner": admission.owner,
                ":until": now + 5000,
                ":run": head.runId,
                ":revision": head.revision,
                ":no": false,
                ":now": now,
              },
            },
          },
          this.eventCheck(input.event, now, true),
          teamGuard(this.tables.teams, input.team, now),
          installationIntakeGuard(this.tables.events),
        ],
        (error) => {
          headCollision = admissionHeadCollision(error);
        },
      );
      if (claimed) return true;
      // This is only a collision hint, never authorization. A retry must pass
      // all four guarded claim conditions before the reducer may run.
      if (!headCollision) await this.assertActorUnchanged(input, input.now());
      await this.backoff(attempt, true);
    }
    throw new NativeCoordinationError(409, "coordination_conflict");
  }
  private async releaseAdmission(input: RequestInput, owner: string): Promise<void> {
    try {
      await this.ddb.send(
        new UpdateCommand({
          TableName: this.tables.deployments,
          Key: coordinationHeadKey(input.event.eventId, input.artifact.problemId),
          UpdateExpression: "REMOVE admissionOwner, admissionExpiresAt",
          ConditionExpression: "admissionOwner = :owner",
          ExpressionAttributeValues: { ":owner": owner },
        }),
      );
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "ConditionalCheckFailedException")
        throw error;
    }
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
    writes.push(...this.requestGuards(input, previous, commitAt, false));
    admissionCommitTime(writes, commitAt);
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
      let writes: Write[];
      if (!previous) {
        writes = [
          this.headAbsent(input.event.eventId, input.artifact.problemId),
          this.eventUpdate(input.event, nextEvent),
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
        writes.push(this.eventUpdate(input.event, nextEvent));
      }
      if (!input.close) writes.push(installationIntakeGuard(this.tables.events));
      if (await this.commit(writes)) return nextEvent;
      await this.assertEventUnchanged(input.event, input.now(), input.close);
      await this.backoff(attempt);
    }
    throw new NativeCoordinationError(409, "coordination_conflict");
  }
  async listScoreEvents(eventId: string, problemId: string, teamId: string, limit = 100) {
    id.parse(teamId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("Invalid native score history limit.");
    const key = coordinationHeadKey(eventId, problemId);
    const output = await this.ddb.send(
      new QueryCommand({
        TableName: this.tables.deployments,
        ConsistentRead: true,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: { ":pk": key.PK, ":prefix": "SCORE#" },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    return (output.Items ?? []).flatMap((raw) => {
      const row = z
        .object({
          eventId: id,
          problemId: z.string(),
          runId: id,
          deltas: z.record(z.number().finite()),
          occurredAt: z.string(),
        })
        .parse(raw);
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
  ): Write[] {
    const bytes = this.timed("encode", () => jsonBytes(run.match));
    if (bytes.byteLength > COORDINATION_MAX_BYTES)
      throw new NativeCoordinationError(503, "coordination_state_too_large");
    const chunks = split(bytes);
    const key = coordinationHeadKey(run.eventId, run.problemId);
    const fields = Object.fromEntries(
      Object.entries(run).filter(([key]) => key !== "match" && !key.startsWith("admission")),
    );
    const writes: Write[] = chunks.map((data, index) => ({
      Put: {
        TableName: this.tables.deployments,
        Item: { ...snapshotKey(key.PK, index), runId: run.runId, revision: run.revision, data },
      },
    }));
    for (let index = chunks.length; index < (previous?.chunkCount ?? 0); index++)
      writes.push({
        Delete: { TableName: this.tables.deployments, Key: snapshotKey(key.PK, index) },
      });
    const owned = owner ? " AND admissionOwner = :owner AND admissionExpiresAt > :atMs" : "";
    writes.push({
      Put: {
        TableName: this.tables.deployments,
        Item: {
          ...fields,
          ...key,
          snapshotDigest: hash(bytes),
          byteLength: bytes.byteLength,
          chunkCount: chunks.length,
        },
        ConditionExpression: previous
          ? "runId = :run AND revision = :revision AND snapshotDigest = :digest AND closed = :closed" +
            owned
          : "attribute_not_exists(PK)",
        ...(previous
          ? {
              ExpressionAttributeValues: {
                ":run": previous.runId,
                ":revision": previous.revision,
                ":digest": previous.snapshotDigest,
                ":closed": previous.closed,
                ...(owner ? { ":owner": owner, ":atMs": atMs } : {}),
              },
            }
          : {}),
      },
    });
    return writes;
  }
  private transitionWrites(
    run: NativeCoordinationRun,
    previous: StoredRun,
    deltas: Record<string, number>,
    now: number,
    owner?: string,
    atMs?: number,
  ): Write[] {
    const writes = this.snapshotWrites(run, previous, owner, atMs);
    const changed = Object.entries(deltas).filter(([, value]) => value !== 0);
    for (const [teamId, delta] of changed)
      writes.push({
        Update: {
          TableName: this.tables.teams,
          Key: scoreKey(run.eventId, teamId),
          UpdateExpression:
            "SET eventId = :event, teamId = :team, completedProblems = if_not_exists(completedProblems, :zero) ADD score :delta",
          ExpressionAttributeValues: {
            ":event": run.eventId,
            ":team": teamId,
            ":zero": 0,
            ":delta": delta,
          },
        },
      });
    if (changed.length)
      writes.push({
        Put: {
          TableName: this.tables.deployments,
          Item: {
            PK: coordinationHeadKey(run.eventId, run.problemId).PK,
            SK: `SCORE#${String(run.revision).padStart(16, "0")}`,
            eventId: run.eventId,
            problemId: run.problemId,
            runId: run.runId,
            revision: run.revision,
            deltas: Object.fromEntries(changed),
            occurredAt: new Date(now).toISOString(),
          },
          ConditionExpression: "attribute_not_exists(PK)",
        },
      });
    return writes;
  }
  /** Read-only authorization has one atomic point without taking transaction write locks. */
  private async readAuthorization(input: RequestInput, run: StoredRun): Promise<boolean> {
    let values: TransactGetCommandOutput;
    try {
      values = await this.ddb.send(
        new TransactGetCommand({
          TransactItems: [
            { Get: { TableName: this.tables.events, Key: eventKey(input.event.eventId) } },
            {
              Get: {
                TableName: this.tables.teams,
                Key: teamKey(input.event.eventId, input.team.teamId),
              },
            },
            {
              Get: {
                TableName: this.tables.deployments,
                Key: coordinationHeadKey(run.eventId, run.problemId),
              },
            },
            { Get: { TableName: this.tables.events, Key: installationControlKey } },
          ],
        }),
      );
    } catch (error) {
      if (conflict(error)) return false;
      throw error;
    }
    const now = input.now();
    assertParticipantGate(input.event, now, input.operation !== undefined);
    const [event, team, head, installation] = values.Responses?.map((item) => item.Item) ?? [];
    return (
      readEventCurrent(event, input.event, now) &&
      readTeamCurrent(team, input.team, now) &&
      readHeadCurrent(head, run) &&
      ((!input.operation && run.closed) || installation === undefined)
    );
  }
  private requestGuards(input: RequestInput, run: StoredRun, now: number, head = true): Write[] {
    const writes = [
      this.eventCheck(input.event, now, true),
      teamGuard(this.tables.teams, input.team, now),
    ];
    if (!run.closed || input.operation) writes.push(installationIntakeGuard(this.tables.events));
    if (head) writes.push(this.headCheck(run));
    return writes;
  }
  private headCheck(run: StoredRun): Write {
    return {
      ConditionCheck: {
        TableName: this.tables.deployments,
        Key: coordinationHeadKey(run.eventId, run.problemId),
        ConditionExpression:
          "runId = :run AND revision = :revision AND snapshotDigest = :digest AND closed = :closed",
        ExpressionAttributeValues: {
          ":run": run.runId,
          ":revision": run.revision,
          ":digest": run.snapshotDigest,
          ":closed": run.closed,
        },
      },
    };
  }
  private eventCheck(event: EventRecord, now: number, closedAllowed = false): Write {
    if (!closedAllowed) assertOpen(event, now);
    return {
      ConditionCheck: {
        TableName: this.tables.events,
        Key: eventKey(event.eventId),
        ConditionExpression: "updatedAt = :at AND #status = :status AND expiresAt > :now",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":at": event.updatedAt,
          ":status": event.status,
          ":now": Math.floor(now / 1000),
        },
      },
    };
  }
  private eventUpdate(previous: EventRecord, next: EventRecord): Write {
    return {
      Update: {
        TableName: this.tables.events,
        Key: eventKey(previous.eventId),
        UpdateExpression:
          "SET " +
          Object.keys(
            defined({
              status: next.status,
              updatedAt: next.updatedAt,
              startsAt: next.startsAt,
              endsAt: next.endsAt,
              scoringLocked: next.scoringLocked,
              scoreboardFreezeMinutes: next.scoreboardFreezeMinutes,
            }),
          )
            .map((key) => `#${key} = :${key}`)
            .join(", "),
        ConditionExpression: "updatedAt = :previous AND #status = :previousStatus",
        ExpressionAttributeNames: Object.fromEntries(
          Object.keys(
            defined({
              status: next.status,
              updatedAt: next.updatedAt,
              startsAt: next.startsAt,
              endsAt: next.endsAt,
              scoringLocked: next.scoringLocked,
              scoreboardFreezeMinutes: next.scoreboardFreezeMinutes,
            }),
          ).map((key) => [`#${key}`, key]),
        ),
        ExpressionAttributeValues: {
          ...Object.fromEntries(
            Object.entries(
              defined({
                status: next.status,
                updatedAt: next.updatedAt,
                startsAt: next.startsAt,
                endsAt: next.endsAt,
                scoringLocked: next.scoringLocked,
                scoreboardFreezeMinutes: next.scoreboardFreezeMinutes,
              }),
            ).map(([key, value]) => [`:${key}`, value]),
          ),
          ":previous": previous.updatedAt,
          ":previousStatus": previous.status,
        },
      },
    };
  }
  private headAbsent(eventId: string, problemId: string): Write {
    return {
      ConditionCheck: {
        TableName: this.tables.deployments,
        Key: coordinationHeadKey(eventId, problemId),
        ConditionExpression: "attribute_not_exists(PK)",
      },
    };
  }
  private async assertEventUnchanged(
    event: EventRecord,
    now: number,
    close = false,
  ): Promise<void> {
    const current = await this.repository.getEvent(event.eventId);
    if (!current || current.updatedAt !== event.updatedAt || current.status !== event.status)
      throw new NativeCoordinationError(409, "event_changed");
    if (!close && current.expiresAt <= Math.floor(now / 1000))
      throw new NativeCoordinationError(409, "event_expired");
  }
  private async assertActorUnchanged(input: RequestInput, now: number): Promise<void> {
    const team = await this.repository.getTeam(input.event.eventId, input.team.teamId);
    if (
      !team ||
      team.accessRevoked ||
      team.authVersion !== input.team.authVersion ||
      team.expiresAt <= Math.floor(now / 1000)
    )
      throw new NativeCoordinationError(401, "unauthorized");
    await this.assertEventUnchanged(input.event, now);
  }
  private receiptWrites(run: NativeCoordinationRun, receipt: Receipt): Write[] {
    const bytes = jsonBytes(receipt.response);
    if (bytes.byteLength > COORDINATION_MAX_BYTES)
      throw new NativeCoordinationError(503, "coordination_response_too_large");
    const chunks = split(bytes);
    const key = receiptKey(run, receipt.team, receipt.key);
    return [
      ...chunks.map(
        (data, index): Write => ({
          Put: {
            TableName: this.tables.deployments,
            Item: {
              PK: key.PK,
              SK: `${key.SK}#${index}`,
              runId: run.runId,
              revision: run.revision,
              data,
            },
            ConditionExpression: "attribute_not_exists(PK)",
          },
        }),
      ),
      {
        Put: {
          TableName: this.tables.deployments,
          Item: {
            ...key,
            runId: run.runId,
            revision: run.revision,
            requestHash: receipt.hash,
            snapshotDigest: hash(bytes),
            byteLength: bytes.byteLength,
            chunkCount: chunks.length,
          },
          ConditionExpression: "attribute_not_exists(PK)",
        },
      },
    ];
  }
  private async readReceipt(
    run: RunIdentity,
    team: TeamRecord,
    operation: Operation,
  ): Promise<NativeCoordinationResponse | undefined> {
    const key = receiptKey(run, team, operation.key);
    const raw = await this.get(key);
    if (!raw) return undefined;
    const saved = z
      .object({
        runId: id,
        revision: z.number().int().nonnegative(),
        requestHash: digestSchema,
        snapshotDigest: digestSchema,
        byteLength: z.number().int().positive().max(COORDINATION_MAX_BYTES),
        chunkCount: z.number().int().positive().max(8),
      })
      .parse(raw);
    if (saved.requestHash !== operation.hash)
      throw new NativeCoordinationError(422, "idempotency_key_reused");
    if (saved.runId !== run.runId)
      throw new NativeCoordinationError(409, "coordination_run_changed");
    const result = await this.ddb.send(
      new TransactGetCommand({
        TransactItems: Array.from({ length: saved.chunkCount }, (_, index) => ({
          Get: {
            TableName: this.tables.deployments,
            Key: { PK: key.PK, SK: `${key.SK}#${index}` },
          },
        })),
      }),
    );
    const bytes = decodedChunks(
      result.Responses?.map((value) => value.Item) ?? [],
      saved.runId,
      saved.revision,
    );
    if (!bytes || bytes.byteLength !== saved.byteLength || hash(bytes) !== saved.snapshotDigest)
      throw new NativeCoordinationError(503, "coordination_receipt_invalid");
    return z
      .object({
        status: z.union([z.literal(200), z.literal(422)]),
        body: z.object({ projection: z.unknown().optional(), error: z.string().optional() }),
        revision: z.number(),
      })
      .parse(JSON.parse(bytes.toString("utf8")) as unknown);
  }
}

function assertRequestBudget(input: BoundedRequest): void {
  if (performance.now() >= input.deadline)
    throw new NativeCoordinationError(409, "coordination_conflict");
}

function admissionHeadCollision(error: unknown): boolean {
  const parsed = z
    .object({
      name: z.literal("TransactionCanceledException"),
      CancellationReasons: z.tuple([
        z.object({ Code: z.literal("ConditionalCheckFailed") }),
        z.object({ Code: z.literal("None") }),
        z.object({ Code: z.literal("None") }),
        z.object({ Code: z.literal("None") }),
      ]),
    })
    .safeParse(error);
  return parsed.success;
}

function admissionCommitTime(writes: readonly Write[], now: number): void {
  const manifest = writes.find((write) => write.Put?.Item?.SK === "HEAD")?.Put;
  if (!manifest?.ExpressionAttributeValues) throw new Error("Missing native publication manifest");
  manifest.ExpressionAttributeValues[":atMs"] = now;
}

function readEventCurrent(
  raw: Record<string, unknown> | undefined,
  event: EventRecord,
  now: number,
): boolean {
  return (
    raw?.updatedAt === event.updatedAt &&
    raw.status === event.status &&
    typeof raw.expiresAt === "number" &&
    raw.expiresAt > Math.floor(now / 1000)
  );
}
function readTeamCurrent(
  raw: Record<string, unknown> | undefined,
  team: TeamRecord,
  now: number,
): boolean {
  return (
    raw?.authVersion === team.authVersion &&
    raw.accessRevoked === false &&
    typeof raw.expiresAt === "number" &&
    raw.expiresAt > Math.floor(now / 1000)
  );
}
function readHeadCurrent(raw: Record<string, unknown> | undefined, run: StoredRun): boolean {
  return (
    raw?.runId === run.runId &&
    raw.revision === run.revision &&
    raw.snapshotDigest === run.snapshotDigest &&
    raw.closed === run.closed
  );
}

function assertSnapshotScope(
  head: z.infer<typeof headSchema>,
  eventId: string,
  problemId: string,
): void {
  if (head.eventId !== eventId || head.problemId !== problemId)
    throw new NativeCoordinationError(503, "coordination_scope_invalid");
}

function parsedRun(head: z.infer<typeof headSchema>, bytes: Buffer): StoredRun {
  const parsed = matchSchema.parse(JSON.parse(bytes.toString("utf8")) as unknown);
  const match = { ...parsed, state: parsed.state };
  if (match.version !== head.revision)
    throw new NativeCoordinationError(503, "coordination_snapshot_invalid");
  return { ...head, match };
}

function jsonBytes(value: unknown): Buffer {
  const text = JSON.stringify(value, (_key, item: unknown) => {
    if (
      (typeof item === "number" && !Number.isFinite(item)) ||
      ["bigint", "function", "symbol"].includes(typeof item)
    )
      throw new NativeCoordinationError(503, "coordination_state_invalid");
    return item;
  });
  if (text === undefined) throw new NativeCoordinationError(503, "coordination_state_invalid");
  return Buffer.from(text, "utf8");
}
function split(bytes: Uint8Array): Uint8Array[] {
  return Array.from(
    { length: Math.ceil(bytes.byteLength / COORDINATION_CHUNK_BYTES) },
    (_, index) =>
      bytes.slice(index * COORDINATION_CHUNK_BYTES, (index + 1) * COORDINATION_CHUNK_BYTES),
  );
}
function snapshotKey(PK: string, index: number) {
  return { PK, SK: `SNAPSHOT#${index}` };
}
function decodedChunks(
  rows: readonly (Record<string, unknown> | undefined)[],
  runId: string,
  revision: number,
): Buffer | undefined {
  const values: Uint8Array[] = [];
  for (const row of rows) {
    if (
      row?.runId !== runId ||
      row.revision !== revision ||
      !(row.data instanceof Uint8Array) ||
      row.data.byteLength > COORDINATION_CHUNK_BYTES
    )
      return undefined;
    values.push(row.data);
  }
  return Buffer.concat(values);
}
function assertArtifact(artifact: NativeCoordinationArtifact): void {
  coordinationHeadKey("00000000000000000000000000", artifact.problemId);
  digestSchema.parse(artifact.artifactDigest);
  if (
    artifact.pluginKey !== `plugins/${artifact.artifactDigest}.mjs` ||
    !/^catalogs\/[a-f0-9]{64}\.json$/u.test(artifact.catalogKey)
  )
    throw new NativeCoordinationError(503, "coordination_artifact_invalid");
  if (
    !Number.isSafeInteger(artifact.stateBudget.bytesPerTeam) ||
    artifact.stateBudget.bytesPerTeam < 1 ||
    !Number.isSafeInteger(artifact.stateBudget.baseBytes) ||
    artifact.stateBudget.baseBytes < 0
  )
    throw new NativeCoordinationError(503, "coordination_state_budget_invalid");
}
function assertPin(run: NativeCoordinationRun, artifact: NativeCoordinationArtifact): void {
  if (
    run.artifactDigest !== artifact.artifactDigest ||
    run.pluginKey !== artifact.pluginKey ||
    run.catalogKey !== artifact.catalogKey ||
    run.match.stateSchemaVersion !== pluginStateSchemaVersion(artifact.plugin)
  )
    throw new NativeCoordinationError(409, "coordination_artifact_changed");
}
function assertSelected(event: EventRecord, problemId: string): void {
  if (!event.problems.some((problem) => problem.problemId === problemId))
    throw new NativeCoordinationError(404, "coordination_not_configured");
}
function assertOpen(event: EventRecord, now: number): void {
  if (
    !["DRAFT", "DEPLOYING", "READY"].includes(event.status) ||
    event.expiresAt <= Math.floor(now / 1000)
  )
    throw new NativeCoordinationError(409, "event_closed");
}
function checkedRoster(event: EventRecord, teams: readonly TeamRecord[]) {
  if (
    teams.length !== event.teamCount ||
    teams.length < 1 ||
    teams.length > 48 ||
    new Set(teams.map((team) => team.teamId)).size !== teams.length ||
    teams.some((team) => team.eventId !== event.eventId)
  )
    throw new NativeCoordinationError(409, "coordination_roster_invalid");
  return teams
    .map((team) => ({ teamId: team.teamId, teamName: team.displayName ?? team.internalSlug }))
    .sort((a, b) => a.teamId.localeCompare(b.teamId));
}
function assertRoster(run: NativeCoordinationRun, roster: NativeCoordinationRun["roster"]): void {
  if (
    JSON.stringify(run.roster.map((team) => team.teamId)) !==
    JSON.stringify(roster.map((team) => team.teamId))
  )
    throw new NativeCoordinationError(409, "coordination_roster_changed");
}
function assertParticipantGate(event: EventRecord, now: number, move: boolean): void {
  if (!event.startsAt || now < Date.parse(event.startsAt))
    throw new NativeCoordinationError(
      move ? 422 : 409,
      move ? "event_ended" : "scoring_not_started",
    );
  if (
    move &&
    (closedStatuses.has(event.status) ||
      (event.endsAt !== undefined && now >= Date.parse(event.endsAt)))
  )
    throw new NativeCoordinationError(422, "event_ended");
  if (move && event.scoringLocked) throw new NativeCoordinationError(422, "scoring_locked");
}
function validateOperation(operation: Operation): void {
  if (!/^[A-Za-z0-9_-]{8,128}$/u.test(operation.key) || !/^[a-f0-9]{64}$/u.test(operation.hash))
    throw new NativeCoordinationError(400, "invalid_operation_key");
}
function receiptKey(run: RunIdentity, team: TeamRecord, key: string) {
  return {
    PK: coordinationHeadKey(run.eventId, run.problemId).PK,
    SK: `RECEIPT#${run.runId}#${team.teamId}#${hash(key)}`,
  };
}
function projection(
  artifact: NativeCoordinationArtifact,
  run: NativeCoordinationRun,
  teamId: string,
): NativeCoordinationResponse {
  return {
    status: 200,
    body: { projection: artifact.plugin.projectForTeam(structuredClone(run.match.state), teamId) },
    revision: run.revision,
  };
}
function matchDigest(match: LocalMatch): string {
  return hash(
    jsonBytes({
      state: match.state,
      stateSchemaVersion: match.stateSchemaVersion,
      matchSecret: match.matchSecret,
      scores: match.scores,
    }),
  );
}
function elapsed(event: EventRecord, run: NativeCoordinationRun, now: number): number {
  const start = Date.parse(event.startsAt ?? new Date(now).toISOString());
  const end = Math.min(
    now,
    event.endsAt ? Date.parse(event.endsAt) : Infinity,
    event.scoringLocked ? (run.clock.lockedAt ?? now) : Infinity,
  );
  return Math.max(run.clock.elapsedMs, Math.max(0, end - start - run.clock.pausedMs));
}
function scheduledClock(
  event: EventRecord,
  run: NativeCoordinationRun,
  patch: NativeSchedulePatch,
  now: number,
): NativeCoordinationRun["clock"] {
  let pausedMs = run.clock.pausedMs;
  let lockedAt = run.clock.lockedAt;
  if (patch.scoringLocked === true && !event.scoringLocked) lockedAt = now;
  if (patch.scoringLocked === false && event.scoringLocked && lockedAt !== undefined) {
    pausedMs += Math.max(
      0,
      Math.min(now, event.endsAt ? Date.parse(event.endsAt) : Infinity) -
        Math.max(lockedAt, Date.parse(event.startsAt ?? new Date(now).toISOString())),
    );
    lockedAt = undefined;
  }
  return {
    pausedMs,
    ...(lockedAt === undefined ? {} : { lockedAt }),
    elapsedMs: elapsed(event, run, now),
  };
}
function assertSchedule(event: EventRecord, patch: NativeSchedulePatch, now: number): void {
  if (
    event.startsAt &&
    Date.parse(event.startsAt) <= now &&
    patch.startsAt !== undefined &&
    patch.startsAt !== event.startsAt
  )
    throw new NativeCoordinationError(409, "coordination_start_already_fixed");
  if (event.status === "ARCHIVED") throw new NativeCoordinationError(409, "event_closed");
}
function nextTime(event: EventRecord, now: number): string {
  return new Date(Math.max(now, Date.parse(event.updatedAt) + 1)).toISOString();
}
function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Partial<T>;
}
function itemBytes(value: unknown): number {
  if (value instanceof Uint8Array) return value.byteLength;
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  if (typeof value === "number") return Buffer.byteLength(String(value), "utf8") + 1;
  if (typeof value === "boolean" || value === null) return 1;
  if (Array.isArray(value)) return 3 + value.reduce((sum, item) => sum + 1 + itemBytes(item), 0);
  if (value && typeof value === "object")
    return (
      3 +
      Object.entries(value).reduce(
        (sum, [key, item]) => sum + Buffer.byteLength(key, "utf8") + 1 + itemBytes(item),
        0,
      )
    );
  return 0;
}
function measureWrites(writes: readonly Write[]): CoordinationWriteMeasurement {
  const sizes = writes.map((write) => {
    if (write.Put) return itemBytes(write.Put.Item);
    const allowance = write.ConditionCheck ? 32 * 1024 : 4 * 1024;
    return (
      itemBytes(write.Update?.Key ?? write.Delete?.Key ?? write.ConditionCheck?.Key) + allowance
    );
  });
  return {
    items: writes.length,
    maxItemBytes: Math.max(0, ...sizes),
    bytesUpperBound: sizes.reduce((sum, value) => sum + value, 0),
  };
}
async function pause(attempt: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, Math.min(40, 2 ** attempt) + randomInt(8)));
}
