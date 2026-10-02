import { randomInt, randomUUID } from "node:crypto";
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
import {
  type MatchTransition,
  transitionMatch,
} from "../../../../scripts/local-host/coordination-core.js";
import {
  assertPurgeManifest,
  type PurgeManifest,
  purgeRunReference,
} from "./coordination-purge.js";
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
import { scoreKey, teamGuard, type Write } from "./deployment-storage.js";
import {
  COORDINATION_CHUNK_BYTES,
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
import {
  assertDynamoPayloadAvailable,
  assertSnapshotScope,
  decodedChunks,
  dynamoCloseFence,
  dynamoHeadAbsent,
  dynamoHeadCheck,
  headSchema,
  historyKey,
  readDynamoSnapshot,
  type StoredRun,
  snapshotKey,
} from "./dynamodb-coordination-snapshot.js";
import { installationControlKey, installationIntakeGuard } from "./installation-control.js";

type CleanupOutcome = "done" | "page" | "conflict";

interface Admission {
  readonly owner: string;
  attempted: boolean;
  published: boolean;
}
type RunIdentity = Pick<NativeCoordinationRun, "eventId" | "problemId" | "runId">;
interface Operation {
  readonly runId?: string;
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
  async summary(
    eventId: string,
    problemId: string,
  ): Promise<NativeCoordinationSummary | undefined> {
    const raw = await this.get(coordinationHeadKey(eventId, problemId));
    if (!raw) return undefined;
    const head = headSchema.parse(raw);
    assertSnapshotScope(head, eventId, problemId);
    assertPurgeManifest(head);
    const run = head.purge ? head : await this.readSnapshot(eventId, problemId);
    if (!run) return undefined;
    return {
      eventId,
      problemId,
      runId: run.runId,
      revision: run.revision,
      closed: run.closed,
      ...(head.purge ? { purgeState: head.purge.state } : {}),
    };
  }
  /** Explicit event teardown removes private payloads; the verified closed HEAD never expires. */
  async purge(eventId: string, problemId: string): Promise<void> {
    coordinationHeadKey(eventId, problemId);
    const deadline = performance.now() + 15000;
    let conflicts = 0;
    while (conflicts < 12) {
      if (performance.now() >= deadline)
        throw new NativeCoordinationError(503, "coordination_purge_pending");
      const result = await this.purgeStep(eventId, problemId);
      if (result === "done") return;
      if (result === "conflict") await this.backoff(conflicts++);
    }
    throw new NativeCoordinationError(409, "coordination_purge_conflict");
  }
  private async purgeStep(eventId: string, problemId: string): Promise<CleanupOutcome> {
    const key = coordinationHeadKey(eventId, problemId);
    const raw = await this.get(key);
    if (!raw) return this.purgeAbsent(eventId, problemId);
    const head = headSchema.parse(raw);
    assertSnapshotScope(head, eventId, problemId);
    assertPurgeManifest(head);
    if (head.purge?.state === "complete") return "done";
    if (head.purge) return this.purgePage(head);
    return (await this.beginPurge(head.eventId, head.problemId)) ? "page" : "conflict";
  }
  private async purgeAbsent(eventId: string, problemId: string): Promise<CleanupOutcome> {
    const key = coordinationHeadKey(eventId, problemId);
    for (const prefix of ["SNAPSHOT#", "RUN#", "RECEIPT#"]) {
      const page = await this.ddb.send(
        new QueryCommand({
          TableName: this.tables.deployments,
          ConsistentRead: true,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
          ExpressionAttributeValues: { ":pk": key.PK, ":prefix": prefix },
          Limit: 1,
        }),
      );
      if (
        page.Items?.length ||
        (page.LastEvaluatedKey && Object.keys(page.LastEvaluatedKey).length)
      )
        throw new NativeCoordinationError(503, "coordination_purge_invalid");
    }
    return (await this.commit([dynamoHeadAbsent(this.tables.deployments, eventId, problemId)]))
      ? "done"
      : "conflict";
  }
  private async beginPurge(eventId: string, problemId: string): Promise<boolean> {
    if (await this.repository.installationControl()) {
      if (await this.purgeAdvanced(eventId, problemId)) return false;
      throw new NativeCoordinationError(409, "coordination_purge_intake_closed");
    }
    let run: StoredRun | undefined;
    try {
      run = await this.readSnapshot(eventId, problemId);
    } catch (error) {
      if (error instanceof NativeCoordinationError && error.code === "coordination_run_closed")
        return false;
      throw error;
    }
    if (!run) return false;
    if (!run.closed) throw new NativeCoordinationError(409, "coordination_not_settled");
    let references: PurgeManifest["runs"];
    try {
      references = await this.purgeReferences(run);
    } catch (error) {
      // Concurrent cleanup can remove history while it is being verified.
      // A durable marker or retirement change must explain that disappearance.
      if (await this.purgeAdvanced(eventId, problemId, run)) return false;
      throw error;
    }
    const head = headSchema.omit({ admissionOwner: true, admissionExpiresAt: true }).parse(run);
    const purge: PurgeManifest = { state: "pending", runs: references };
    assertPurgeManifest({ ...head, purge });
    const guard = dynamoHeadCheck(this.tables.deployments, head).ConditionCheck;
    if (!guard) throw new Error("Missing native close guard");
    return this.commit([
      {
        Put: {
          TableName: this.tables.deployments,
          Item: { ...head, ...coordinationHeadKey(eventId, problemId), purge },
          ConditionExpression:
            guard.ConditionExpression +
            (head.retiredRuns === undefined
              ? " AND attribute_not_exists(retiredRuns)"
              : " AND retiredRuns = :retiredRuns"),
          ExpressionAttributeNames: guard.ExpressionAttributeNames,
          ExpressionAttributeValues: {
            ...guard.ExpressionAttributeValues,
            ...(head.retiredRuns === undefined ? {} : { ":retiredRuns": head.retiredRuns }),
          },
        },
      },
      // Once global drain stops intake, its proof relies on closed retained
      // heads staying immutable. Already-recorded purge obligations still resume.
      installationIntakeGuard(this.tables.events),
    ]);
  }
  private async purgeReferences(run: StoredRun): Promise<PurgeManifest["runs"]> {
    const references = [purgeRunReference(run)];
    for (const runId of [...(run.history ?? []), ...(run.retiredRuns ?? [])]) {
      const retained = await readDynamoSnapshot(
        this.ddb,
        this.tables.deployments,
        run.eventId,
        run.problemId,
        this.timing,
        runId,
      );
      if (!retained?.closed) throw new NativeCoordinationError(503, "coordination_history_invalid");
      references.push(purgeRunReference(retained));
    }
    return references;
  }
  private async purgeAdvanced(
    eventId: string,
    problemId: string,
    previous?: StoredRun,
  ): Promise<boolean> {
    const raw = await this.get(coordinationHeadKey(eventId, problemId));
    if (!raw) return false;
    const head = headSchema.parse(raw);
    assertSnapshotScope(head, eventId, problemId);
    assertPurgeManifest(head);
    if (head.purge) return true;
    return (
      previous !== undefined &&
      head.runId === previous.runId &&
      head.revision === previous.revision &&
      head.snapshotDigest === previous.snapshotDigest &&
      JSON.stringify(head.retiredRuns) !== JSON.stringify(previous.retiredRuns)
    );
  }
  private async purgePage(head: z.infer<typeof headSchema>): Promise<CleanupOutcome> {
    const key = coordinationHeadKey(head.eventId, head.problemId);
    for (const prefix of ["SNAPSHOT#", "RUN#", "RECEIPT#"]) {
      // Re-read the first remaining page after each committed batch. The permanent
      // manifest keeps retries scoped even if the previous response was lost.
      const page = await this.ddb.send(
        new QueryCommand({
          TableName: this.tables.deployments,
          ConsistentRead: true,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
          ExpressionAttributeValues: { ":pk": key.PK, ":prefix": prefix },
          Limit: 80,
        }),
      );
      const rows = page.Items ?? [];
      if (!rows.length && page.LastEvaluatedKey && Object.keys(page.LastEvaluatedKey).length)
        throw new NativeCoordinationError(503, "coordination_purge_page_invalid");
      if (rows.length) {
        const deletes = rows.map((row) =>
          purgePayloadDelete(this.tables.deployments, key.PK, prefix, head.purge, row),
        );
        return (await this.commit([...deletes, dynamoHeadCheck(this.tables.deployments, head)]))
          ? "page"
          : "conflict";
      }
    }
    const guard = dynamoHeadCheck(this.tables.deployments, head).ConditionCheck;
    if (!guard || !head.purge) throw new Error("Missing native purge manifest");
    return (await this.commit([
      {
        Put: {
          TableName: this.tables.deployments,
          Item: { ...head, ...key, purge: { ...head.purge, state: "complete" } },
          ConditionExpression: guard.ConditionExpression,
          ExpressionAttributeNames: guard.ExpressionAttributeNames,
          ExpressionAttributeValues: guard.ExpressionAttributeValues,
        },
      },
    ]))
      ? "done"
      : "conflict";
  }
  async readRun(
    eventId: string,
    problemId: string,
    runId: string,
  ): Promise<NativeCoordinationRun | undefined> {
    id.parse(runId);
    const current = await this.readSnapshot(eventId, problemId);
    if (!current || current.runId === runId) return current;
    if (!current.history?.includes(runId)) return undefined;
    const retained = await readDynamoSnapshot(
      this.ddb,
      this.tables.deployments,
      eventId,
      problemId,
      this.timing,
      runId,
    );
    if (!retained) {
      const latest = await this.get(coordinationHeadKey(eventId, problemId));
      if (!latest) return undefined;
      const head = headSchema.parse(latest);
      assertSnapshotScope(head, eventId, problemId);
      if (!head.history?.includes(runId)) return undefined;
      throw new NativeCoordinationError(503, "coordination_history_invalid");
    }
    return retained;
  }
  async reset(input: NativeCoordinationResetInput): Promise<NativeCoordinationResetResult> {
    const { event, artifact, expectedRunId } = input;
    assertArtifact(artifact);
    assertSelected(event, artifact.problemId);
    assertResetOpen(event, input.now());
    id.parse(expectedRunId);
    await this.pruneHistory(event.eventId, artifact.problemId);
    const previous = await this.readSnapshot(event.eventId, artifact.problemId);
    if (!previous) throw new NativeCoordinationError(404, "coordination_not_initialized");
    if (previous.runId !== expectedRunId)
      throw new NativeCoordinationError(409, "run_rotation_conflict");
    const { run, deltas } = resetRun(previous, event, artifact, input.now());
    const fields = Object.fromEntries(
      Object.entries(previous).filter(([key]) => key !== "match" && !key.startsWith("admission")),
    );
    const writes = this.transitionWrites(run, previous, deltas, input.now());
    writes.push({
      Put: {
        TableName: this.tables.deployments,
        Item: {
          ...fields,
          ...historyKey(coordinationHeadKey(event.eventId, artifact.problemId).PK, previous.runId),
          closed: true,
        },
        ConditionExpression: "attribute_not_exists(PK)",
      },
    });
    const commitAt = input.now();
    assertResetOpen(event, commitAt);
    writes.push(this.eventCheck(event, commitAt), installationIntakeGuard(this.tables.events));
    if (!(await this.commit(writes)))
      throw new NativeCoordinationError(409, "run_rotation_conflict");
    await this.pruneHistory(event.eventId, artifact.problemId);
    return {
      eventId: event.eventId,
      problemId: artifact.problemId,
      runId: run.runId,
      previousRunId: previous.runId,
    };
  }
  /** The head keeps the deletion obligation until its private rows have actually gone. */
  async pruneHistory(eventId: string, problemId: string): Promise<void> {
    const key = coordinationHeadKey(eventId, problemId);
    const deadline = performance.now() + 15000;
    let conflicts = 0;
    while (conflicts < 12) {
      if (performance.now() >= deadline)
        throw new NativeCoordinationError(503, "coordination_history_cleanup_pending");
      const raw = await this.get(key);
      if (!raw) return;
      const head = headSchema.parse(raw);
      assertSnapshotScope(head, eventId, problemId);
      assertDynamoPayloadAvailable(head);
      const runId = pendingRetiredRun(head);
      if (!runId) return;
      const outcome = await this.pruneRun(head, runId);
      if (outcome === "done") return;
      if (outcome === "conflict") await this.backoff(conflicts++);
    }
    throw new NativeCoordinationError(409, "coordination_history_cleanup_conflict");
  }
  private async pruneRun(head: z.infer<typeof headSchema>, runId: string): Promise<CleanupOutcome> {
    const key = coordinationHeadKey(head.eventId, head.problemId);
    const manifestKey = historyKey(key.PK, runId);
    const saved = await this.get(manifestKey);
    if (!saved) {
      const latest = await this.get(key);
      if (latest) {
        const current = headSchema.parse(latest);
        assertSnapshotScope(current, head.eventId, head.problemId);
        if (!current.retiredRuns?.includes(runId)) return "page";
      }
      // Chunks, manifest and obligation clear in one transaction. A missing
      // manifest with a still-pending obligation is corruption, not cleanup.
      throw new NativeCoordinationError(503, "coordination_history_invalid");
    }
    const manifest = headSchema.parse(saved);
    assertSnapshotScope(manifest, head.eventId, head.problemId, runId);
    // Start each bounded page at the beginning. Interrupted deletions leave the
    // remaining rows available for the next call without a lossy cursor.
    // Full Query rows also bound each page to DynamoDB's 1 MiB read ceiling,
    // so even receipt chunks fit within the delete transaction's 4 MiB limit.
    const page = await this.ddb.send(
      new QueryCommand({
        TableName: this.tables.deployments,
        ConsistentRead: true,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: { ":pk": key.PK, ":prefix": `RECEIPT#${runId}#` },
        Limit: 80,
      }),
    );
    const receipts = page.Items ?? [];
    if (!receipts.length && page.LastEvaluatedKey && Object.keys(page.LastEvaluatedKey).length)
      throw new NativeCoordinationError(503, "coordination_history_page_invalid");
    const guard = {
      TableName: this.tables.deployments,
      Key: key,
      ConditionExpression:
        "contains(retiredRuns, :retired) AND runId <> :retired AND NOT contains(#history, :retired) AND attribute_not_exists(purge)",
      ExpressionAttributeNames: { "#history": "history" },
      ExpressionAttributeValues: { ":retired": runId },
    };
    if (receipts.length) {
      const deletes = receipts.map((row) =>
        retiredReceiptDelete(this.tables.deployments, key.PK, runId, row),
      );
      return (await this.commit([...deletes, { ConditionCheck: guard }])) ? "page" : "conflict";
    }
    const deletes: Write[] = Array.from({ length: manifest.chunkCount }, (_, index) => ({
      Delete: {
        TableName: this.tables.deployments,
        Key: snapshotKey(key.PK, index, manifest.snapshotLayout === "run" ? runId : undefined),
      },
    }));
    deletes.push({ Delete: { TableName: this.tables.deployments, Key: manifestKey } });
    return (await this.commit([
      ...deletes,
      { Update: { ...guard, UpdateExpression: "REMOVE retiredRuns" } },
    ]))
      ? "done"
      : "conflict";
  }
  /** Cleanup needs a complete, closed native snapshot, never merely an event status. */
  closeFence(eventId: string, problemId: string): Promise<Write> {
    return dynamoCloseFence(this.ddb, this.tables.deployments, eventId, problemId, this.timing);
  }
  private readSnapshot(eventId: string, problemId: string): Promise<StoredRun | undefined> {
    return readDynamoSnapshot(this.ddb, this.tables.deployments, eventId, problemId, this.timing);
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
    const roster = checkedRoster(event, teams, this.repository.eventLimits.maxTeams);
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
            dynamoHeadCheck(this.tables.deployments, prior),
          ])
        )
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
      const writes = [...this.snapshotWrites(run), ...this.scoreWrites(run, run.match.scores, now)];
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
    assertOperationRun(run, input.operation);
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
      assertDynamoPayloadAvailable(head);
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
    const key = coordinationHeadKey(input.event.eventId, input.artifact.problemId);
    for (let attempt = 0; attempt < 64; attempt++) {
      assertRequestBudget(input);
      const raw = await this.get(key);
      if (!raw) throw new NativeCoordinationError(409, "not_running");
      const head = headSchema.parse(raw);
      const now = input.now();
      assertSnapshotScope(head, input.event.eventId, input.artifact.problemId);
      assertDynamoPayloadAvailable(head);
      assertOperationRun(head, input.operation);
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
          dynamoHeadAbsent(this.tables.deployments, input.event.eventId, input.artifact.problemId),
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
        Item: {
          ...snapshotKey(key.PK, index, run.snapshotLayout === "run" ? run.runId : undefined),
          runId: run.runId,
          revision: run.revision,
          data,
        },
      },
    }));
    for (
      let index = chunks.length;
      index < (previous?.runId === run.runId ? previous.chunkCount : 0);
      index++
    )
      writes.push({
        Delete: {
          TableName: this.tables.deployments,
          Key: snapshotKey(key.PK, index, run.snapshotLayout === "run" ? run.runId : undefined),
        },
      });
    const owned = owner ? " AND admissionOwner = :owner AND admissionExpiresAt > :atMs" : "";
    const pruning =
      previous?.retiredRuns === undefined
        ? " AND attribute_not_exists(retiredRuns)"
        : " AND retiredRuns = :retiredRuns";
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
          ? "runId = :run AND revision = :revision AND snapshotDigest = :digest AND closed = :closed AND attribute_not_exists(purge)" +
            owned +
            pruning
          : "attribute_not_exists(PK)",
        ...(previous
          ? {
              ExpressionAttributeValues: {
                ":run": previous.runId,
                ":revision": previous.revision,
                ":digest": previous.snapshotDigest,
                ":closed": previous.closed,
                ...(previous.retiredRuns === undefined
                  ? {}
                  : { ":retiredRuns": previous.retiredRuns }),
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
    return [
      ...this.snapshotWrites(run, previous, owner, atMs),
      ...this.scoreWrites(run, deltas, now),
    ];
  }
  private scoreWrites(
    run: NativeCoordinationRun,
    deltas: Record<string, number>,
    now: number,
  ): Write[] {
    const writes: Write[] = [];
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
    if (head) writes.push(dynamoHeadCheck(this.tables.deployments, run));
    return writes;
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
    raw.closed === run.closed &&
    raw.purge === undefined
  );
}

function split(bytes: Uint8Array): Uint8Array[] {
  return Array.from(
    { length: Math.ceil(bytes.byteLength / COORDINATION_CHUNK_BYTES) },
    (_, index) =>
      bytes.slice(index * COORDINATION_CHUNK_BYTES, (index + 1) * COORDINATION_CHUNK_BYTES),
  );
}
function receiptKey(run: RunIdentity, team: TeamRecord, key: string) {
  return {
    PK: coordinationHeadKey(run.eventId, run.problemId).PK,
    SK: `RECEIPT#${run.runId}#${team.teamId}#${hash(key)}`,
  };
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

function pendingRetiredRun(head: z.infer<typeof headSchema>): string | undefined {
  const runId = head.retiredRuns?.[0];
  if (runId && (head.runId === runId || head.history?.includes(runId)))
    throw new NativeCoordinationError(503, "coordination_history_invalid");
  return runId;
}
function retiredReceiptDelete(
  table: string,
  PK: string,
  runId: string,
  row: Record<string, unknown>,
): Write {
  if (
    row.PK !== PK ||
    typeof row.SK !== "string" ||
    !row.SK.startsWith(`RECEIPT#${runId}#`) ||
    row.runId !== runId
  )
    throw new NativeCoordinationError(503, "coordination_scope_invalid");
  return { Delete: { TableName: table, Key: { PK, SK: row.SK } } };
}

function purgePayloadDelete(
  table: string,
  PK: string,
  prefix: string,
  purge: PurgeManifest | undefined,
  row: Record<string, unknown>,
): Write {
  if (!purge || row.PK !== PK || typeof row.SK !== "string" || !row.SK.startsWith(prefix))
    throw new NativeCoordinationError(503, "coordination_scope_invalid");
  const reference = purge.runs.find((run) => run.runId === row.runId);
  const snapshot = /^(?:RUN#([0-9A-HJKMNP-TV-Z]{26})#)?SNAPSHOT#([0-7])$/u.exec(row.SK);
  const history = /^RUN#([0-9A-HJKMNP-TV-Z]{26})#HEAD$/u.exec(row.SK);
  const receipt =
    /^RECEIPT#([0-9A-HJKMNP-TV-Z]{26})#[0-9A-HJKMNP-TV-Z]{26}#[a-f0-9]{64}(?:#[0-7])?$/u.exec(
      row.SK,
    );
  let valid = false;
  if (receipt) valid = receipt[1] === row.runId;
  else if (reference && snapshot) {
    const expectedRun = reference.snapshotLayout === "run" ? reference.runId : undefined;
    valid =
      Number(snapshot[2]) < reference.chunkCount &&
      snapshot[1] === expectedRun &&
      row.revision === reference.revision;
  } else if (reference && history) valid = history[1] === reference.runId;
  if (!valid) throw new NativeCoordinationError(503, "coordination_purge_invalid");
  return { Delete: { TableName: table, Key: { PK, SK: row.SK } } };
}
