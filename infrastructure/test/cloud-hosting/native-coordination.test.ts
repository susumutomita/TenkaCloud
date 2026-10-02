import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  ScanCommand,
  TransactGetCommand,
  type TransactGetCommandInput,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostPlugin } from "../../../scripts/local-host/coordination-core.js";
import { scoreKey, type Write } from "../../lib/problem-deploy/control-data/deployment-storage.js";
import {
  COORDINATION_CHUNK_BYTES,
  COORDINATION_MAX_BYTES,
  coordinationHeadKey,
  type NativeCoordinationArtifact,
} from "../../lib/problem-deploy/control-data/domain/coordination.js";
import { contentDigest } from "../../lib/problem-deploy/control-data/domain/deployment-work.js";
import type { EventRecord } from "../../lib/problem-deploy/control-data/domain/events.js";
import type { TeamRecord } from "../../lib/problem-deploy/control-data/domain/teams.js";
import {
  DynamoCloudRepository,
  eventKey,
  teamKey,
} from "../../lib/problem-deploy/control-data/dynamodb-cloud-repository.js";
import { DynamoDeploymentWork } from "../../lib/problem-deploy/control-data/dynamodb-deployment-work.js";
import {
  type CoordinationTiming,
  type CoordinationWriteMeasurement,
  DynamoDeploymentsCoordination,
} from "../../lib/problem-deploy/control-data/dynamodb-deployments-coordination.js";
import {
  type InstallationScope,
  installationControlKey,
  installationScopeDigest,
} from "../../lib/problem-deploy/control-data/installation-control.js";
import { requestEventTeardown } from "../../lib/problem-deploy/handlers/cloud-api/deployment-routes.js";
import { createProductionNativeCoordination } from "../../lib/problem-deploy/handlers/cloud-api/native-production.js";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const AT = new Date(NOW).toISOString();
const clients: DynamoDBClient[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) client.destroy();
});
type Row = Record<string, unknown>;
type ReadItems = NonNullable<TransactGetCommandInput["TransactItems"]>;
function isAuthorizationRead(items: ReadItems): boolean {
  return items.some((item) => item.Get?.TableName === "teams");
}
interface State {
  padding: string;
  scores: Record<string, number>;
}
const rowKey = (table: string | undefined, key: Row | undefined) =>
  JSON.stringify([table, key?.PK, key?.SK]);
function cancelled() {
  return Object.assign(new Error("synthetic conditional conflict"), {
    name: "TransactionCanceledException",
    CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
  });
}
function admissionClaim(items: Write[]) {
  return items.find((item) => item.Update?.UpdateExpression?.includes("SET admissionOwner"))
    ?.Update;
}
function admissionPublication(items: Write[]) {
  return items.find((item) => item.Put?.ConditionExpression?.includes("admissionOwner = :owner"))
    ?.Put;
}
function checkAdmissionGuard(
  rows: Map<string, Row>,
  guard: NonNullable<Write["ConditionCheck"]>,
): void {
  const current = rows.get(rowKey(guard.TableName, guard.Key));
  const expected = guard.ExpressionAttributeValues ?? {};
  if (guard.Key?.PK === "INSTALLATION" && current) throw cancelled();
  if (
    guard.Key?.SK === "META" &&
    (current?.updatedAt !== expected[":at"] || current?.status !== expected[":status"])
  )
    throw cancelled();
  if (
    guard.TableName === "teams" &&
    (current?.authVersion !== expected[":version"] ||
      current?.accessRevoked ||
      Number(current?.expiresAt) <= Number(expected[":now"]))
  )
    throw cancelled();
}
/** Evaluates just the admission conditions under test; other SDK contracts are asserted separately. */
function checkAdmissionConditions(rows: Map<string, Row>, items: Write[]): void {
  const claim = admissionClaim(items);
  const publication = admissionPublication(items);
  const manifest = claim ?? publication;
  if (!manifest) return;
  const head = rows.get(rowKey(manifest.TableName, claim?.Key ?? publication?.Item));
  const values = manifest.ExpressionAttributeValues ?? {};
  if (!head || head.runId !== values[":run"] || head.revision !== values[":revision"])
    throw cancelled();
  if (claim) checkClaimHead(head, values);
  if (
    publication &&
    (head.admissionOwner !== values[":owner"] ||
      Number(head.admissionExpiresAt) <= Number(values[":atMs"]))
  )
    throw cancelled();
  for (const item of items) if (item.ConditionCheck) checkAdmissionGuard(rows, item.ConditionCheck);
}
function checkClaimHead(head: Row, values: Row): void {
  if (
    head.closed ||
    head.purge ||
    (head.admissionOwner && Number(head.admissionExpiresAt) > Number(values[":now"]))
  )
    throw cancelled();
}
function checkHeadPublication(
  rows: Map<string, Row>,
  put: NonNullable<Write["Put"] | Write["ConditionCheck"]>,
): void {
  const current = rows.get(rowKey(put.TableName, "Item" in put ? put.Item : put.Key));
  if (put.ConditionExpression === "attribute_not_exists(PK)") {
    if (current) throw cancelled();
    return;
  }
  const values = put.ExpressionAttributeValues ?? {};
  if (
    !current ||
    current.runId !== values[":run"] ||
    current.revision !== values[":revision"] ||
    current.snapshotDigest !== values[":digest"] ||
    current.closed !== values[":closed"]
  )
    throw cancelled();
  checkPurgeCondition(current, put.ConditionExpression ?? "", values);
  if (
    (put.ConditionExpression?.includes("attribute_not_exists(retiredRuns)") &&
      current.retiredRuns !== undefined) ||
    (put.ConditionExpression?.includes("retiredRuns = :retiredRuns") &&
      JSON.stringify(current.retiredRuns) !== JSON.stringify(values[":retiredRuns"]))
  )
    throw cancelled();
}
function checkPurgeCondition(current: Row, expression: string, values: Row): void {
  if (
    ((expression.includes("attribute_not_exists(purge)") ||
      expression.includes("attribute_not_exists(#purge)")) &&
      current.purge !== undefined) ||
    (expression.includes("#purge = :purge") && !isDeepStrictEqual(current.purge, values[":purge"]))
  )
    throw cancelled();
}
function checkRetirementGuard(
  rows: Map<string, Row>,
  guard: NonNullable<Write["ConditionCheck"] | Write["Update"]>,
): void {
  const head = rows.get(rowKey(guard.TableName, guard.Key));
  const retired = guard.ExpressionAttributeValues?.[":retired"];
  if (
    !(head?.retiredRuns as unknown[] | undefined)?.includes(retired) ||
    head?.runId === retired ||
    (head?.history as unknown[] | undefined)?.includes(retired) ||
    (guard.ConditionExpression?.includes("attribute_not_exists(purge)") &&
      head?.purge !== undefined)
  )
    throw cancelled();
}
function checkLifecycleHeadGuard(rows: Map<string, Row>, guard: Write["ConditionCheck"]): void {
  if (guard?.Key?.SK !== "HEAD") return;
  if (
    guard.ConditionExpression?.startsWith("runId = :run") ||
    guard.ConditionExpression === "attribute_not_exists(PK)"
  )
    checkHeadPublication(rows, guard);
}
/** Narrow SDK fake: native HEAD/purge CAS, immutable archive and retirement guards only. */
function checkLifecycleConditions(rows: Map<string, Row>, items: Write[]): void {
  for (const item of items) {
    if (item.Put?.Item?.SK === "HEAD") checkHeadPublication(rows, item.Put);
    checkLifecycleHeadGuard(rows, item.ConditionCheck);
    if (
      String(item.Put?.Item?.SK).match(/^RUN#.+#HEAD$/u) &&
      rows.has(rowKey(item.Put?.TableName, item.Put?.Item))
    )
      throw cancelled();
    const guard = item.ConditionCheck ?? item.Update;
    if (guard?.ConditionExpression?.includes("contains(retiredRuns"))
      checkRetirementGuard(rows, guard);
  }
  checkLifecycleExternalGuards(rows, items);
}
function checkLifecycleExternalGuards(rows: Map<string, Row>, items: Write[]): void {
  if (!resetPublication(items) && !purgePublication(items, "pending")) return;
  for (const item of items) if (item.ConditionCheck) checkAdmissionGuard(rows, item.ConditionCheck);
}
function applyOwnedRelease(rows: Map<string, Row>, command: UpdateCommand): void {
  const current = rows.get(rowKey(command.input.TableName, command.input.Key));
  if (current?.admissionOwner !== command.input.ExpressionAttributeValues?.[":owner"])
    throw Object.assign(new Error("Owned release lost ownership"), {
      name: "ConditionalCheckFailedException",
    });
  applyRecordedUpdate(rows, command.input);
}
function applyRecordedWrite(rows: Map<string, Row>, item: Write): void {
  if (item.Put?.Item)
    rows.set(rowKey(item.Put.TableName, item.Put.Item), structuredClone(item.Put.Item));
  if (item.Delete) rows.delete(rowKey(item.Delete.TableName, item.Delete.Key));
  if (item.Update) applyRecordedUpdate(rows, item.Update);
}
function applyRecordedTransaction(rows: Map<string, Row>, items: Write[]): void {
  for (const item of items) applyRecordedWrite(rows, item);
}
function applyRecordedUpdate(rows: Map<string, Row>, update: UpdateCommand["input"]): void {
  const key = rowKey(update.TableName, update.Key);
  const previous = rows.get(key) ?? {};
  const values = update.ExpressionAttributeValues ?? {};
  if (":delta" in values) {
    rows.set(key, {
      ...previous,
      ...update.Key,
      eventId: values[":event"],
      teamId: values[":team"],
      score: Number(previous.score ?? 0) + Number(values[":delta"]),
      completedProblems: previous.completedProblems ?? 0,
    });
    return;
  }
  const expression = update.UpdateExpression ?? "";
  const removed = expression.startsWith("REMOVE ")
    ? expression
        .slice(7)
        .split(",")
        .map((name) => name.trim())
    : [];
  const next = Object.fromEntries(
    Object.entries(previous).filter(([name]) => !removed.includes(name)),
  );
  const assignments = expression.startsWith("SET ") ? expression.slice(4).split(",") : [];
  for (const assignment of assignments) {
    const [name, token] = assignment.split("=").map((part) => part.trim());
    if (!name || !token || !Object.hasOwn(values, token)) continue;
    const field = update.ExpressionAttributeNames?.[name] ?? name;
    next[field] = values[token];
  }
  rows.set(key, next);
}
function eventMetaRow(row: Row): boolean {
  return typeof row.PK === "string" && row.PK.startsWith("EVENT#") && row.SK === "META";
}
interface RecordedQueryPage {
  Items?: Row[];
  LastEvaluatedKey?: Row;
}
function queryRecordedRows(
  rows: Map<string, Row>,
  input: QueryCommand["input"],
): RecordedQueryPage {
  const values = input.ExpressionAttributeValues ?? {};
  const items = [...rows.entries()]
    .filter(
      ([key, row]) =>
        key === rowKey(input.TableName, row) &&
        row.PK === values[":pk"] &&
        String(row.SK).startsWith(String(values[":prefix"])),
    )
    .map(([, row]) => row)
    .sort((a, b) => String(a.SK).localeCompare(String(b.SK)));
  if (input.ScanIndexForward === false) items.reverse();
  const page = items.slice(0, input.Limit);
  const last = page.at(-1);
  return {
    Items: structuredClone(page),
    ...(items.length > page.length && last
      ? { LastEvaluatedKey: { PK: last.PK, SK: last.SK } }
      : {}),
  };
}
/** Records intercepted SDK writes, not a substitute for DynamoDB's transaction/concurrency conformance tests. */
function fixture(count = 2, padding = 0, initialScore = 0) {
  const client = new DynamoDBClient({
    region: "us-east-1",
    credentials: { accessKeyId: "DUMMYIDEXAMPLE", secretAccessKey: "DUMMYEXAMPLEKEY" },
  });
  clients.push(client);
  const document = DynamoDBDocumentClient.from(client);
  const tables = { events: "events", teams: "teams", deployments: "deployments" };
  const event: EventRecord = {
    eventId: ulid(NOW),
    name: "Synthetic native event",
    status: "READY",
    teamCount: count,
    problems: [{ problemId: "ac26-crypto-battle", defaultRegion: "us-east-1" }],
    createdAt: AT,
    updatedAt: AT,
    startsAt: AT,
    expiresAt: NOW / 1000 + 86400,
  };
  const teams: TeamRecord[] = Array.from({ length: count }, (_, index) => ({
    eventId: event.eventId,
    teamId: ulid(),
    internalSlug: `team-${index}`,
    teamLoginKey: "A".repeat(43),
    authVersion: 1,
    accessRevoked: false,
    createdAt: AT,
    updatedAt: AT,
    expiresAt: event.expiresAt,
  }));
  const team = teams[0];
  if (!team) throw new Error("Missing fixture team");
  const apply = vi.fn((state: unknown, _teamId: string, op: unknown) => {
    const old = state as State;
    return {
      padding: (op as { kind: string }).kind === "shrink" ? "" : old.padding,
      scores: Object.fromEntries(
        Object.entries(old.scores).map(([key, value]) => [key, value + 1]),
      ),
    };
  });
  const plugin: HostPlugin = {
    initialState: (context) => ({
      padding: "x".repeat(padding),
      scores: Object.fromEntries(context.teamIds.map((teamId) => [teamId, initialScore])),
    }),
    validateOp: (_state, _team, op) =>
      (op as { kind: string }).kind === "reject"
        ? { ok: false, error: "test_rejected" }
        : { ok: true },
    applyOp: apply,
    projectForTeam: (state, id) => ({ score: (state as State).scores[id] }),
    teamScores: (state) => (state as State).scores,
    tickOnRequest: true,
    tick: (state) => state,
  };
  const artifactDigest = contentDigest("synthetic-reviewed-artifact");
  const artifact: NativeCoordinationArtifact = {
    problemId: "ac26-crypto-battle",
    artifactDigest,
    pluginKey: `plugins/${artifactDigest}.mjs`,
    catalogKey: `catalogs/${contentDigest("synthetic-catalog")}.json`,
    stateBudget: { bytesPerTeam: 31744, baseBytes: 1536 },
    plugin,
  };
  const rows = new Map<string, Row>();
  rows.set(rowKey(tables.events, eventKey(event.eventId)), {
    ...event,
    ...eventKey(event.eventId),
  });
  for (const item of teams)
    rows.set(rowKey(tables.teams, teamKey(event.eventId, item.teamId)), item as unknown as Row);
  const writes: Write[][] = [];
  const measurements: CoordinationWriteMeasurement[] = [];
  const timings: CoordinationTiming[] = [];
  const releases: UpdateCommand[] = [];
  let afterGet: ((key: Row | undefined) => void | Promise<void>) | undefined;
  let beforeWrite: ((items: Write[]) => void | Promise<void>) | undefined;
  let afterWrite: ((items: Write[]) => void | Promise<void>) | undefined;
  let afterRead: ((rows: { Item?: Row }[], items: ReadItems) => void | Promise<void>) | undefined;
  let afterQuery:
    | ((page: RecordedQueryPage, input: QueryCommand["input"]) => void | Promise<void>)
    | undefined;
  const send = vi.spyOn(document, "send").mockImplementation(async (command) => {
    if (command instanceof GetCommand) {
      const Item = structuredClone(rows.get(rowKey(command.input.TableName, command.input.Key)));
      await afterGet?.(command.input.Key);
      return { Item };
    }
    if (command instanceof TransactGetCommand) {
      const responses = (command.input.TransactItems ?? []).map((item) => ({
        Item: structuredClone(rows.get(rowKey(item.Get?.TableName, item.Get?.Key))),
      }));
      await afterRead?.(responses, command.input.TransactItems ?? []);
      return { Responses: responses };
    }
    if (command instanceof QueryCommand) {
      const page = queryRecordedRows(rows, command.input);
      await afterQuery?.(page, command.input);
      return page;
    }
    if (command instanceof ScanCommand)
      return {
        Items: [...rows.values()].filter(eventMetaRow),
      };
    if (command instanceof TransactWriteCommand) {
      const items = command.input.TransactItems ?? [];
      await beforeWrite?.(items);
      checkAdmissionConditions(rows, items);
      checkLifecycleConditions(rows, items);
      writes.push(structuredClone(items));
      applyRecordedTransaction(rows, items);
      await afterWrite?.(items);
      return {};
    }
    if (command instanceof UpdateCommand) {
      releases.push(command);
      applyOwnedRelease(rows, command);
      return {};
    }
    throw new Error(`Unexpected SDK command: ${command.constructor.name}`);
  });
  const store = new DynamoDeploymentsCoordination(
    document,
    tables,
    (value) => measurements.push(value),
    (value) => timings.push(value),
  );
  const initialize = () => store.initialize({ event, teams, artifact, now: NOW });
  const operation = (key = "operation-1", kind = "score", runId?: string) => ({
    key,
    ...(runId === undefined ? {} : { runId }),
    hash: contentDigest(JSON.stringify({ kind })),
    op: { kind },
  });
  const request = (op = operation()) =>
    store.request({ event, team, artifact, now: () => NOW, operation: op });
  return {
    client,
    document,
    tables,
    event,
    team,
    teams,
    artifact,
    rows,
    writes,
    measurements,
    timings,
    releases,
    send,
    store,
    apply,
    initialize,
    operation,
    request,
    reset: (expectedRunId: string) =>
      store.reset({ event, artifact, expectedRunId, now: () => NOW }),
    setInitialScore: (value: number) => {
      initialScore = value;
    },
    setAfterGet: (value: typeof afterGet) => {
      afterGet = value;
    },
    setBeforeWrite: (value: typeof beforeWrite) => {
      beforeWrite = value;
    },
    setAfterWrite: (value: typeof afterWrite) => {
      afterWrite = value;
    },
    setAfterRead: (value: typeof afterRead) => {
      afterRead = value;
    },
    setAfterQuery: (value: typeof afterQuery) => {
      afterQuery = value;
    },
  };
}

function authorizationReads(f: ReturnType<typeof fixture>): ReadItems[] {
  return f.send.mock.calls.flatMap(([command]) =>
    command instanceof TransactGetCommand && isAuthorizationRead(command.input.TransactItems ?? [])
      ? [command.input.TransactItems ?? []]
      : [],
  );
}
function currentHead(f: ReturnType<typeof fixture>): Row {
  const head = f.rows.get(
    rowKey(f.tables.deployments, coordinationHeadKey(f.event.eventId, f.artifact.problemId)),
  );
  if (!head) throw new Error("Fixture HEAD missing");
  return head;
}
const scope: InstallationScope = {
  account: "123456789012",
  region: "us-east-1",
  environment: "test",
  applicationStackId:
    "arn:aws:cloudformation:us-east-1:123456789012:stack/tenkacloud-cloud-test/synthetic-app",
  backendStackId:
    "arn:aws:cloudformation:us-east-1:123456789012:stack/tenkacloud-cloud-problem-deploy-test/synthetic-data",
};
function drainingInstallation(
  f: ReturnType<typeof fixture>,
  status: "DRAINING" | "DRAINED" = "DRAINING",
): void {
  f.rows.set(rowKey(f.tables.events, installationControlKey), {
    ...installationControlKey,
    scope,
    scopeDigest: installationScopeDigest(scope),
    status,
    startedAt: AT,
    updatedAt: AT,
  });
}
function archivedEvent(f: ReturnType<typeof fixture>, event: EventRecord = f.event): EventRecord {
  const archived: EventRecord = {
    ...event,
    status: "ARCHIVED",
    teardownExpected: 0,
    teardownCompleted: 0,
  };
  f.rows.set(rowKey(f.tables.events, eventKey(event.eventId)), {
    ...archived,
    ...eventKey(event.eventId),
  });
  return archived;
}
async function closeAndArchive(f: ReturnType<typeof fixture>): Promise<EventRecord> {
  const closed = await f.store.changeSchedule({
    event: f.event,
    artifact: f.artifact,
    patch: { status: "TEARDOWN", endsAt: new Date(NOW + 1000).toISOString(), scoringLocked: true },
    close: true,
    now: () => NOW + 1000,
  });
  return archivedEvent(f, closed);
}
function corruptStateChunk(f: ReturnType<typeof fixture>): void {
  const entry = [...f.rows.entries()].find(([, row]) => row.data instanceof Uint8Array);
  if (!entry) throw new Error("Fixture state chunk missing");
  const [key, row] = entry;
  f.rows.set(key, { ...row, data: Buffer.alloc((row.data as Uint8Array).byteLength) });
}

function resetPublication(items: Write[]) {
  return items.find((item) => /^RUN#.+#HEAD$/u.test(String(item.Put?.Item?.SK)))?.Put;
}
function nativeRows(f: ReturnType<typeof fixture>): Row[] {
  const { PK } = coordinationHeadKey(f.event.eventId, f.artifact.problemId);
  return [...f.rows.values()].filter((row) => row.PK === PK);
}
function scoreRow(f: ReturnType<typeof fixture>): Row | undefined {
  return f.rows.get(rowKey(f.tables.teams, scoreKey(f.event.eventId, f.team.teamId)));
}
async function leaveRetirementPending(f: ReturnType<typeof fixture>): Promise<string> {
  const first = await f.initialize();
  await f.request();
  const second = await f.reset(first.runId);
  const third = await f.reset(second.runId);
  const failure = new Error("Synthetic interruption before retired-run cleanup");
  f.setAfterWrite((items) => {
    if (resetPublication(items)) throw failure;
  });
  await expect(f.reset(third.runId)).rejects.toBe(failure);
  f.setAfterWrite(undefined);
  expect(currentHead(f).retiredRuns).toEqual([first.runId]);
  return first.runId;
}

function nativePayloadRows(f: ReturnType<typeof fixture>): Row[] {
  return nativeRows(f).filter((row) => /^(?:SNAPSHOT|RUN|RECEIPT)#/u.test(String(row.SK)));
}
function recordedRowsFingerprint(f: ReturnType<typeof fixture>) {
  return [...f.rows].map(([key, row]) => [
    key,
    {
      ...row,
      ...(row.data instanceof Uint8Array
        ? { data: createHash("sha256").update(row.data).digest("hex") }
        : {}),
    },
  ]);
}
function purgePublication(items: Write[], state: "pending" | "complete") {
  return items.find((item) => item.Put?.Item?.SK === "HEAD" && item.Put.Item.purge?.state === state)
    ?.Put;
}
function purgePageGuard(items: Write[]) {
  return items.find((item) => item.ConditionCheck?.ExpressionAttributeValues?.[":purge"])
    ?.ConditionCheck;
}
function purgeReference(head: Row): Row {
  return Object.fromEntries(
    ["runId", "revision", "snapshotDigest", "byteLength", "chunkCount", "snapshotLayout"]
      .filter((field) => head[field] !== undefined)
      .map((field) => [field, head[field]]),
  );
}
function isPurgePhase(items: Write[], phase: "intent" | "page" | "completion"): boolean {
  if (phase === "page") return purgePageGuard(items) !== undefined;
  return purgePublication(items, phase === "intent" ? "pending" : "complete") !== undefined;
}
async function leavePurgePending(f: ReturnType<typeof fixture>): Promise<void> {
  const failure = new Error("Synthetic interruption before purge page");
  f.setBeforeWrite((items) => {
    if (purgePageGuard(items)) throw failure;
  });
  await expect(f.store.purge(f.event.eventId, f.artifact.problemId)).rejects.toBe(failure);
  f.setBeforeWrite(undefined);
  expect(currentHead(f).purge).toMatchObject({ state: "pending" });
}

describe("native DynamoDB explicit event purge SDK-only contracts", () => {
  it.each(["current", "history and pending retirement"] as const)(
    "verifies and purges %s while preserving permanent scores, unrelated scopes and shared artifacts",
    async (retention) => {
      const f = fixture(2, 400000, 30);
      if (retention === "current") await f.initialize();
      else await leaveRetirementPending(f);
      await closeAndArchive(f);
      const head = structuredClone(currentHead(f));
      const ids = [
        String(head.runId),
        ...((head.history as string[] | undefined) ?? []),
        ...((head.retiredRuns as string[] | undefined) ?? []),
      ];
      const { PK } = coordinationHeadKey(f.event.eventId, f.artifact.problemId);
      const references = ids.map((runId, index) => {
        const run =
          index === 0
            ? head
            : f.rows.get(rowKey(f.tables.deployments, { PK, SK: `RUN#${runId}#HEAD` }));
        if (!run) throw new Error("Missing fixture archive");
        return purgeReference(run);
      });
      for (let index = 0; index < 165; index++) {
        const runId = ids[index % ids.length];
        const digest = contentDigest(`purge-receipt-${index}`);
        const row = {
          PK,
          SK: `RECEIPT#${runId}#${f.team.teamId}#${digest}`,
          runId,
          response: { private: "saved projection" },
        };
        f.rows.set(rowKey(f.tables.deployments, row), row);
      }
      const unrelated = [
        { PK: `COORD#${ulid()}#${f.artifact.problemId}`, SK: "SNAPSHOT#0", data: "other event" },
        { PK: `COORD#${f.event.eventId}#other-problem`, SK: "SNAPSHOT#0", data: "other problem" },
        { PK: `ARTIFACT#${f.artifact.artifactDigest}`, SK: "PLUGIN", data: "shared plugin" },
        { PK: `ARTIFACT#${f.artifact.artifactDigest}`, SK: "CATALOG", data: "shared catalog" },
      ];
      for (const row of unrelated) f.rows.set(rowKey(f.tables.deployments, row), row);
      const preserved = new Map(
        [...f.rows].filter(
          ([, row]) =>
            row.PK !== PK ||
            (row.SK !== "HEAD" && !/^(?:SNAPSHOT|RUN|RECEIPT)#/u.test(String(row.SK))),
        ),
      );
      const scoreEvents = await f.store.listScoreEvents(
        f.event.eventId,
        f.artifact.problemId,
        f.team.teamId,
      );
      const s3 = vi
        .spyOn(S3Client.prototype, "send")
        .mockRejectedValue(new Error("Purge must not fetch shared artifacts"));
      const readsBefore = f.send.mock.calls.length;
      const writesBefore = f.writes.length;
      await f.store.purge(f.event.eventId, f.artifact.problemId);
      expect(nativePayloadRows(f)).toEqual([]);
      expect(currentHead(f)).toEqual({ ...head, purge: { state: "complete", runs: references } });
      expect(currentHead(f)).not.toHaveProperty("expiresAt");
      expect(currentHead(f)).not.toHaveProperty("match");
      for (const [key, value] of preserved) expect(f.rows.get(key)).toEqual(value);
      expect(
        await f.store.listScoreEvents(f.event.eventId, f.artifact.problemId, f.team.teamId),
      ).toEqual(scoreEvents);
      expect(s3).not.toHaveBeenCalled();
      const purgeWrites = f.writes.slice(writesBefore);
      const intent = purgePublication(purgeWrites[0] ?? [], "pending");
      expect(intent?.Item?.purge).toEqual({ state: "pending", runs: references });
      expect(intent?.ConditionExpression).toContain(
        "snapshotDigest = :digest AND closed = :closed",
      );
      expect(intent?.ConditionExpression).toContain("attribute_not_exists(#purge)");
      expect(intent?.ExpressionAttributeValues).toMatchObject({
        ":run": head.runId,
        ":revision": head.revision,
        ":digest": head.snapshotDigest,
        ":closed": true,
      });
      const reads = f.send.mock.calls
        .slice(readsBefore)
        .flatMap(([command]) =>
          command instanceof TransactGetCommand ? [command.input.TransactItems ?? []] : [],
        );
      for (const [index, runId] of ids.entries()) {
        const manifestKey = index === 0 ? "HEAD" : `RUN#${runId}#HEAD`;
        const read = reads.find((items) => items.at(-1)?.Get?.Key?.SK === manifestKey);
        expect(read).toHaveLength(Number(references[index]?.chunkCount) + 1);
      }
      const pages = purgeWrites.filter((items) => items.some((item) => item.Delete));
      expect(pages.length).toBeGreaterThanOrEqual(4);
      for (const items of pages) {
        expect(items.length).toBeLessThanOrEqual(81);
        const guard = purgePageGuard(items);
        expect(guard).toMatchObject({
          TableName: f.tables.deployments,
          Key: { PK, SK: "HEAD" },
          ConditionExpression: expect.stringContaining("#purge = :purge"),
          ExpressionAttributeNames: { "#purge": "purge" },
          ExpressionAttributeValues: {
            ":run": head.runId,
            ":revision": head.revision,
            ":digest": head.snapshotDigest,
            ":closed": true,
            ":purge": { state: "pending", runs: references },
          },
        });
        expect(
          items
            .filter((item) => item.Delete)
            .every(
              (item) =>
                item.Delete?.TableName === f.tables.deployments &&
                item.Delete.Key?.PK === PK &&
                /^(?:SNAPSHOT|RUN|RECEIPT)#/u.test(String(item.Delete.Key.SK)),
            ),
        ).toBe(true);
      }
      const queries = f.send.mock.calls
        .slice(readsBefore)
        .flatMap(([command]) =>
          command instanceof QueryCommand &&
          command.input.ExpressionAttributeValues?.[":prefix"] !== "SCORE#"
            ? [command.input]
            : [],
        );
      expect(
        queries.slice(-3).map((query) => query.ExpressionAttributeValues?.[":prefix"]),
      ).toEqual(["SNAPSHOT#", "RUN#", "RECEIPT#"]);
      for (const query of queries) {
        expect(query).toMatchObject({
          TableName: f.tables.deployments,
          ConsistentRead: true,
          Limit: 80,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
          ExpressionAttributeValues: { ":pk": PK },
        });
        expect(query).not.toHaveProperty("ExclusiveStartKey");
        expect(query).not.toHaveProperty("FilterExpression");
        expect(query).not.toHaveProperty("ProjectionExpression");
      }
      const completed = purgePublication(purgeWrites.at(-1) ?? [], "complete");
      expect(completed?.ConditionExpression).toContain("#purge = :purge");
      expect(completed?.ExpressionAttributeValues?.[":purge"]).toEqual({
        state: "pending",
        runs: references,
      });
      const beforeRetry = structuredClone(f.rows);
      const committed = f.writes.length;
      await f.store.purge(f.event.eventId, f.artifact.problemId);
      expect(f.rows).toEqual(beforeRetry);
      expect(f.writes).toHaveLength(committed);
    },
  );
  it("fences an empty scope and refuses an open run before writing purge intent", async () => {
    const f = fixture();
    await f.store.purge(f.event.eventId, f.artifact.problemId);
    expect(f.writes).toEqual([
      [
        {
          ConditionCheck: {
            TableName: f.tables.deployments,
            Key: coordinationHeadKey(f.event.eventId, f.artifact.problemId),
            ConditionExpression: "attribute_not_exists(PK)",
          },
        },
      ],
    ]);
    const queries = f.send.mock.calls.flatMap(([command]) =>
      command instanceof QueryCommand ? [command.input] : [],
    );
    expect(queries.map((query) => query.ExpressionAttributeValues?.[":prefix"])).toEqual([
      "SNAPSHOT#",
      "RUN#",
      "RECEIPT#",
    ]);
    for (const query of queries)
      expect(query).toMatchObject({
        ConsistentRead: true,
        Limit: 1,
        ExpressionAttributeValues: {
          ":pk": coordinationHeadKey(f.event.eventId, f.artifact.problemId).PK,
        },
      });
    await f.initialize();
    const before = structuredClone(f.rows);
    await expect(f.store.purge(f.event.eventId, f.artifact.problemId)).rejects.toMatchObject({
      status: 409,
      code: "coordination_not_settled",
    });
    expect(f.rows).toEqual(before);
    expect(currentHead(f)).not.toHaveProperty("purge");
  });
  it.each(["SNAPSHOT#", "RUN#", "RECEIPT#"])(
    "rejects orphan %s data when the verified HEAD is missing",
    async (prefix) => {
      const f = fixture();
      const { PK } = coordinationHeadKey(f.event.eventId, f.artifact.problemId);
      const orphan = { PK, SK: `${prefix}orphan`, data: "private orphan payload" };
      f.rows.set(rowKey(f.tables.deployments, orphan), orphan);
      const before = structuredClone(f.rows);
      await expect(f.store.purge(f.event.eventId, f.artifact.problemId)).rejects.toMatchObject({
        status: 503,
        code: "coordination_purge_invalid",
      });
      expect(f.rows).toEqual(before);
      expect(f.writes).toEqual([]);
    },
  );
  it("rejects an empty continuation page when checking an absent HEAD", async () => {
    const f = fixture();
    f.setAfterQuery((page) => {
      page.Items = undefined;
      page.LastEvaluatedKey = {
        PK: coordinationHeadKey(f.event.eventId, f.artifact.problemId).PK,
        SK: "SNAPSHOT#cursor",
      };
    });
    await expect(f.store.purge(f.event.eventId, f.artifact.problemId)).rejects.toMatchObject({
      status: 503,
      code: "coordination_purge_invalid",
    });
    expect(f.writes).toEqual([]);
  });
  it("rechecks an absent HEAD when initialization races the empty-partition fence", async () => {
    const f = fixture();
    f.setBeforeWrite(async (items) => {
      if (!items.some((item) => item.ConditionCheck?.Key?.SK === "HEAD")) return;
      f.setBeforeWrite(undefined);
      await f.initialize();
    });
    await expect(f.store.purge(f.event.eventId, f.artifact.problemId)).rejects.toMatchObject({
      status: 409,
      code: "coordination_not_settled",
    });
    expect(currentHead(f)).toMatchObject({ closed: false });
    expect(currentHead(f)).not.toHaveProperty("purge");
    expect(nativePayloadRows(f)).not.toHaveLength(0);
  });
  it.each(["other partition", "score key", "unverified snapshot"] as const)(
    "rejects a query row from %s before deleting any payload",
    async (damage) => {
      const f = fixture();
      await f.initialize();
      await closeAndArchive(f);
      await leavePurgePending(f);
      const before = recordedRowsFingerprint(f);
      const writesBefore = f.writes.length;
      f.setAfterQuery((page) => {
        const row = page.Items?.[0];
        if (!row) return;
        if (damage === "other partition") row.PK = `COORD#${ulid()}#${f.artifact.problemId}`;
        else if (damage === "score key") row.SK = "SCORE#unrelated";
        else row.runId = ulid();
      });
      await expect(f.store.purge(f.event.eventId, f.artifact.problemId)).rejects.toMatchObject({
        status: 503,
        code:
          damage === "unverified snapshot"
            ? "coordination_purge_invalid"
            : "coordination_scope_invalid",
      });
      expect(recordedRowsFingerprint(f)).toEqual(before);
      expect(f.writes).toHaveLength(writesBefore);
      expect(currentHead(f).purge).toMatchObject({ state: "pending" });
    },
  );
  it.each([
    ["current", "missing chunk"],
    ["current", "corrupt chunk"],
    ["history", "missing chunk"],
    ["history", "corrupt chunk"],
    ["history", "missing manifest"],
    ["retired", "missing chunk"],
    ["retired", "corrupt chunk"],
    ["retired", "missing manifest"],
  ] as const)("fails closed before intent for a %s run with a %s", async (target, damage) => {
    const f = fixture(2, 400000);
    await leaveRetirementPending(f);
    await closeAndArchive(f);
    const head = currentHead(f);
    const retainedField = target === "history" ? "history" : "retiredRuns";
    const runId =
      target === "current" ? String(head.runId) : String((head[retainedField] as string[])[0]);
    const row = nativeRows(f)
      .filter(
        (item) =>
          item.runId === runId &&
          (damage === "missing manifest"
            ? String(item.SK).endsWith("#HEAD")
            : item.data instanceof Uint8Array && String(item.SK).includes("SNAPSHOT#")),
      )
      .at(-1);
    if (!row) throw new Error("Missing corruption fixture row");
    if (damage === "corrupt chunk")
      f.rows.set(rowKey(f.tables.deployments, row), {
        ...row,
        data: new Uint8Array((row.data as Uint8Array).byteLength),
      });
    else f.rows.delete(rowKey(f.tables.deployments, row));
    const before = recordedRowsFingerprint(f);
    const writesBefore = f.writes.length;
    await expect(f.store.purge(f.event.eventId, f.artifact.problemId)).rejects.toMatchObject({
      status: 503,
      code:
        damage === "missing manifest"
          ? "coordination_history_invalid"
          : "coordination_snapshot_invalid",
    });
    expect(recordedRowsFingerprint(f)).toEqual(before);
    expect(f.writes).toHaveLength(writesBefore);
    expect(currentHead(f)).not.toHaveProperty("purge");
  });
  it("exposes only safe identity after intent and allows close only after every payload page is gone", async () => {
    const f = fixture();
    const first = await f.initialize();
    await f.reset(first.runId);
    await closeAndArchive(f);
    const head = structuredClone(currentHead(f));
    const payloads = nativePayloadRows(f);
    const staleFence = await f.store.closeFence(f.event.eventId, f.artifact.problemId);
    await leavePurgePending(f);
    expect(nativePayloadRows(f)).toEqual(payloads);
    const safe = {
      eventId: f.event.eventId,
      problemId: f.artifact.problemId,
      runId: head.runId,
      revision: head.revision,
      closed: true,
    };
    expect(await f.store.summary(f.event.eventId, f.artifact.problemId)).toEqual({
      ...safe,
      purgeState: "pending",
    });
    await expect(f.store.read(f.event.eventId, f.artifact.problemId)).rejects.toMatchObject({
      status: 409,
      code: "coordination_run_closed",
    });
    await expect(
      f.store.readRun(f.event.eventId, f.artifact.problemId, first.runId),
    ).rejects.toMatchObject({ status: 409, code: "coordination_run_closed" });
    await expect(f.store.closeFence(f.event.eventId, f.artifact.problemId)).rejects.toMatchObject({
      status: 503,
      code: "coordination_purge_pending",
    });
    await expect(
      f.document.send(new TransactWriteCommand({ TransactItems: [staleFence] })),
    ).rejects.toMatchObject({ name: "TransactionCanceledException" });
    await f.store.purge(f.event.eventId, f.artifact.problemId);
    expect(await f.store.summary(f.event.eventId, f.artifact.problemId)).toEqual({
      ...safe,
      purgeState: "complete",
    });
    const readsBefore = f.send.mock.calls.length;
    const fence = await f.store.closeFence(f.event.eventId, f.artifact.problemId);
    expect(fence.ConditionCheck?.ExpressionAttributeValues?.[":purge"]).toEqual(
      currentHead(f).purge,
    );
    expect(
      f.send.mock.calls
        .slice(readsBefore)
        .some(([command]) => command instanceof TransactGetCommand),
    ).toBe(false);
    await expect(
      f.document.send(new TransactWriteCommand({ TransactItems: [fence] })),
    ).resolves.toEqual({});
    await expect(f.store.read(f.event.eventId, f.artifact.problemId)).rejects.toMatchObject({
      status: 409,
      code: "coordination_run_closed",
    });
    await expect(
      f.store.readRun(f.event.eventId, f.artifact.problemId, first.runId),
    ).rejects.toMatchObject({ status: 409, code: "coordination_run_closed" });
  });
  it.each(["intent", "page", "completion"] as const)(
    "recovers a lost %s transaction reply using the permanent marker",
    async (phase) => {
      const f = fixture();
      await f.initialize();
      await f.request();
      await closeAndArchive(f);
      const failure = new Error(`Synthetic lost ${phase} reply`);
      f.setAfterWrite((items) => {
        if (isPurgePhase(items, phase)) throw failure;
      });
      await expect(f.store.purge(f.event.eventId, f.artifact.problemId)).rejects.toBe(failure);
      expect(currentHead(f).purge).toMatchObject({
        state: phase === "completion" ? "complete" : "pending",
      });
      const marker = structuredClone(currentHead(f).purge) as Row;
      f.setAfterWrite(undefined);
      await f.store.purge(f.event.eventId, f.artifact.problemId);
      expect(currentHead(f).purge).toEqual({ ...marker, state: "complete" });
      expect(nativePayloadRows(f)).toEqual([]);
    },
  );
  it.each(["SNAPSHOT#", "RUN#", "RECEIPT#"])(
    "keeps pending intent when an empty %s page has a continuation cursor",
    async (prefix) => {
      const f = fixture();
      await f.initialize();
      await closeAndArchive(f);
      await leavePurgePending(f);
      const { PK } = coordinationHeadKey(f.event.eventId, f.artifact.problemId);
      f.setAfterQuery((page, input) => {
        if (input.ExpressionAttributeValues?.[":prefix"] === prefix) {
          page.Items = [];
          page.LastEvaluatedKey = { PK, SK: `${prefix}cursor` };
        }
      });
      await expect(f.store.purge(f.event.eventId, f.artifact.problemId)).rejects.toMatchObject({
        status: 503,
        code: "coordination_purge_page_invalid",
      });
      expect(currentHead(f).purge).toMatchObject({ state: "pending" });
      expect(f.writes.some((items) => purgePublication(items, "complete"))).toBe(false);
      f.setAfterQuery(undefined);
      await f.store.purge(f.event.eventId, f.artifact.problemId);
      expect(currentHead(f).purge).toMatchObject({ state: "complete" });
    },
  );
  it("bounds repeated conflicts at twelve attempts and leaves resumable pending intent", async () => {
    const f = fixture();
    await f.initialize();
    await closeAndArchive(f);
    await leavePurgePending(f);
    let conflicts = 0;
    f.setBeforeWrite((items) => {
      if (purgePageGuard(items)) {
        conflicts++;
        throw cancelled();
      }
    });
    await expect(f.store.purge(f.event.eventId, f.artifact.problemId)).rejects.toMatchObject({
      status: 409,
      code: "coordination_purge_conflict",
    });
    expect(conflicts).toBe(12);
    expect(currentHead(f).purge).toMatchObject({ state: "pending" });
    f.setBeforeWrite(undefined);
    await f.store.purge(f.event.eventId, f.artifact.problemId);
    expect(nativePayloadRows(f)).toEqual([]);
  });
  it("stops at the fifteen-second deadline without claiming an unfinished purge completed", async () => {
    const f = fixture();
    await f.initialize();
    await closeAndArchive(f);
    await leavePurgePending(f);
    let elapsed = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    f.setAfterWrite((items) => {
      if (purgePageGuard(items)) elapsed = 15000;
    });
    await expect(f.store.purge(f.event.eventId, f.artifact.problemId)).rejects.toMatchObject({
      status: 503,
      code: "coordination_purge_pending",
    });
    expect(currentHead(f).purge).toMatchObject({ state: "pending" });
    clock.mockRestore();
    f.setAfterWrite(undefined);
    await f.store.purge(f.event.eventId, f.artifact.problemId);
    expect(currentHead(f).purge).toMatchObject({ state: "complete" });
  });
  it.each(["intent", "page", "completion"] as const)(
    "accepts a concurrent purge winner at %s without rewriting its permanent manifest",
    async (phase) => {
      const f = fixture();
      await f.initialize();
      await f.request();
      await closeAndArchive(f);
      let winner: Row | undefined;
      f.setBeforeWrite(async (items) => {
        if (!isPurgePhase(items, phase)) return;
        f.setBeforeWrite(undefined);
        await f.store.purge(f.event.eventId, f.artifact.problemId);
        winner = structuredClone(currentHead(f));
      });
      await f.store.purge(f.event.eventId, f.artifact.problemId);
      expect(winner).toBeDefined();
      expect(currentHead(f)).toEqual(winner);
      expect(nativePayloadRows(f)).toEqual([]);
      expect(f.writes.filter((items) => purgePublication(items, "complete"))).toHaveLength(1);
    },
  );
  it.each(["pending", "complete"] as const)(
    "accepts a concurrent %s purge while verifying a retained snapshot",
    async (state) => {
      const f = fixture();
      const first = await f.initialize();
      await f.reset(first.runId);
      await closeAndArchive(f);
      let winner: Row | undefined;
      f.setAfterGet(async (key) => {
        if (key?.SK !== `RUN#${first.runId}#HEAD`) return;
        f.setAfterGet(undefined);
        if (state === "pending") {
          const failure = new Error("Synthetic lost first-page reply during concurrent purge");
          f.setAfterWrite((items) => {
            if (purgePageGuard(items)) throw failure;
          });
          await expect(f.store.purge(f.event.eventId, f.artifact.problemId)).rejects.toBe(failure);
          f.setAfterWrite(undefined);
        } else await f.store.purge(f.event.eventId, f.artifact.problemId);
        winner = structuredClone(currentHead(f));
      });
      await f.store.purge(f.event.eventId, f.artifact.problemId);
      expect(winner).toBeDefined();
      expect(currentHead(f)).toEqual({
        ...winner,
        purge: { ...(winner?.purge as Row), state: "complete" },
      });
      expect(nativePayloadRows(f)).toEqual([]);
    },
  );
  it("restarts verification when legitimate retirement removes its pending archive", async () => {
    const f = fixture();
    const retired = await leaveRetirementPending(f);
    await closeAndArchive(f);
    f.setAfterGet(async (key) => {
      if (key?.SK !== `RUN#${retired}#HEAD`) return;
      f.setAfterGet(undefined);
      await f.store.pruneHistory(f.event.eventId, f.artifact.problemId);
    });
    await f.store.purge(f.event.eventId, f.artifact.problemId);
    const head = currentHead(f);
    expect(head).not.toHaveProperty("retiredRuns");
    expect(head.purge).toEqual({
      state: "complete",
      runs: [
        expect.objectContaining({ runId: head.runId }),
        ...(head.history as string[]).map((runId) => expect.objectContaining({ runId })),
      ],
    });
    expect(nativePayloadRows(f)).toEqual([]);
  });
  it("resumes a concurrent intent after global drain starts between HEAD and intake reads", async () => {
    const f = fixture();
    await f.initialize();
    await closeAndArchive(f);
    let marker: Row | undefined;
    f.setAfterGet(async (key) => {
      if (key?.SK !== "HEAD") return;
      f.setAfterGet(undefined);
      await leavePurgePending(f);
      marker = structuredClone(currentHead(f).purge) as Row;
      drainingInstallation(f);
    });
    await f.store.purge(f.event.eventId, f.artifact.problemId);
    expect(marker).toBeDefined();
    expect(currentHead(f).purge).toEqual({ ...marker, state: "complete" });
    expect(nativePayloadRows(f)).toEqual([]);
  });
  it("fences a closed snapshot publisher that races purge without any other HEAD identity change", async () => {
    const f = fixture();
    await f.initialize();
    const event = await f.store.changeSchedule({
      event: f.event,
      artifact: f.artifact,
      patch: { scoringLocked: true },
      close: true,
      now: () => NOW + 1000,
    });
    const head = structuredClone(currentHead(f));
    f.setBeforeWrite(async (items) => {
      const publication = items.find((item) => item.Put?.Item?.SK === "HEAD")?.Put;
      if (!publication) return;
      f.setBeforeWrite(undefined);
      expect(publication.ConditionExpression).toContain("attribute_not_exists(purge)");
      await f.store.purge(f.event.eventId, f.artifact.problemId);
    });
    await expect(
      f.store.changeSchedule({
        event,
        artifact: f.artifact,
        patch: { scoringLocked: true },
        close: true,
        now: () => NOW + 2000,
      }),
    ).rejects.toMatchObject({ status: 409, code: "coordination_run_closed" });
    expect(currentHead(f)).toMatchObject({
      runId: head.runId,
      revision: head.revision,
      snapshotDigest: head.snapshotDigest,
      purge: { state: "complete" },
    });
    expect(nativePayloadRows(f)).toEqual([]);
  });
  it("fences initialization replay after it reads a closed snapshot and purge wins its guard", async () => {
    const f = fixture();
    await f.initialize();
    const event = await f.store.changeSchedule({
      event: f.event,
      artifact: f.artifact,
      patch: { scoringLocked: true },
      close: true,
      now: () => NOW + 1000,
    });
    f.setBeforeWrite(async (items) => {
      if (!items.some((item) => item.ConditionCheck?.Key?.SK === "HEAD")) return;
      f.setBeforeWrite(undefined);
      await f.store.purge(f.event.eventId, f.artifact.problemId);
    });
    await expect(
      f.store.initialize({ event, teams: f.teams, artifact: f.artifact, now: NOW + 2000 }),
    ).rejects.toMatchObject({ status: 409, code: "coordination_run_closed" });
    expect(currentHead(f).purge).toMatchObject({ state: "complete" });
    expect(nativePayloadRows(f)).toEqual([]);
  });
  it.each(["operation", "reset"] as const)(
    "does not resurrect a run when a stale %s races close and purge",
    async (operation) => {
      const f = fixture();
      const first = await f.initialize();
      f.setBeforeWrite(async (items) => {
        const publication =
          operation === "operation" ? admissionPublication(items) : resetPublication(items);
        if (!publication) return;
        f.setBeforeWrite(undefined);
        await closeAndArchive(f);
        await f.store.purge(f.event.eventId, f.artifact.problemId);
      });
      await expect(
        operation === "operation" ? f.request() : f.reset(first.runId),
      ).rejects.toMatchObject({ status: 409 });
      expect(currentHead(f).purge).toMatchObject({ state: "complete" });
      expect(nativePayloadRows(f)).toEqual([]);
    },
  );
  it("fences retirement deletion that races purge so its permanent inventory cannot be removed", async () => {
    const f = fixture();
    await leaveRetirementPending(f);
    await closeAndArchive(f);
    const retired = structuredClone(currentHead(f).retiredRuns);
    f.setBeforeWrite(async (items) => {
      if (!items.some((item) => item.Update?.UpdateExpression === "REMOVE retiredRuns")) return;
      f.setBeforeWrite(undefined);
      await f.store.purge(f.event.eventId, f.artifact.problemId);
    });
    await expect(f.store.pruneHistory(f.event.eventId, f.artifact.problemId)).rejects.toMatchObject(
      { status: 409, code: "coordination_run_closed" },
    );
    expect(currentHead(f)).toMatchObject({ retiredRuns: retired, purge: { state: "complete" } });
    expect(nativePayloadRows(f)).toEqual([]);
  });
  it.each(["DRAINING", "DRAINED"] as const)(
    "refuses new purge intent after installation intake is %s",
    async (status) => {
      const f = fixture();
      await f.initialize();
      await closeAndArchive(f);
      drainingInstallation(f, status);
      const before = recordedRowsFingerprint(f);
      const writesBefore = f.writes.length;
      await expect(f.store.purge(f.event.eventId, f.artifact.problemId)).rejects.toMatchObject({
        status: 409,
        code: "coordination_purge_intake_closed",
      });
      expect(recordedRowsFingerprint(f)).toEqual(before);
      expect(f.writes).toHaveLength(writesBefore);
      expect(currentHead(f)).not.toHaveProperty("purge");
    },
  );
  it("atomically rejects new purge intent when global drain wins after snapshot verification", async () => {
    const f = fixture();
    await f.initialize();
    await closeAndArchive(f);
    const head = structuredClone(currentHead(f));
    const payloads = nativePayloadRows(f);
    const writesBefore = f.writes.length;
    f.setBeforeWrite((items) => {
      if (!purgePublication(items, "pending")) return;
      expect(items).toContainEqual({
        ConditionCheck: {
          TableName: f.tables.events,
          Key: installationControlKey,
          ConditionExpression: "attribute_not_exists(PK)",
        },
      });
      f.setBeforeWrite(undefined);
      drainingInstallation(f);
    });
    await expect(f.store.purge(f.event.eventId, f.artifact.problemId)).rejects.toMatchObject({
      status: 409,
      code: "coordination_purge_intake_closed",
    });
    expect(currentHead(f)).toEqual(head);
    expect(nativePayloadRows(f)).toEqual(payloads);
    expect(f.writes).toHaveLength(writesBefore);
  });
  it.each(["DRAINING", "DRAINED"] as const)(
    "resumes an already-recorded purge after installation intake is %s",
    async (status) => {
      const f = fixture();
      await f.initialize();
      await f.request();
      await closeAndArchive(f);
      await leavePurgePending(f);
      const marker = structuredClone(currentHead(f).purge) as Row;
      drainingInstallation(f, status);
      await f.store.purge(f.event.eventId, f.artifact.problemId);
      expect(currentHead(f).purge).toEqual({ ...marker, state: "complete" });
      expect(nativePayloadRows(f)).toEqual([]);
      const before = recordedRowsFingerprint(f);
      const writesBefore = f.writes.length;
      await f.store.purge(f.event.eventId, f.artifact.problemId);
      expect(recordedRowsFingerprint(f)).toEqual(before);
      expect(f.writes).toHaveLength(writesBefore);
    },
  );
  it("retains private snapshots when ordinary event teardown has no explicit purge callback", async () => {
    const f = fixture();
    await f.initialize();
    const payloads = nativePayloadRows(f);
    const result = await requestEventTeardown({
      repository: new DynamoCloudRepository(f.document, f.tables),
      work: new DynamoDeploymentWork(f.document, f.tables),
      eventId: f.event.eventId,
      now: NOW + 2000,
      beforeClose: (event) =>
        f.store.changeSchedule({
          event,
          artifact: f.artifact,
          patch: { scoringLocked: true },
          close: true,
          now: () => NOW + 1000,
        }),
    });
    expect(result.status).toBe(202);
    expect(nativePayloadRows(f)).toHaveLength(payloads.length);
    expect(currentHead(f)).not.toHaveProperty("purge");
    expect((await f.store.read(f.event.eventId, f.artifact.problemId))?.closed).toBe(true);
  });
});

describe("native DynamoDB reset/history SDK-only contracts", () => {
  it("atomically publishes initial nonzero scores and resets only the native subtotal", async () => {
    const f = fixture(2, 0, 30);
    f.rows.set(rowKey(f.tables.teams, scoreKey(f.event.eventId, f.team.teamId)), {
      ...scoreKey(f.event.eventId, f.team.teamId),
      eventId: f.event.eventId,
      teamId: f.team.teamId,
      score: 200,
      completedProblems: 4,
    });
    const tick = vi.spyOn(f.artifact.plugin, "tick");
    const teamScores = vi.spyOn(f.artifact.plugin, "teamScores");
    const first = await f.initialize();
    expect(scoreRow(f)).toMatchObject({ score: 230, completedProblems: 4 });
    expect(first.match.scores[f.team.teamId]).toBe(30);
    expect(teamScores).toHaveBeenCalledTimes(1);
    expect(tick).not.toHaveBeenCalled();
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]?.filter((item) => item.Update?.TableName === "teams")).toHaveLength(2);
    const oldChunks = nativeRows(f).filter((row) => String(row.SK).startsWith("SNAPSHOT#"));
    expect(oldChunks).not.toHaveLength(0);
    f.setInitialScore(17);
    const reset = await f.reset(first.runId);
    expect(reset).toEqual({
      eventId: f.event.eventId,
      problemId: f.artifact.problemId,
      previousRunId: first.runId,
      runId: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
    });
    const current = await f.store.read(f.event.eventId, f.artifact.problemId);
    expect(current).toMatchObject({
      revision: 1,
      history: [first.runId],
      snapshotLayout: "run",
      artifactDigest: first.artifactDigest,
      pluginKey: first.pluginKey,
      catalogKey: first.catalogKey,
      roster: first.roster,
      clock: first.clock,
      match: { version: 1, scores: { [f.team.teamId]: 17 } },
    });
    expect(current?.runId).not.toBe(first.runId);
    expect(current?.match.matchSecret).not.toBe(first.match.matchSecret);
    expect(scoreRow(f)).toMatchObject({ score: 217, completedProblems: 4 });
    expect(teamScores).toHaveBeenCalledTimes(2);
    expect(tick).not.toHaveBeenCalled();
    expect(f.apply).not.toHaveBeenCalled();
    expect(await f.store.readRun(f.event.eventId, f.artifact.problemId, first.runId)).toMatchObject(
      {
        runId: first.runId,
        closed: true,
        match: first.match,
      },
    );
    for (const chunk of oldChunks)
      expect(f.rows.get(rowKey(f.tables.deployments, chunk))).toEqual(chunk);
    const writes = f.writes.at(-1) ?? [];
    expect(writes.filter((item) => item.Update?.TableName === "teams")).toHaveLength(2);
    expect(
      writes.find((item) => item.Put?.Item?.SK === "HEAD")?.Put?.ExpressionAttributeValues,
    ).toMatchObject({ ":run": first.runId, ":revision": 0 });
    expect(
      writes.find((item) => item.Put?.Item?.SK === "HEAD")?.Put?.ConditionExpression,
    ).toContain(
      "runId = :run AND revision = :revision AND snapshotDigest = :digest AND closed = :closed",
    );
    expect(resetPublication(writes)?.ConditionExpression).toBe("attribute_not_exists(PK)");
    expect(nativeRows(f).filter((row) => String(row.SK).startsWith("SCORE#"))).toHaveLength(2);
    expect(
      writes
        .filter((item) => item.Put?.Item?.data instanceof Uint8Array)
        .every((item) => String(item.Put?.Item?.SK).startsWith(`RUN#${reset.runId}#SNAPSHOT#`)),
    ).toBe(true);
  });
  it("leaves initial scores and snapshots untouched when atomic initialization fails", async () => {
    const f = fixture(2, 0, 17);
    const before = structuredClone(f.rows);
    const failure = new Error("Synthetic initialization outage");
    f.setBeforeWrite(() => {
      throw failure;
    });
    await expect(f.initialize()).rejects.toBe(failure);
    expect(f.rows).toEqual(before);
    expect(f.writes).toHaveLength(0);
  });
  it("lets exactly one reset win its HEAD CAS without resetting again on the loser retry", async () => {
    const f = fixture(2, 0, 17);
    const first = await f.initialize();
    let winner: Awaited<ReturnType<typeof f.reset>> | undefined;
    f.setBeforeWrite(async (items) => {
      if (!resetPublication(items)) return;
      f.setBeforeWrite(undefined);
      winner = await f.reset(first.runId);
    });
    await expect(f.reset(first.runId)).rejects.toMatchObject({
      status: 409,
      code: "run_rotation_conflict",
    });
    expect(winner).toBeDefined();
    expect(currentHead(f)).toMatchObject({
      runId: winner?.runId,
      revision: 1,
      history: [first.runId],
    });
    expect(f.writes.filter((items) => resetPublication(items))).toHaveLength(1);
    const rows = structuredClone(f.rows);
    await expect(f.reset(first.runId)).rejects.toMatchObject({
      status: 409,
      code: "run_rotation_conflict",
    });
    expect(f.rows).toEqual(rows);
  });
  it.each(["before claim", "after claim", "before publication"] as const)(
    "fences an operation racing a reset %s before applying it to the new run",
    async (phase) => {
      const f = fixture();
      const first = await f.initialize();
      let nextRunId: string | undefined;
      const rotate = async () => {
        f.setBeforeWrite(undefined);
        f.setAfterWrite(undefined);
        nextRunId = (await f.reset(first.runId)).runId;
      };
      if (phase === "after claim")
        f.setAfterWrite(async (items) => {
          if (admissionClaim(items)) await rotate();
        });
      else
        f.setBeforeWrite(async (items) => {
          if (phase === "before claim" ? admissionClaim(items) : admissionPublication(items))
            await rotate();
        });
      await expect(
        f.request(f.operation("racing-move", "score", first.runId)),
      ).rejects.toMatchObject({ status: 409, code: "coordination_run_changed" });
      expect(currentHead(f)).toMatchObject({ runId: nextRunId, revision: 1 });
      expect(f.apply).toHaveBeenCalledTimes(phase === "before publication" ? 1 : 0);
      expect(
        (await f.store.read(f.event.eventId, f.artifact.problemId))?.match.scores[f.team.teamId],
      ).toBe(0);
      expect(nativeRows(f).some((row) => String(row.SK).startsWith("RECEIPT#"))).toBe(false);
      expect(f.writes.filter((items) => admissionPublication(items))).toHaveLength(0);
    },
  );
  it("rejects a reset encountered during old receipt replay before returning that receipt", async () => {
    const f = fixture();
    const first = await f.initialize();
    const operation = f.operation("replay-race", "score", first.runId);
    await f.request(operation);
    f.setAfterGet(async (key) => {
      if (!String(key?.SK).startsWith(`RECEIPT#${first.runId}#`)) return;
      f.setAfterGet(undefined);
      await f.reset(first.runId);
    });
    await expect(f.request(operation)).rejects.toMatchObject({
      status: 409,
      code: "coordination_run_changed",
    });
    expect(f.apply).toHaveBeenCalledTimes(1);
    expect(currentHead(f).revision).toBe(2);
  });
  it("keeps replay within a run and requires refreshed identities after the first reset", async () => {
    const f = fixture();
    const first = await f.initialize();
    const oldResponse = await f.request();
    const oldReceipt = nativeRows(f).filter((row) =>
      String(row.SK).startsWith(`RECEIPT#${first.runId}#`),
    );
    expect(await f.request(f.operation("operation-1", "score", first.runId))).toEqual(oldResponse);
    await expect(f.request(f.operation("wrong-run", "score", ulid()))).rejects.toMatchObject({
      status: 409,
      code: "coordination_run_changed",
    });
    const next = await f.reset(first.runId);
    const writesBefore = f.writes.length;
    await expect(f.request()).rejects.toMatchObject({
      status: 409,
      code: "coordination_run_changed",
    });
    await expect(f.request(f.operation("operation-1", "score", first.runId))).rejects.toMatchObject(
      {
        status: 409,
        code: "coordination_run_changed",
      },
    );
    expect(f.writes).toHaveLength(writesBefore);
    const newOperation = f.operation("operation-1", "score", next.runId);
    const newResponse = await f.request(newOperation);
    expect(newResponse.revision).toBeGreaterThan(oldResponse.revision);
    expect(await f.request(newOperation)).toEqual(newResponse);
    expect(f.apply).toHaveBeenCalledTimes(2);
    for (const row of oldReceipt)
      expect(f.rows.get(rowKey(f.tables.deployments, row))).toEqual(row);
    expect(
      nativeRows(f).filter((row) => String(row.SK).startsWith(`RECEIPT#${next.runId}#`)),
    ).toHaveLength(oldReceipt.length);
  });
  it("retains current plus two prior runs while physically deleting retired snapshots and receipts", async () => {
    const f = fixture(2, 400000, 17);
    const first = await f.initialize();
    let runId = first.runId;
    const runs = [runId];
    const secrets = new Set([first.match.matchSecret]);
    let revision = 0;
    for (let index = 0; index < 4; index++) {
      await f.request(f.operation(`retained-${index}`, "score", runId));
      revision++;
      runId = (await f.reset(runId)).runId;
      runs.push(runId);
      revision++;
      const current = await f.store.read(f.event.eventId, f.artifact.problemId);
      expect(current?.revision).toBe(revision);
      secrets.add(current?.match.matchSecret ?? "");
      expect(current?.history).toEqual(runs.slice(-3, -1).reverse());
    }
    expect(secrets.size).toBe(5);
    for (const run of runs.slice(0, -3)) {
      expect(await f.store.readRun(f.event.eventId, f.artifact.problemId, run)).toBeUndefined();
      expect(
        nativeRows(f).filter((row) => row.runId === run && !String(row.SK).startsWith("SCORE#")),
      ).toHaveLength(0);
    }
    for (const run of runs.slice(-3))
      expect(await f.store.readRun(f.event.eventId, f.artifact.problemId, run)).toMatchObject({
        runId: run,
      });
    expect(nativeRows(f).filter((row) => String(row.SK).startsWith("SNAPSHOT#"))).toHaveLength(0);
    expect(nativeRows(f).filter((row) => String(row.SK).startsWith("SCORE#"))).toHaveLength(9);
    expect(currentHead(f)).not.toHaveProperty("retiredRuns");
    expect(await f.store.readRun(f.event.eventId, f.artifact.problemId, ulid())).toBeUndefined();
  });
  it("resumes interrupted paged cleanup from its durable marker and preserves foreign rows and audit scores", async () => {
    const f = fixture(2, 400000, 17);
    const first = await f.initialize();
    await f.request();
    const second = await f.reset(first.runId);
    const third = await f.reset(second.runId);
    const { PK } = coordinationHeadKey(f.event.eventId, f.artifact.problemId);
    for (let index = 0; index < 83; index++) {
      const row = {
        PK,
        SK: `RECEIPT#${first.runId}#synthetic-${String(index).padStart(3, "0")}`,
        runId: first.runId,
      };
      f.rows.set(rowKey(f.tables.deployments, row), row);
    }
    const foreign = [
      {
        PK: coordinationHeadKey(ulid(), f.artifact.problemId).PK,
        SK: `RECEIPT#${first.runId}#foreign-event`,
        runId: first.runId,
      },
      { PK, SK: `RECEIPT#${third.runId}#foreign-run`, runId: third.runId },
    ];
    for (const row of foreign) f.rows.set(rowKey(f.tables.deployments, row), row);
    const audit = nativeRows(f).filter((row) => String(row.SK).startsWith("SCORE#"));
    const failure = new Error("Synthetic lost receipt-deletion response");
    f.setAfterWrite((items) => {
      if (items.some((item) => String(item.Delete?.Key?.SK).startsWith(`RECEIPT#${first.runId}#`)))
        throw failure;
    });
    await expect(f.reset(third.runId)).rejects.toBe(failure);
    expect(currentHead(f)).toMatchObject({
      history: [third.runId, second.runId],
      retiredRuns: [first.runId],
    });
    expect(
      nativeRows(f).filter((row) => String(row.SK).startsWith(`RECEIPT#${first.runId}#`)),
    ).toHaveLength(5);
    expect(nativeRows(f).some((row) => String(row.SK).startsWith("SNAPSHOT#"))).toBe(true);
    expect(
      await f.store.readRun(f.event.eventId, f.artifact.problemId, first.runId),
    ).toBeUndefined();
    f.setAfterWrite(undefined);
    await f.store.pruneHistory(f.event.eventId, f.artifact.problemId);
    expect(currentHead(f)).not.toHaveProperty("retiredRuns");
    expect(
      nativeRows(f).filter(
        (row) => row.runId === first.runId && !String(row.SK).startsWith("SCORE#"),
      ),
    ).toHaveLength(0);
    for (const row of [...foreign, ...audit])
      expect(f.rows.get(rowKey(f.tables.deployments, row))).toEqual(row);
    const queries = f.send.mock.calls.flatMap(([command]) =>
      command instanceof QueryCommand ? [command.input] : [],
    );
    expect(queries.length).toBeGreaterThanOrEqual(3);
    for (const query of queries) {
      expect(query).toMatchObject({
        TableName: f.tables.deployments,
        ConsistentRead: true,
        Limit: 80,
        ExpressionAttributeValues: { ":pk": PK, ":prefix": `RECEIPT#${first.runId}#` },
      });
      expect(query).not.toHaveProperty("ExclusiveStartKey");
    }
    const writesBefore = f.writes.length;
    await f.store.pruneHistory(f.event.eventId, f.artifact.problemId);
    expect(f.writes).toHaveLength(writesBefore);
    const cleanup = f.writes.filter((items) => items.some((item) => item.Delete));
    expect(cleanup).toHaveLength(3);
    for (const items of cleanup) {
      const guard = items.map((item) => item.ConditionCheck ?? item.Update).find(Boolean);
      expect(guard).toMatchObject({
        Key: coordinationHeadKey(f.event.eventId, f.artifact.problemId),
        ConditionExpression:
          "contains(retiredRuns, :retired) AND runId <> :retired AND NOT contains(#history, :retired) AND attribute_not_exists(purge)",
        ExpressionAttributeNames: { "#history": "history" },
        ExpressionAttributeValues: { ":retired": first.runId },
      });
      expect(items.length).toBeLessThan(100);
    }
  });
  it.each([[], undefined])(
    "keeps all retired data when an empty receipt page has a continuation cursor (%s)",
    async (Items) => {
      const f = fixture();
      const retired = await leaveRetirementPending(f);
      const { PK } = coordinationHeadKey(f.event.eventId, f.artifact.problemId);
      const manifest = f.rows.get(rowKey(f.tables.deployments, { PK, SK: `RUN#${retired}#HEAD` }));
      if (!manifest) throw new Error("Missing retired manifest");
      const before = structuredClone(f.rows);
      const writesBefore = f.writes.length;
      f.send
        .mockImplementationOnce(async () => ({ Item: structuredClone(currentHead(f)) }))
        .mockImplementationOnce(async () => ({ Item: structuredClone(manifest) }))
        .mockImplementationOnce(async () => ({
          Items,
          LastEvaluatedKey: { PK, SK: `RECEIPT#${retired}#cursor` },
        }));
      await expect(
        f.store.pruneHistory(f.event.eventId, f.artifact.problemId),
      ).rejects.toMatchObject({
        status: 503,
        code: "coordination_history_page_invalid",
      });
      expect(f.rows).toEqual(before);
      expect(f.writes).toHaveLength(writesBefore);
      expect(currentHead(f).retiredRuns).toEqual([retired]);
      await f.store.pruneHistory(f.event.eventId, f.artifact.problemId);
      expect(currentHead(f)).not.toHaveProperty("retiredRuns");
      expect(
        nativeRows(f).filter(
          (row) => row.runId === retired && !String(row.SK).startsWith("SCORE#"),
        ),
      ).toHaveLength(0);
    },
  );
  it("fails closed when a retained run is listed but its archive is missing", async () => {
    const f = fixture();
    const first = await f.initialize();
    await f.reset(first.runId);
    const { PK } = coordinationHeadKey(f.event.eventId, f.artifact.problemId);
    f.rows.delete(rowKey(f.tables.deployments, { PK, SK: `RUN#${first.runId}#HEAD` }));
    const before = structuredClone(f.rows);
    await expect(
      f.store.readRun(f.event.eventId, f.artifact.problemId, first.runId),
    ).rejects.toMatchObject({ status: 503, code: "coordination_history_invalid" });
    expect(f.rows).toEqual(before);
  });
  it("returns no historical run when a reset retires it during the archive read", async () => {
    const f = fixture();
    const first = await f.initialize();
    const second = await f.reset(first.runId);
    const third = await f.reset(second.runId);
    f.setAfterGet(async (key) => {
      if (key?.SK !== `RUN#${first.runId}#HEAD`) return;
      f.setAfterGet(undefined);
      await f.reset(third.runId);
    });
    expect(
      await f.store.readRun(f.event.eventId, f.artifact.problemId, first.runId),
    ).toBeUndefined();
    expect(
      nativeRows(f).filter(
        (row) => row.runId === first.runId && !String(row.SK).startsWith("SCORE#"),
      ),
    ).toHaveLength(0);
  });
  it("keeps the retirement marker and private chunks when the retired manifest is missing", async () => {
    const f = fixture();
    const retired = await leaveRetirementPending(f);
    const { PK } = coordinationHeadKey(f.event.eventId, f.artifact.problemId);
    f.rows.delete(rowKey(f.tables.deployments, { PK, SK: `RUN#${retired}#HEAD` }));
    const before = structuredClone(f.rows);
    const writesBefore = f.writes.length;
    await expect(f.store.pruneHistory(f.event.eventId, f.artifact.problemId)).rejects.toMatchObject(
      {
        status: 503,
        code: "coordination_history_invalid",
      },
    );
    expect(f.rows).toEqual(before);
    expect(f.writes).toHaveLength(writesBefore);
    expect(currentHead(f).retiredRuns).toEqual([retired]);
    expect(
      nativeRows(f).some((row) => row.runId === retired && row.data instanceof Uint8Array),
    ).toBe(true);
  });
  it("accepts a concurrently completed cleanup when the previously read retired manifest has gone", async () => {
    const f = fixture();
    const retired = await leaveRetirementPending(f);
    f.setAfterGet(async (key) => {
      if (key?.SK !== "HEAD") return;
      f.setAfterGet(undefined);
      await f.store.pruneHistory(f.event.eventId, f.artifact.problemId);
    });
    await f.store.pruneHistory(f.event.eventId, f.artifact.problemId);
    expect(currentHead(f)).not.toHaveProperty("retiredRuns");
    expect(
      nativeRows(f).filter((row) => row.runId === retired && !String(row.SK).startsWith("SCORE#")),
    ).toHaveLength(0);
  });
  it("retries an active publication after cleanup without resurrecting the completed retirement marker", async () => {
    const f = fixture();
    const retired = await leaveRetirementPending(f);
    const runId = String(currentHead(f).runId);
    f.apply.mockClear();
    f.setBeforeWrite(async (items) => {
      if (!admissionPublication(items)) return;
      f.setBeforeWrite(undefined);
      expect(admissionPublication(items)?.ConditionExpression).toContain(
        "retiredRuns = :retiredRuns",
      );
      expect(admissionPublication(items)?.ExpressionAttributeValues?.[":retiredRuns"]).toEqual([
        retired,
      ]);
      await f.store.pruneHistory(f.event.eventId, f.artifact.problemId);
    });
    expect((await f.request(f.operation("cleanup-race", "score", runId))).body).toEqual({
      projection: { score: 1 },
    });
    expect(f.apply).toHaveBeenCalledTimes(2);
    expect(currentHead(f)).not.toHaveProperty("retiredRuns");
    expect(
      nativeRows(f).filter((row) => row.runId === retired && !String(row.SK).startsWith("SCORE#")),
    ).toHaveLength(0);
  });
  it("fits a near-2MiB reset with 48 score changes without copying the archived snapshot", async () => {
    const f = fixture(48, COORDINATION_MAX_BYTES - 16000, 30);
    const first = await f.initialize();
    f.setInitialScore(17);
    const next = await f.reset(first.runId);
    const writes = f.writes.at(-1) ?? [];
    const chunks = writes.flatMap((item) =>
      item.Put?.Item?.data instanceof Uint8Array ? [item.Put.Item] : [],
    );
    expect(chunks).toHaveLength(8);
    expect(chunks.every((row) => String(row.SK).startsWith(`RUN#${next.runId}#SNAPSHOT#`))).toBe(
      true,
    );
    expect(
      chunks.reduce((sum, row) => sum + (row.data as Uint8Array).byteLength, 0),
    ).toBeGreaterThan(1.9 * 1024 * 1024);
    expect(writes.filter((item) => item.Update?.TableName === "teams")).toHaveLength(48);
    expect(resetPublication(writes)?.Item).not.toHaveProperty("data");
    const measurement = f.measurements.at(-1);
    expect(measurement?.items).toBeLessThan(100);
    expect(measurement?.maxItemBytes).toBeLessThan(400 * 1024);
    expect(measurement?.bytesUpperBound).toBeLessThan(4 * 1024 * 1024);
  });
});

describe("native DynamoDB SDK transaction contracts", () => {
  it("enforces the monotonic 20-second budget after admission while game time is frozen", async () => {
    const f = fixture();
    await f.initialize();
    let monotonic = 0;
    vi.spyOn(performance, "now").mockImplementation(() => monotonic);
    f.setAfterWrite((items) => {
      if (admissionClaim(items)) monotonic = 20001;
    });
    await expect(f.request()).rejects.toMatchObject({ status: 409, code: "coordination_conflict" });
    expect(f.releases).toHaveLength(1);
    expect(currentHead(f)).not.toHaveProperty("admissionOwner");
    expect(f.writes.some((items) => admissionPublication(items))).toBe(false);
    expect(f.apply).not.toHaveBeenCalled();
    expect((await f.store.read(f.event.eventId, f.artifact.problemId))?.revision).toBe(0);
  });
  it("stops a budget-expired waiter without releasing another owner's claim", async () => {
    const f = fixture();
    await f.initialize();
    const owner = "11111111-1111-4111-8111-111111111111";
    Object.assign(currentHead(f), { admissionOwner: owner, admissionExpiresAt: NOW + 5000 });
    let monotonic = 0;
    let headReads = 0;
    vi.spyOn(performance, "now").mockImplementation(() => monotonic);
    f.setAfterGet((key) => {
      if (key?.SK === "HEAD" && ++headReads === 2) monotonic = 20001;
    });
    await expect(f.request()).rejects.toMatchObject({ status: 409, code: "coordination_conflict" });
    expect(currentHead(f).admissionOwner).toBe(owner);
    expect(f.releases).toHaveLength(0);
    expect(f.writes).toHaveLength(1);
    expect(f.apply).not.toHaveBeenCalled();
  });
  it("claims a guarded 5-second admission and atomically releases it with state, score, and immutable receipt", async () => {
    const f = fixture();
    await f.initialize();
    const response = await f.request();
    const claim = admissionClaim(f.writes[1] ?? []);
    expect(claim).toMatchObject({
      Key: coordinationHeadKey(f.event.eventId, f.artifact.problemId),
      ConditionExpression: expect.stringContaining("revision = :revision AND closed = :no"),
      ExpressionAttributeValues: expect.objectContaining({ ":now": NOW, ":until": NOW + 5000 }),
    });
    expect(f.writes[1]).toHaveLength(4);
    const publish = admissionPublication(f.writes[2] ?? []);
    expect(publish?.ExpressionAttributeValues?.[":owner"]).toBe(
      claim?.ExpressionAttributeValues?.[":owner"],
    );
    expect(publish?.ConditionExpression).toContain("admissionExpiresAt > :atMs");
    expect(publish?.ExpressionAttributeValues?.[":atMs"]).toBe(NOW);
    expect(currentHead(f)).not.toHaveProperty("admissionOwner");
    expect(currentHead(f)).not.toHaveProperty("admissionExpiresAt");
    expect(f.releases).toHaveLength(0);
    expect(await f.request()).toEqual(response);
    expect(f.writes).toHaveLength(3);
    expect(f.releases).toHaveLength(0);
    expect(f.apply).toHaveBeenCalledTimes(1);
    expect(f.timings.map((sample) => sample.phase)).toEqual(
      expect.arrayContaining(["encode", "decode", "reduce", "commit"]),
    );
    for (const sample of f.timings) {
      expect(Object.keys(sample).sort()).toEqual(["elapsedMs", "phase"]);
      expect(Number.isFinite(sample.elapsedMs)).toBe(true);
      expect(sample.elapsedMs).toBeGreaterThanOrEqual(0);
    }
  });
  it.each([
    { codes: ["ConditionalCheckFailed", "None", "None", "None"], diagnosticReads: 0 },
    { codes: ["ConditionalCheckFailed"], diagnosticReads: 1 },
    {
      codes: ["ConditionalCheckFailed", "None", "ConditionalCheckFailed", "None"],
      diagnosticReads: 1,
    },
    { codes: ["None", "ConditionalCheckFailed", "None", "None"], diagnosticReads: 1 },
  ])("keeps guarded admission on collision $codes", async ({ codes, diagnosticReads }) => {
    const f = fixture();
    await f.initialize();
    let claims = 0;
    f.setBeforeWrite((items) => {
      if (!admissionClaim(items)) return;
      expect(items).toHaveLength(4);
      if (claims++ === 0)
        throw Object.assign(cancelled(), {
          CancellationReasons: codes.map((Code) => ({ Code })),
        });
    });
    expect((await f.request()).status).toBe(200);
    expect(claims).toBe(2);
    expect(f.apply).toHaveBeenCalledTimes(1);
    expect(
      f.send.mock.calls.filter(
        ([command]) => command instanceof GetCommand && command.input.TableName === "teams",
      ),
    ).toHaveLength(diagnosticReads);
  });
  it.each(["revoked", "intake"] as const)(
    "does not run the reducer when a head collision is followed by %s closure",
    async (closure) => {
      const f = fixture();
      await f.initialize();
      let claims = 0;
      let monotonic = 0;
      vi.spyOn(performance, "now").mockImplementation(() => monotonic);
      const close = () => {
        if (closure === "intake") return drainingInstallation(f);
        const row = f.rows.get(rowKey(f.tables.teams, teamKey(f.event.eventId, f.team.teamId)));
        if (!row) throw new Error("Missing team");
        row.accessRevoked = true;
      };
      f.setBeforeWrite((items) => {
        if (!admissionClaim(items)) return;
        if (claims++ === 0) {
          close();
          throw Object.assign(cancelled(), {
            CancellationReasons: ["ConditionalCheckFailed", "None", "None", "None"].map((Code) => ({
              Code,
            })),
          });
        }
        monotonic = 20001;
      });
      await expect(f.request()).rejects.toMatchObject({
        code: closure === "revoked" ? "unauthorized" : "coordination_conflict",
      });
      expect(claims).toBe(2);
      expect(f.apply).not.toHaveBeenCalled();
      expect(f.writes).toHaveLength(1);
      expect(currentHead(f)).not.toHaveProperty("admissionOwner");
    },
  );
  it("releases its own uncertain claim after a lost claim response and permits an ordinary retry", async () => {
    const f = fixture();
    await f.initialize();
    const failure = new Error("Synthetic lost claim response");
    f.setAfterWrite((items) => {
      if (admissionClaim(items)) throw failure;
    });
    await expect(f.request()).rejects.toBe(failure);
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.releases).toHaveLength(1);
    expect(f.releases[0]?.input).toMatchObject({
      UpdateExpression: "REMOVE admissionOwner, admissionExpiresAt",
      ConditionExpression: "admissionOwner = :owner",
      ExpressionAttributeValues: {
        ":owner": admissionClaim(f.writes[1] ?? [])?.ExpressionAttributeValues?.[":owner"],
      },
    });
    expect(currentHead(f)).not.toHaveProperty("admissionOwner");
    expect(currentHead(f).revision).toBe(0);
    f.setAfterWrite(undefined);
    expect((await f.request()).body).toEqual({ projection: { score: 1 } });
    expect(f.apply).toHaveBeenCalledTimes(1);
  });
  it("releases its owned admission when the canonical reducer fails before publication", async () => {
    const f = fixture();
    await f.initialize();
    const failure = new Error("Synthetic reducer failure");
    f.apply.mockImplementationOnce(() => {
      throw failure;
    });
    await expect(f.request()).rejects.toBe(failure);
    expect(f.releases).toHaveLength(1);
    expect(currentHead(f)).not.toHaveProperty("admissionOwner");
    expect(currentHead(f).revision).toBe(0);
    expect(f.writes).toHaveLength(2);
    expect((await f.request()).body).toEqual({ projection: { score: 1 } });
  });
  it.each(["expired", "replaced"] as const)(
    "rejects a %s admission at final publication before retrying with fresh ownership",
    async (kind) => {
      const f = fixture();
      await f.initialize();
      const replacement = "00000000-0000-4000-8000-000000000001";
      let failed = false;
      let replacementSurvivedRelease = false;
      f.setBeforeWrite((items) => {
        if (failed && admissionClaim(items)) {
          replacementSurvivedRelease = currentHead(f).admissionOwner === replacement;
          return;
        }
        if (failed || !admissionPublication(items)) return;
        failed = true;
        currentHead(f).admissionExpiresAt = NOW;
        if (kind === "replaced") currentHead(f).admissionOwner = replacement;
      });
      expect((await f.request()).body).toEqual({ projection: { score: 1 } });
      expect(f.releases).toHaveLength(1);
      expect(replacementSurvivedRelease).toBe(kind === "replaced");
      expect(f.writes.filter((items) => admissionPublication(items))).toHaveLength(1);
      expect(f.apply).toHaveBeenCalledTimes(2);
      expect(currentHead(f).revision).toBe(1);
      expect(currentHead(f)).not.toHaveProperty("admissionOwner");
    },
  );
  it.each(["closed", "revoked"] as const)(
    "rejects an actor/event %s after admission but before atomic publication",
    async (kind) => {
      const f = fixture();
      await f.initialize();
      f.setBeforeWrite((items) => {
        if (!admissionPublication(items)) return;
        if (kind === "revoked") {
          f.rows.set(rowKey(f.tables.teams, teamKey(f.event.eventId, f.team.teamId)), {
            ...f.team,
            accessRevoked: true,
          });
        } else {
          f.rows.set(rowKey(f.tables.events, eventKey(f.event.eventId)), {
            ...f.event,
            status: "ENDED",
            updatedAt: new Date(NOW + 1).toISOString(),
          });
        }
      });
      await expect(f.request()).rejects.toMatchObject(
        kind === "revoked"
          ? { status: 401, code: "unauthorized" }
          : { status: 409, code: "event_changed" },
      );
      expect(f.writes).toHaveLength(2);
      expect(f.releases).toHaveLength(1);
      expect(currentHead(f).revision).toBe(0);
      expect(currentHead(f)).not.toHaveProperty("admissionOwner");
      expect(
        (await f.store.read(f.event.eventId, f.artifact.problemId))?.match.scores[f.team.teamId],
      ).toBe(0);
    },
  );
  it("replays an immutable receipt after a lost publication response without clearing another owner", async () => {
    const f = fixture();
    await f.initialize();
    const failure = new Error("Synthetic lost publication response");
    f.setAfterWrite((items) => {
      if (admissionPublication(items)) throw failure;
    });
    await expect(f.request()).rejects.toBe(failure);
    expect(f.releases).toHaveLength(1);
    expect(currentHead(f).revision).toBe(1);
    expect(currentHead(f)).not.toHaveProperty("admissionOwner");
    f.setAfterWrite(undefined);
    expect((await f.request()).body).toEqual({ projection: { score: 1 } });
    expect(f.writes).toHaveLength(3);
    expect(f.apply).toHaveBeenCalledTimes(1);
  });
  it("initializes 25 teams above 400KiB as bounded binary chunks plus one authoritative HEAD", async () => {
    const f = fixture(25, 795000);
    const run = await f.initialize();
    const writes = f.writes[0] ?? [];
    const chunks = writes.flatMap((item) =>
      item.Put?.Item?.data instanceof Uint8Array ? [item.Put.Item] : [],
    );
    expect(chunks.length).toBeGreaterThan(1);
    expect(
      chunks.every((item) => (item.data as Uint8Array).byteLength <= COORDINATION_CHUNK_BYTES),
    ).toBe(true);
    const bytes = Buffer.concat(chunks.map((item) => Buffer.from(item.data as Uint8Array)));
    const head = writes.find((item) => item.Put?.Item?.SK === "HEAD")?.Put;
    expect(head?.ConditionExpression).toBe("attribute_not_exists(PK)");
    expect(head?.Item?.snapshotDigest).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(JSON.parse(bytes.toString()).matchSecret).toBe(run.match.matchSecret);
    expect(
      writes.every(
        (item) =>
          !JSON.stringify(item).includes("TARGET#") &&
          !JSON.stringify(item).includes("DEPLOYMENT#"),
      ),
    ).toBe(true);
    expect(writes.filter((item) => item.ConditionCheck?.TableName === "events")).toHaveLength(2);
    expect((await f.store.read(f.event.eventId, f.artifact.problemId))?.match).toEqual(run.match);
    expect(
      f.send.mock.calls
        .filter(([command]) => command instanceof GetCommand)
        .every(
          ([command]) => command instanceof GetCommand && command.input.ConsistentRead === true,
        ),
    ).toBe(true);
  });
  it("atomically couples state, receipt, all 48 SCORE updates and one immutable transition ledger under limits", async () => {
    const f = fixture(48, 48 * 31744);
    await f.initialize();
    const response = await f.request();
    expect(response.body).toEqual({ projection: { score: 1 } });
    const writes = f.writes.at(-1) ?? [];
    expect(writes.filter((item) => item.Update?.TableName === "teams")).toHaveLength(48);
    const ledgers = writes.filter((item) => String(item.Put?.Item?.SK).startsWith("SCORE#"));
    expect(ledgers).toHaveLength(1);
    expect(ledgers[0]?.Put?.ConditionExpression).toBe("attribute_not_exists(PK)");
    expect(writes.some((item) => String(item.Put?.Item?.SK).startsWith("RECEIPT#"))).toBe(true);
    expect(
      writes.find((item) => item.Put?.Item?.SK === "HEAD")?.Put?.ConditionExpression,
    ).toContain("revision = :revision");
    const conditions = writes.flatMap((item) => (item.ConditionCheck ? [item.ConditionCheck] : []));
    expect(conditions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          TableName: "events",
          Key: { PK: "INSTALLATION", SK: "CONTROL" },
        }),
        expect.objectContaining({
          TableName: "events",
          Key: eventKey(f.event.eventId),
          ConditionExpression: expect.stringContaining("updatedAt = :at"),
        }),
        expect.objectContaining({
          TableName: "teams",
          Key: teamKey(f.event.eventId, f.team.teamId),
          ConditionExpression: expect.stringContaining("authVersion = :version"),
        }),
      ]),
    );
    const measurement = f.measurements.at(-1);
    expect(measurement?.items).toBeLessThanOrEqual(100);
    expect(measurement?.maxItemBytes).toBeLessThan(400 * 1024);
    expect(measurement?.bytesUpperBound).toBeLessThan(4 * 1024 * 1024);
  });
  it("replays immutable projections without applying the move twice, still guarding the current actor/event/global fence", async () => {
    const f = fixture();
    await f.initialize();
    const response = await f.request();
    const writesBefore = f.writes.length;
    const replay = await f.request();
    expect(replay).toEqual(response);
    expect(f.apply).toHaveBeenCalledTimes(1);
    expect(f.writes).toHaveLength(writesBefore);
    const authorization = authorizationReads(f).at(-1);
    expect(authorization).toEqual([
      { Get: { TableName: f.tables.events, Key: eventKey(f.event.eventId) } },
      { Get: { TableName: f.tables.teams, Key: teamKey(f.event.eventId, f.team.teamId) } },
      {
        Get: {
          TableName: f.tables.deployments,
          Key: coordinationHeadKey(f.event.eventId, f.artifact.problemId),
        },
      },
      { Get: { TableName: f.tables.events, Key: installationControlKey } },
    ]);
    await expect(f.request(f.operation("operation-1", "changed"))).rejects.toMatchObject({
      status: 422,
      code: "idempotency_key_reused",
    });
    expect(f.apply).toHaveBeenCalledTimes(1);
  });
  it("stores and replays a rejected move, returning only its public error", async () => {
    const f = fixture();
    await f.initialize();
    const operation = f.operation("reject-key", "reject");
    const response = await f.request(operation);
    expect(response).toMatchObject({ status: 422, body: { error: "test_rejected" } });
    expect(await f.request(operation)).toEqual(response);
    expect(f.apply).not.toHaveBeenCalled();
  });
  it("rejects a corrupted snapshot after bounded strong retries without writing state", async () => {
    const f = fixture(2, 400000);
    await f.initialize();
    const entry = [...f.rows.entries()].find(([, row]) => row.data instanceof Uint8Array);
    if (!entry) throw new Error("Fixture chunk missing");
    const [key, row] = entry;
    const bytes = Buffer.from(row.data as Uint8Array);
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    f.rows.set(key, { ...row, data: bytes });
    await expect(f.store.read(f.event.eventId, f.artifact.problemId)).rejects.toMatchObject({
      status: 503,
      code: "coordination_snapshot_invalid",
    });
    expect(f.writes).toHaveLength(1);
  });
  it("rejects partial or mixed chunks and retries until one consistent snapshot is available", async () => {
    const f = fixture(2, 400000);
    const run = await f.initialize();
    let reads = 0;
    f.setAfterRead((responses) => {
      if (reads++ === 0) {
        const first = responses[0];
        if (first?.Item) first.Item.revision = 99;
      }
    });
    expect((await f.store.read(f.event.eventId, f.artifact.problemId))?.match).toEqual(run.match);
    expect(reads).toBe(2);
  });
  it("accepts the atomic snapshot when only admission ownership changes after the sizing read", async () => {
    const f = fixture();
    const run = await f.initialize();
    let reads = 0;
    f.setAfterGet((key) => {
      if (key?.SK !== "HEAD") return;
      currentHead(f).admissionOwner =
        `00000000-0000-4000-8000-${String(++reads).padStart(12, "0")}`;
      currentHead(f).admissionExpiresAt = NOW + 5000;
    });
    expect((await f.store.read(f.event.eventId, f.artifact.problemId))?.match).toEqual(run.match);
    expect(reads).toBe(1);
    expect(f.writes).toHaveLength(1);
  });
  it("rejects a foreign event in the transactional HEAD despite matching chunk count and bytes", async () => {
    const f = fixture();
    await f.initialize();
    f.setAfterRead((responses) => {
      const head = responses.at(-1)?.Item;
      if (head?.SK === "HEAD") head.eventId = ulid();
    });
    await expect(f.store.read(f.event.eventId, f.artifact.problemId)).rejects.toMatchObject({
      status: 503,
      code: "coordination_scope_invalid",
    });
    expect(f.writes).toHaveLength(1);
  });
  it.each([0, 400000])(
    "uses the transaction's published revision and retries only when its chunk count changes (%i padding)",
    async (padding) => {
      const f = fixture(2, padding);
      await f.initialize();
      const before = structuredClone(f.rows);
      await f.request(f.operation("snapshot-transition", "shrink"));
      const after = structuredClone(f.rows);
      const expected = await f.store.read(f.event.eventId, f.artifact.problemId);
      f.rows.clear();
      for (const [key, row] of before) f.rows.set(key, row);
      let reads = 0;
      f.setAfterGet((key) => {
        if (key?.SK !== "HEAD" || ++reads !== 1) return;
        f.rows.clear();
        for (const [key, row] of after) f.rows.set(key, row);
      });
      expect(await f.store.read(f.event.eventId, f.artifact.problemId)).toEqual(expected);
      expect(reads).toBe(padding === 0 ? 1 : 2);
    },
  );
  it("deletes no-longer-used fixed current chunks in the same state transition", async () => {
    const f = fixture(2, 795000);
    await f.initialize();
    await f.request(f.operation("shrink-key", "shrink"));
    const writes = f.writes.at(-1) ?? [];
    expect(writes.filter((item) => item.Delete)).toHaveLength(3);
    expect((await f.store.read(f.event.eventId, f.artifact.problemId))?.match.state).toMatchObject({
      padding: "",
    });
  });
  it("retries a rejected transaction without committing partial state/score/receipt writes", async () => {
    const f = fixture();
    await f.initialize();
    let failed = false;
    f.setBeforeWrite((items) => {
      if (!failed && admissionPublication(items)) {
        failed = true;
        throw cancelled();
      }
    });
    expect((await f.request()).body).toEqual({ projection: { score: 1 } });
    expect(f.apply).toHaveBeenCalledTimes(2);
    expect(f.writes).toHaveLength(4);
    expect(f.releases).toHaveLength(1);
    expect(
      (await f.store.read(f.event.eventId, f.artifact.problemId))?.match.scores[f.team.teamId],
    ).toBe(1);
  });
  it("rechecks a rotated actor after a transaction loses its authorization race", async () => {
    const f = fixture();
    await f.initialize();
    f.setBeforeWrite(() => {
      f.rows.set(rowKey("teams", teamKey(f.event.eventId, f.team.teamId)), {
        ...f.team,
        authVersion: 2,
      });
      throw cancelled();
    });
    await expect(f.request()).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    expect(f.writes).toHaveLength(1);
  });
  it("rejects oversize state and unsafe JSON before any transaction is submitted", async () => {
    const f = fixture(2, 2 * 1024 * 1024);
    await expect(f.initialize()).rejects.toMatchObject({
      status: 503,
      code: "coordination_state_too_large",
    });
    expect(f.writes).toHaveLength(0);
    const g = fixture();
    const artifact = {
      ...g.artifact,
      plugin: { ...g.artifact.plugin, initialState: () => ({ invalid: Number.NaN }) },
    };
    await expect(
      g.store.initialize({ event: g.event, teams: g.teams, artifact, now: NOW }),
    ).rejects.toMatchObject({ status: 503, code: "coordination_state_invalid" });
    expect(g.writes).toHaveLength(0);
  });
  it("requires initialized state and exact immutable artifact/schema pins", async () => {
    const f = fixture();
    await expect(f.request()).rejects.toMatchObject({ status: 409, code: "not_running" });
    await f.initialize();
    const wrong = contentDigest("different");
    await expect(
      f.store.request({
        event: f.event,
        team: f.team,
        artifact: { ...f.artifact, artifactDigest: wrong, pluginKey: `plugins/${wrong}.mjs` },
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ code: "coordination_artifact_changed" });
    await expect(
      f.store.request({
        event: f.event,
        team: f.team,
        artifact: { ...f.artifact, plugin: { ...f.artifact.plugin, stateSchemaVersion: 2 } },
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ code: "coordination_artifact_changed" });
    expect(f.writes).toHaveLength(1);
  });
  it("settles lock/unlock clock debt with the event update and freezes the final projection", async () => {
    const f = fixture();
    await f.initialize();
    const locked = await f.store.changeSchedule({
      event: f.event,
      artifact: f.artifact,
      patch: { scoringLocked: true },
      now: () => NOW + 10_000,
    });
    let run = await f.store.read(f.event.eventId, f.artifact.problemId);
    expect(run?.clock).toEqual({ pausedMs: 0, elapsedMs: 10_000, lockedAt: NOW + 10_000 });
    const lockWrites = f.writes.at(-1) ?? [];
    expect(lockWrites.some((item) => item.Put?.Item?.SK === "HEAD")).toBe(true);
    expect(lockWrites.some((item) => item.Update?.TableName === "events")).toBe(true);
    const unlocked = await f.store.changeSchedule({
      event: locked,
      artifact: f.artifact,
      patch: { scoringLocked: false },
      now: () => NOW + 15_000,
    });
    run = await f.store.read(f.event.eventId, f.artifact.problemId);
    expect(run?.clock).toEqual({ pausedMs: 5000, elapsedMs: 10_000 });
    await f.store.request({
      event: unlocked,
      team: f.team,
      artifact: f.artifact,
      operation: f.operation(),
      now: () => NOW + 20_000,
    });
    run = await f.store.read(f.event.eventId, f.artifact.problemId);
    expect(run?.clock.elapsedMs).toBe(15_000);
    const ended = await f.store.changeSchedule({
      event: unlocked,
      artifact: f.artifact,
      patch: { status: "ENDED", endsAt: new Date(NOW + 20_000).toISOString(), scoringLocked: true },
      close: true,
      now: () => NOW + 20_000,
    });
    const writesBeforeFinal = f.writes.length;
    const final = await f.store.request({
      event: ended,
      team: f.team,
      artifact: f.artifact,
      now: () => NOW + 30_000,
    });
    expect(final.body).toEqual({ projection: { score: 1 } });
    expect(f.writes).toHaveLength(writesBeforeFinal);
    expect(authorizationReads(f).at(-1)).toHaveLength(4);
    await expect(
      f.store.request({
        event: ended,
        team: f.team,
        artifact: f.artifact,
        operation: f.operation("ended-key"),
        now: () => NOW + 30_000,
      }),
    ).rejects.toMatchObject({ status: 422, code: "event_ended" });
    expect(f.apply).toHaveBeenCalledTimes(1);
  });
  it("checks the server clock again before submission after the event ends during a read", async () => {
    const f = fixture();
    await f.initialize();
    let ticks = 0;
    const event = { ...f.event, endsAt: new Date(NOW + 500).toISOString() };
    await expect(
      f.store.request({
        event,
        team: f.team,
        artifact: f.artifact,
        operation: f.operation(),
        now: () => (ticks++ < 2 ? NOW : NOW + 1000),
      }),
    ).rejects.toMatchObject({ status: 422, code: "event_ended" });
    expect(ticks).toBeGreaterThanOrEqual(3);
    expect(f.writes).toHaveLength(2);
    expect(f.releases).toHaveLength(1);
    expect(f.writes.some((items) => admissionPublication(items))).toBe(false);
  });
  it("prevents organizer rewind of a started native run", async () => {
    const f = fixture();
    await f.initialize();
    await expect(
      f.store.changeSchedule({
        event: f.event,
        artifact: f.artifact,
        patch: { startsAt: new Date(NOW + 60_000).toISOString() },
        now: () => NOW + 1000,
      }),
    ).rejects.toMatchObject({ status: 409, code: "coordination_start_already_fixed" });
    expect(f.writes).toHaveLength(1);
  });
  it("chunks large immutable operation receipts and rejects tampered replay bytes", async () => {
    const f = fixture();
    const artifact = {
      ...f.artifact,
      plugin: {
        ...f.artifact.plugin,
        projectForTeam: () => ({ publicPayload: "p".repeat(600000) }),
      },
    };
    const initialized = await f.store.initialize({
      event: f.event,
      teams: f.teams,
      artifact,
      now: NOW,
    });
    const input = {
      event: f.event,
      team: f.team,
      artifact,
      now: () => NOW,
      operation: f.operation(),
    };
    const response = await f.store.request(input);
    expect(JSON.stringify(response.body)).not.toContain(initialized.match.matchSecret);
    const chunks = (f.writes.at(-1) ?? []).flatMap((item) =>
      String(item.Put?.Item?.SK).startsWith("RECEIPT#") &&
      item.Put?.Item?.data instanceof Uint8Array
        ? [item.Put.Item]
        : [],
    );
    expect(chunks).toHaveLength(3);
    expect(
      chunks.every((row) => (row.data as Uint8Array).byteLength <= COORDINATION_CHUNK_BYTES),
    ).toBe(true);
    expect(await f.store.request(input)).toEqual(response);
    const entry = [...f.rows.entries()].find(
      ([, row]) => String(row.SK).startsWith("RECEIPT#") && row.data instanceof Uint8Array,
    );
    if (!entry) throw new Error("Receipt chunk is missing");
    const [key, row] = entry;
    f.rows.set(key, { ...row, data: Buffer.alloc((row.data as Uint8Array).byteLength) });
    const writesBefore = f.writes.length;
    await expect(f.store.request(input)).rejects.toMatchObject({
      status: 503,
      code: "coordination_receipt_invalid",
    });
    expect(f.writes).toHaveLength(writesBefore);
  });
  it("does not commit state or score when the projected receipt is above its size limit", async () => {
    const f = fixture();
    const artifact = {
      ...f.artifact,
      plugin: {
        ...f.artifact.plugin,
        projectForTeam: () => ({ publicPayload: "p".repeat(2 * 1024 * 1024) }),
      },
    };
    await f.store.initialize({ event: f.event, teams: f.teams, artifact, now: NOW });
    await expect(
      f.store.request({
        event: f.event,
        team: f.team,
        artifact,
        now: () => NOW,
        operation: f.operation(),
      }),
    ).rejects.toMatchObject({ status: 503, code: "coordination_response_too_large" });
    expect(f.writes).toHaveLength(2);
    expect(f.releases).toHaveLength(1);
    expect(f.writes.some((items) => admissionPublication(items))).toBe(false);
    expect(
      (await f.store.read(f.event.eventId, artifact.problemId))?.match.scores[f.team.teamId],
    ).toBe(0);
  });
  it("propagates an actual service failure without inventing success or consuming a receipt", async () => {
    const f = fixture();
    await f.initialize();
    const failure = Object.assign(new Error("synthetic service outage"), {
      name: "InternalServerError",
    });
    f.setBeforeWrite(() => {
      throw failure;
    });
    await expect(f.request()).rejects.toBe(failure);
    expect(f.writes).toHaveLength(1);
    expect(
      (await f.store.read(f.event.eventId, f.artifact.problemId))?.match.scores[f.team.teamId],
    ).toBe(0);
  });
  it("uses the same current-pin production factory for operator closure and returns its committed event", async () => {
    const f = fixture();
    const source =
      "export default {initialState:()=>({}),validateOp:()=>({ok:true}),applyOp:s=>s,projectForTeam:(s,id)=>({score:s.scores[id]}),teamScores:s=>s.scores};";
    const artifactDigest = contentDigest(source);
    const descriptor = {
      kind: "coordination",
      problemId: "ac26-crypto-battle",
      problemDir: "problems/battles/ac26-crypto-battle",
      artifactDigest,
      pluginKey: `plugins/${artifactDigest}.mjs`,
      stateBudget: { bytesPerTeam: 31744, baseBytes: 1536 },
      name: "Synthetic reviewed game",
      description: "Test",
      instructions: "Test",
    };
    const raw = JSON.stringify({ version: 1, problems: [], nativeProblems: [descriptor] });
    const catalogKey = `catalogs/${contentDigest(raw)}.json`;
    await f.store.initialize({
      event: f.event,
      teams: f.teams,
      artifact: { ...f.artifact, artifactDigest, pluginKey: descriptor.pluginKey, catalogKey },
      now: NOW,
    });
    const send = vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command) => {
      if (!(command instanceof GetObjectCommand)) throw new Error("Unexpected S3 command");
      expect(command.input.ExpectedBucketOwner).toBe("123456789012");
      const text = command.input.Key === catalogKey ? raw : source;
      return {
        ContentLength: Buffer.byteLength(text),
        Body: { transformToString: async () => text },
      };
    });
    const factory = createProductionNativeCoordination({
      repository: new DynamoCloudRepository(f.document, f.tables),
      store: f.store,
      artifactBucket: "synthetic-artifacts",
      region: "us-east-1",
      catalogKey,
      expectedBucketOwner: "123456789012",
    });
    const event = await factory.closeEvent(f.event.eventId, NOW + 1000);
    expect(event).toMatchObject({
      eventId: f.event.eventId,
      status: "TEARDOWN",
      scoringLocked: true,
      endsAt: new Date(NOW + 1000).toISOString(),
    });
    expect((await f.store.read(f.event.eventId, f.artifact.problemId))?.closed).toBe(true);
    expect(send).toHaveBeenCalled();
    const archived = archivedEvent(f, event);
    const repository = new DynamoCloudRepository(f.document, f.tables);
    const work = new DynamoDeploymentWork(f.document, f.tables);
    const writesBefore = f.writes.length;
    const replay = await requestEventTeardown({
      repository,
      work,
      eventId: archived.eventId,
      now: NOW + 2000,
      beforeClose: (current) => factory.closeEvent(current.eventId, NOW + 2000),
    });
    expect(replay).toEqual({
      status: 200,
      body: { eventId: archived.eventId, enqueued: 0, skipped: 0, failed: 0 },
    });
    expect(f.writes).toHaveLength(writesBefore);
  });
  it("does not initialize native state or fetch code when closing an event without a native HEAD", async () => {
    const f = fixture();
    const send = vi
      .spyOn(S3Client.prototype, "send")
      .mockRejectedValue(new Error("Unexpected artifact request"));
    const factory = createProductionNativeCoordination({
      repository: new DynamoCloudRepository(f.document, f.tables),
      store: f.store,
      artifactBucket: "synthetic-artifacts",
      region: "us-east-1",
      catalogKey: f.artifact.catalogKey,
      expectedBucketOwner: "123456789012",
    });
    expect(await factory.closeEvent(f.event.eventId, NOW + 1000)).toEqual(f.event);
    expect(f.writes).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });
  it.each(["READY", "TEARDOWN", "ARCHIVED"] as const)(
    "refuses closeEvent for an open native HEAD even when event status is %s",
    async (status) => {
      const f = fixture();
      await f.initialize();
      const work = new DynamoDeploymentWork(f.document, f.tables);
      await expect(
        work.closeEvent({ ...f.event, status }, new Date(NOW + 1000).toISOString()),
      ).rejects.toMatchObject({ status: 409, code: "coordination_not_settled" });
      expect(f.writes).toHaveLength(1);
    },
  );
  it("pins a verified closed snapshot into closeEvent and revalidates the snapshot on replay", async () => {
    const f = fixture();
    await f.initialize();
    const closed = await f.store.changeSchedule({
      event: f.event,
      artifact: f.artifact,
      patch: { scoringLocked: true },
      close: true,
      now: () => NOW + 1000,
    });
    const work = new DynamoDeploymentWork(f.document, f.tables);
    expect(await work.closeEvent(closed, new Date(NOW + 2000).toISOString())).toBe("closing");
    const writes = f.writes.at(-1) ?? [];
    const fence = writes.find(
      (item) => item.ConditionCheck?.TableName === f.tables.deployments,
    )?.ConditionCheck;
    expect(fence).toMatchObject({
      Key: coordinationHeadKey(f.event.eventId, f.artifact.problemId),
      ConditionExpression: expect.stringContaining("snapshotDigest = :digest"),
    });
    expect(fence?.ExpressionAttributeValues?.[":closed"]).toBe(true);
    const current = await new DynamoCloudRepository(f.document, f.tables).getEvent(f.event.eventId);
    if (!current) throw new Error("Closed event missing");
    const count = f.writes.length;
    expect(await work.closeEvent(current, new Date(NOW + 3000).toISOString())).toBe("closing");
    expect(f.writes).toHaveLength(count);
    corruptStateChunk(f);
    await expect(
      work.closeEvent(current, new Date(NOW + 4000).toISOString()),
    ).rejects.toMatchObject({ status: 503, code: "coordination_snapshot_invalid" });
  });
  it("holds archiveTeardown behind an atomic absent-or-closed HEAD condition", async () => {
    const f = fixture();
    await f.initialize();
    const closing: EventRecord = {
      ...f.event,
      status: "TEARDOWN",
      teardownExpected: 0,
      teardownCompleted: 0,
    };
    f.rows.set(rowKey(f.tables.events, eventKey(f.event.eventId)), {
      ...closing,
      ...eventKey(f.event.eventId),
    });
    const work = new DynamoDeploymentWork(f.document, f.tables);
    let captured: Write[] = [];
    f.setBeforeWrite((items) => {
      const fence = items.find(
        (item) =>
          item.ConditionCheck?.TableName === f.tables.deployments &&
          item.ConditionCheck.Key?.SK === "HEAD",
      )?.ConditionCheck;
      if (!fence) return;
      captured = items;
      expect(fence.ConditionExpression).toBe(
        "attribute_not_exists(PK) OR (#closed = :yes AND attribute_exists(snapshotDigest) AND attribute_exists(revision) AND chunkCount > :zero)",
      );
      const head = f.rows.get(rowKey(f.tables.deployments, fence.Key));
      if (head && !head.closed) throw cancelled();
    });
    expect(await work.archiveTeardown(f.event.eventId)).toBe(false);
    expect(
      captured.some((item) =>
        item.Update?.ConditionExpression?.includes("teardownCompleted = teardownExpected"),
      ),
    ).toBe(true);
    expect(f.rows.get(rowKey(f.tables.events, eventKey(f.event.eventId)))?.status).toBe("TEARDOWN");
    await f.store.changeSchedule({
      event: closing,
      artifact: f.artifact,
      patch: { scoringLocked: true },
      close: true,
      now: () => NOW + 1000,
    });
    expect(await work.archiveTeardown(f.event.eventId)).toBe(true);
    expect(f.rows.get(rowKey(f.tables.events, eventKey(f.event.eventId)))?.status).toBe("ARCHIVED");
  });
  it("retains ordinary archive compatibility when no native HEAD exists", async () => {
    const f = fixture();
    f.rows.set(rowKey(f.tables.events, eventKey(f.event.eventId)), {
      ...f.event,
      ...eventKey(f.event.eventId),
      status: "TEARDOWN",
      teardownExpected: 0,
      teardownCompleted: 0,
    });
    const work = new DynamoDeploymentWork(f.document, f.tables);
    expect(await work.archiveTeardown(f.event.eventId)).toBe(true);
    expect(
      (f.writes.at(-1) ?? []).find((item) => item.ConditionCheck)?.ConditionCheck,
    ).toMatchObject({
      Key: coordinationHeadKey(f.event.eventId, f.artifact.problemId),
      ConditionExpression: expect.stringContaining("attribute_not_exists(PK) OR"),
    });
  });
  it("does not mark an installation drained when archived event counters conceal an open native run", async () => {
    const f = fixture();
    await f.initialize();
    archivedEvent(f);
    drainingInstallation(f);
    const repository = new DynamoCloudRepository(f.document, f.tables);
    await expect(
      repository.confirmInstallationDrained(scope, new Date(NOW + 2000).toISOString()),
    ).rejects.toMatchObject({ status: 409, code: "coordination_not_settled" });
    expect(f.rows.get(rowKey(f.tables.events, installationControlKey))?.status).toBe("DRAINING");
    expect(f.writes).toHaveLength(1);
  });
  it("checks every closed native chunk before drain, despite archived status and matching counters", async () => {
    const f = fixture(2, 400000);
    await f.initialize();
    await closeAndArchive(f);
    drainingInstallation(f);
    corruptStateChunk(f);
    const count = f.writes.length;
    const repository = new DynamoCloudRepository(f.document, f.tables);
    await expect(
      repository.confirmInstallationDrained(scope, new Date(NOW + 2000).toISOString()),
    ).rejects.toMatchObject({ status: 503, code: "coordination_snapshot_invalid" });
    expect(f.writes).toHaveLength(count);
    expect(f.rows.get(rowKey(f.tables.events, installationControlKey))?.status).toBe("DRAINING");
  });
  it("accepts complete closed native snapshots and rechecks them even on DRAINED replay", async () => {
    const f = fixture();
    await f.initialize();
    await closeAndArchive(f);
    drainingInstallation(f);
    const repository = new DynamoCloudRepository(f.document, f.tables);
    await repository.confirmInstallationDrained(scope, new Date(NOW + 2000).toISOString());
    expect(f.rows.get(rowKey(f.tables.events, installationControlKey))?.status).toBe("DRAINED");
    const count = f.writes.length;
    const reads = f.send.mock.calls.filter(
      ([command]) => command instanceof TransactGetCommand,
    ).length;
    await repository.confirmInstallationDrained(scope, new Date(NOW + 3000).toISOString());
    expect(f.writes).toHaveLength(count);
    expect(
      f.send.mock.calls.filter(([command]) => command instanceof TransactGetCommand).length,
    ).toBeGreaterThan(reads);
    expect(
      f.send.mock.calls
        .filter(([command]) => command instanceof ScanCommand)
        .every(
          ([command]) => command instanceof ScanCommand && command.input.ConsistentRead === true,
        ),
    ).toBe(true);
    corruptStateChunk(f);
    await expect(
      repository.confirmInstallationDrained(scope, new Date(NOW + 4000).toISOString()),
    ).rejects.toMatchObject({ status: 503, code: "coordination_snapshot_invalid" });
  });
  it("authorizes unchanged polling with one atomic read and no transaction writes", async () => {
    const f = fixture();
    await f.initialize();
    const writesBefore = f.writes.length;
    expect(
      await f.store.request({ event: f.event, team: f.team, artifact: f.artifact, now: () => NOW }),
    ).toMatchObject({ status: 200, body: { projection: { score: 0 } } });
    expect(f.writes).toHaveLength(writesBefore);
    expect(authorizationReads(f)).toHaveLength(1);
    expect(authorizationReads(f)[0]).toHaveLength(4);
  });
  it.each(["projection", "replay"] as const)(
    "rejects a rotated team at the final atomic %s authorization point",
    async (mode) => {
      const f = fixture();
      await f.initialize();
      if (mode === "replay") await f.request();
      const count = f.writes.length;
      f.setAfterRead((responses, items) => {
        if (!isAuthorizationRead(items)) return;
        const changed = { ...f.team, authVersion: f.team.authVersion + 1 };
        f.rows.set(rowKey(f.tables.teams, teamKey(f.event.eventId, f.team.teamId)), changed);
        const response = responses[1];
        if (response) response.Item = changed;
      });
      const pending =
        mode === "replay"
          ? f.request()
          : f.store.request({ event: f.event, team: f.team, artifact: f.artifact, now: () => NOW });
      await expect(pending).rejects.toMatchObject({ status: 401, code: "unauthorized" });
      expect(f.writes).toHaveLength(count);
      expect(f.apply).toHaveBeenCalledTimes(mode === "replay" ? 1 : 0);
    },
  );
  it.each(["revoked", "expired"] as const)(
    "rejects a %s actor in the final atomic read",
    async (cause) => {
      const f = fixture();
      await f.initialize();
      const count = f.writes.length;
      f.setAfterRead((responses, items) => {
        if (!isAuthorizationRead(items)) return;
        const changed = {
          ...f.team,
          ...(cause === "revoked" ? { accessRevoked: true } : { expiresAt: NOW / 1000 }),
        };
        f.rows.set(rowKey(f.tables.teams, teamKey(f.event.eventId, f.team.teamId)), changed);
        const response = responses[1];
        if (response) response.Item = changed;
      });
      await expect(
        f.store.request({ event: f.event, team: f.team, artifact: f.artifact, now: () => NOW }),
      ).rejects.toMatchObject({ status: 401, code: "unauthorized" });
      expect(f.writes).toHaveLength(count);
    },
  );
  it.each(["projection", "replay"] as const)(
    "refuses a changed event in final atomic %s authorization",
    async (mode) => {
      const f = fixture();
      await f.initialize();
      if (mode === "replay") await f.request();
      const count = f.writes.length;
      f.setAfterRead((responses, items) => {
        if (!isAuthorizationRead(items)) return;
        const changed = {
          ...f.event,
          ...eventKey(f.event.eventId),
          updatedAt: new Date(NOW + 1).toISOString(),
          scoringLocked: true,
        };
        f.rows.set(rowKey(f.tables.events, eventKey(f.event.eventId)), changed);
        const response = responses[0];
        if (response) response.Item = changed;
      });
      const pending =
        mode === "replay"
          ? f.request()
          : f.store.request({ event: f.event, team: f.team, artifact: f.artifact, now: () => NOW });
      await expect(pending).rejects.toMatchObject({ status: 409, code: "event_changed" });
      expect(f.writes).toHaveLength(count);
    },
  );
  it.each(["projection", "replay"] as const)(
    "retries a changed HEAD before returning an authorized %s",
    async (mode) => {
      const f = fixture();
      await f.initialize();
      await f.request();
      const before = new Map([...f.rows].map(([key, row]) => [key, structuredClone(row)]));
      await f.request(f.operation("concurrent-move"));
      const after = new Map([...f.rows].map(([key, row]) => [key, structuredClone(row)]));
      f.rows.clear();
      for (const [key, row] of before) f.rows.set(key, row);
      let changed = false;
      f.setAfterRead((responses, items) => {
        if (!isAuthorizationRead(items) || changed) return;
        changed = true;
        f.rows.clear();
        for (const [key, row] of after) f.rows.set(key, structuredClone(row));
        const head = responses[2];
        if (head)
          head.Item = structuredClone(
            f.rows.get(
              rowKey(
                f.tables.deployments,
                coordinationHeadKey(f.event.eventId, f.artifact.problemId),
              ),
            ),
          );
      });
      const count = f.writes.length;
      const reads = authorizationReads(f).length;
      const response =
        mode === "replay"
          ? await f.request()
          : await f.store.request({
              event: f.event,
              team: f.team,
              artifact: f.artifact,
              now: () => NOW,
            });
      expect(response.body).toEqual({ projection: { score: mode === "replay" ? 1 : 2 } });
      expect(authorizationReads(f).length).toBeGreaterThan(reads + 1);
      expect(f.writes).toHaveLength(count);
      expect(f.apply).toHaveBeenCalledTimes(2);
    },
  );
  it.each(["projection", "replay"] as const)(
    "rejects a stopped installation discovered in final atomic %s authorization",
    async (mode) => {
      const f = fixture();
      await f.initialize();
      if (mode === "replay") await f.request();
      const count = f.writes.length;
      f.setAfterRead((responses, items) => {
        if (!isAuthorizationRead(items)) return;
        drainingInstallation(f);
        const response = responses[3];
        if (response)
          response.Item = structuredClone(
            f.rows.get(rowKey(f.tables.events, installationControlKey)),
          );
      });
      const pending =
        mode === "replay"
          ? f.request()
          : f.store.request({ event: f.event, team: f.team, artifact: f.artifact, now: () => NOW });
      await expect(pending).rejects.toMatchObject({ status: 409, code: "coordination_conflict" });
      expect(f.writes).toHaveLength(count);
      expect(f.apply).toHaveBeenCalledTimes(mode === "replay" ? 1 : 0);
    },
  );
  it("rechecks the server clock after the final replay authorization read", async () => {
    const f = fixture();
    await f.initialize();
    await f.request();
    const event = { ...f.event, endsAt: new Date(NOW + 500).toISOString() };
    f.rows.set(rowKey(f.tables.events, eventKey(event.eventId)), {
      ...event,
      ...eventKey(event.eventId),
    });
    let now = NOW;
    f.setAfterRead((_responses, items) => {
      if (isAuthorizationRead(items)) now = NOW + 1000;
    });
    const count = f.writes.length;
    await expect(
      f.store.request({
        event,
        team: f.team,
        artifact: f.artifact,
        now: () => now,
        operation: f.operation(),
      }),
    ).rejects.toMatchObject({ status: 422, code: "event_ended" });
    expect(f.writes).toHaveLength(count);
    expect(f.apply).toHaveBeenCalledTimes(1);
  });
  it("retries a final read transaction conflict without converting polling into a write", async () => {
    const f = fixture();
    await f.initialize();
    let conflicted = false;
    f.setAfterRead((_responses, items) => {
      if (isAuthorizationRead(items) && !conflicted) {
        conflicted = true;
        throw cancelled();
      }
    });
    const count = f.writes.length;
    expect(
      (
        await f.store.request({
          event: f.event,
          team: f.team,
          artifact: f.artifact,
          now: () => NOW,
        })
      ).body,
    ).toEqual({ projection: { score: 0 } });
    expect(authorizationReads(f)).toHaveLength(2);
    expect(f.writes).toHaveLength(count);
  });
  it("propagates a final read service failure instead of exposing an unauthenticated projection", async () => {
    const f = fixture();
    await f.initialize();
    const count = f.writes.length;
    const failure = Object.assign(new Error("synthetic final authorization failure"), {
      name: "InternalServerError",
    });
    f.setAfterRead((_responses, items) => {
      if (isAuthorizationRead(items)) throw failure;
    });
    await expect(
      f.store.request({ event: f.event, team: f.team, artifact: f.artifact, now: () => NOW }),
    ).rejects.toBe(failure);
    expect(f.writes).toHaveLength(count);
    expect(f.apply).not.toHaveBeenCalled();
  });
});
