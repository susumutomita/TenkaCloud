import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMatch } from "../../../scripts/local-host/coordination-core.js";
import {
  NativeCoordinationError,
  type NativeCoordinationRun,
} from "../../lib/problem-deploy/control-data/domain/coordination.js";
import {
  contentDigest,
  DeploymentConflict,
  type DeploymentJob,
} from "../../lib/problem-deploy/control-data/domain/deployment-work.js";
import type { EventRecord } from "../../lib/problem-deploy/control-data/domain/events.js";
import type { TeamRecord } from "../../lib/problem-deploy/control-data/domain/teams.js";
import { DynamoDeploymentWork } from "../../lib/problem-deploy/control-data/dynamodb-deployment-work.js";
import { DynamoDeploymentsCoordination } from "../../lib/problem-deploy/control-data/dynamodb-deployments-coordination.js";
import { createCloudApp } from "../../lib/problem-deploy/handlers/cloud-api/app.js";
import { settleNativeEvent } from "../../lib/problem-deploy/handlers/cloud-api/coordination-routes.js";
import { requestEventTeardown } from "../../lib/problem-deploy/handlers/cloud-api/deployment-routes.js";
import type { NativeProblem } from "../../lib/problem-deploy/handlers/cloud-api/execution-config.js";
import { FakeRepository } from "./fake-repository.js";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const AT = new Date(NOW).toISOString();
const AUTH = { issuer: "https://cognito-idp.us-east-1.amazonaws.com/pool", audience: "client" };
const plugin = {
  initialState: () => ({ secret: "server-only" }),
  validateOp: () => ({ ok: true as const }),
  applyOp: (state: unknown) => state,
  projectForTeam: () => ({ safe: true }),
  teamScores: () => ({}),
};
const clients: DynamoDBClient[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) client.destroy();
});
function fixture() {
  const repository = new FakeRepository();
  const event: EventRecord = {
    eventId: "01K00000000000000000000001",
    name: "Native Battle",
    status: "DRAFT",
    teamCount: 2,
    problems: [{ problemId: "ac26-crypto-battle", defaultRegion: "us-east-1" }],
    createdAt: AT,
    updatedAt: AT,
    expiresAt: NOW / 1000 + 86400,
    startsAt: AT,
  };
  const teams: TeamRecord[] = ["01K00000000000000000000002", "01K00000000000000000000003"].map(
    (teamId, index) => ({
      eventId: event.eventId,
      teamId,
      internalSlug: `team-${index}`,
      teamLoginKey: String(index).repeat(43),
      authVersion: 1,
      accessRevoked: false,
      createdAt: AT,
      updatedAt: AT,
      expiresAt: event.expiresAt,
    }),
  );
  const team = teams[0];
  if (!team) throw new Error("Fixture roster is empty.");
  repository.events.set(event.eventId, event);
  for (const item of teams) repository.teams.set(`${event.eventId}/${item.teamId}`, item);
  const artifactDigest = contentDigest("reviewed-native-plugin");
  const descriptor: NativeProblem = {
    kind: "coordination",
    problemId: "ac26-crypto-battle",
    problemDir: "problems/battles/ac26-crypto-battle",
    artifactDigest,
    pluginKey: `plugins/${artifactDigest}.mjs`,
    catalogKey: `catalogs/${contentDigest("reviewed-catalog")}.json`,
    stateBudget: { bytesPerTeam: 31744, baseBytes: 1536 },
    name: "Cryptography Battle",
    description: "Native game",
    instructions: "Play",
  };
  const run: NativeCoordinationRun = {
    eventId: event.eventId,
    problemId: descriptor.problemId,
    runId: "01K00000000000000000000004",
    revision: 3,
    artifactDigest,
    pluginKey: descriptor.pluginKey,
    catalogKey: descriptor.catalogKey,
    roster: teams.map((item) => ({ teamId: item.teamId, teamName: item.internalSlug })),
    match: createMatch(plugin, {
      eventId: event.eventId,
      teamIds: teams.map((item) => item.teamId),
    }),
    clock: { pausedMs: 0, elapsedMs: 0 },
    closed: false,
    updatedAt: AT,
  };
  const client = new DynamoDBClient({
    region: "us-east-1",
    credentials: { accessKeyId: "DUMMYIDEXAMPLE", secretAccessKey: "DUMMYEXAMPLEKEY" },
  });
  clients.push(client);
  const document = DynamoDBDocumentClient.from(client);
  const tables = { events: "events", teams: "teams", deployments: "deployments" };
  const store = new DynamoDeploymentsCoordination(document, tables);
  const work = new DynamoDeploymentWork(document, tables);
  const sdk = vi.spyOn(document, "send").mockRejectedValue(new Error("Unexpected AWS request"));
  const read = vi.spyOn(store, "read").mockResolvedValue(run);
  const summary = vi.spyOn(store, "summary").mockResolvedValue({
    eventId: run.eventId,
    problemId: run.problemId,
    runId: run.runId,
    revision: run.revision,
    closed: run.closed,
  });
  const purge = vi.spyOn(store, "purge").mockResolvedValue();
  const closeFence = vi.spyOn(store, "closeFence").mockResolvedValue({});
  const initialize = vi.spyOn(store, "initialize").mockResolvedValue(run);
  const reset = vi.spyOn(store, "reset").mockResolvedValue({
    eventId: event.eventId,
    problemId: run.problemId,
    runId: "01K00000000000000000000005",
    previousRunId: run.runId,
  });
  const request = vi
    .spyOn(store, "request")
    .mockResolvedValue({ status: 200, body: { projection: { safe: true } }, revision: 4 });
  const schedule = vi
    .spyOn(store, "changeSchedule")
    .mockImplementation(async (input) => ({ ...input.event, ...input.patch }));
  const history = vi.spyOn(store, "listScoreEvents").mockResolvedValue([]);
  vi.spyOn(work, "listScoreEvents").mockResolvedValue([]);
  const accepting = vi.spyOn(work, "acceptingNewDeployments").mockResolvedValue(true);
  const connection = vi.spyOn(work, "getConnection");
  const accept = vi.spyOn(work, "accept");
  const awsSchedule = vi.spyOn(work, "setSchedule").mockResolvedValue();
  const resolve = vi.fn(async () => ({ descriptor, plugin }));
  const app = createCloudApp({
    repository,
    now: () => NOW,
    organizerAuth: AUTH,
    allowedOrigins: [],
    deployment: { work, catalog: async () => ({}), controlPlaneAccount: "123456789012" },
    coordination: { store, catalog: async () => ({ [descriptor.problemId]: descriptor }), resolve },
  });
  const claims = {
    event: {
      requestContext: {
        authorizer: {
          claims: {
            sub: "organizer",
            iss: AUTH.issuer,
            aud: AUTH.audience,
            token_use: "id",
            exp: String(NOW / 1000 + 60),
            "custom:userRole": "Admin",
          },
        },
      },
    },
  };
  const organizer = (path: string, method = "POST", body: unknown = {}) =>
    app.request(
      path,
      { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } },
      claims,
    );
  const participant = (
    path: string,
    method = "GET",
    body?: unknown,
    key: string | null = "abcdefgh",
  ) =>
    app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${team.teamLoginKey}`,
        "content-type": "application/json",
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    app,
    repository,
    event,
    team,
    teams,
    run,
    descriptor,
    store,
    work,
    sdk,
    read,
    summary,
    purge,
    closeFence,
    initialize,
    reset,
    request,
    schedule,
    history,
    accepting,
    connection,
    accept,
    awsSchedule,
    resolve,
    organizer,
    claims,
    participant,
  };
}
describe("native Battle HTTP composition", () => {
  it("initializes the actual run for the full roster without competitor accounts or AWS jobs", async () => {
    const f = fixture();
    const response = await f.organizer(`/events/${f.event.eventId}/deploy`);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      eventId: f.event.eventId,
      enqueued: 0,
      initialized: 1,
      skipped: 0,
    });
    expect(f.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        event: f.event,
        teams: f.teams,
        now: NOW,
        artifact: expect.objectContaining({ plugin }),
      }),
    );
    expect(f.connection).not.toHaveBeenCalled();
    expect(f.accept).not.toHaveBeenCalled();
    expect(f.sdk).not.toHaveBeenCalled();
  });
  it("requires the complete native roster and rejects unsupported IDs", async () => {
    const f = fixture();
    expect(
      (await f.organizer(`/events/${f.event.eventId}/deploy`, "POST", { teamIds: [f.team.teamId] }))
        .status,
    ).toBe(400);
    expect(f.initialize).not.toHaveBeenCalled();
    expect(
      (
        await f.organizer("/events", "POST", {
          name: "Other",
          teams: [{ internalSlug: "a" }],
          problems: [{ problemId: "unknown", defaultRegion: "us-east-1" }],
        })
      ).status,
    ).toBe(409);
  });
  it("accepts native event creation using the explicit catalog union", async () => {
    const f = fixture();
    expect(
      (
        await f.organizer("/events", "POST", {
          name: "Native",
          teams: [{ internalSlug: "a" }],
          problems: f.event.problems,
        })
      ).status,
    ).toBe(201);
  });
  it("projects a persisted native run without fabricated AWS account or region", async () => {
    const f = fixture();
    const body = await (await f.participant("/portal/me")).json();
    expect(body.problems).toEqual([
      expect.objectContaining({
        jobId: f.run.runId,
        runtimeKind: "coordination",
        coordination: true,
        accessCapabilities: [],
        stackOutputs: {},
        status: "COMPLETE",
      }),
    ]);
    for (const field of ["region", "awsAccountId", "provider", "match", "matchSecret"])
      expect(body.problems[0]).not.toHaveProperty(field);
    f.read.mockResolvedValueOnce(undefined);
    expect((await (await f.participant("/portal/me")).json()).problems).toEqual([]);
  });
  it("passes only authenticated identity and a required idempotency key into the atomic request", async () => {
    const f = fixture();
    const op = { kind: "ready" };
    const response = await f.participant("/portal/me/coordination/op", "POST", { op });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ projection: { safe: true } });
    const input = f.request.mock.calls[0]?.[0];
    expect(input).toMatchObject({
      event: f.event,
      team: f.team,
      operation: { key: "abcdefgh", hash: contentDigest(JSON.stringify({ op })), op },
    });
    expect(input?.now()).toBe(NOW);
    expect((await f.participant("/portal/me/coordination/op", "POST", { op }, null)).status).toBe(
      400,
    );
    expect(
      (
        await f.participant("/portal/me/coordination/op", "POST", {
          op,
          teamId: f.teams[1]?.teamId,
        })
      ).status,
    ).toBe(400);
    expect((await f.app.request("/portal/me/coordination/projection")).status).toBe(401);
  });
  it("forwards the caller's run fence and rejects malformed run identities", async () => {
    const f = fixture();
    const op = { kind: "ready" };
    expect(
      (await f.participant("/portal/me/coordination/op", "POST", { op, runId: f.run.runId }))
        .status,
    ).toBe(200);
    expect(f.request).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: {
          key: "abcdefgh",
          hash: contentDigest(JSON.stringify({ op })),
          op,
          runId: f.run.runId,
        },
      }),
    );
    f.request.mockClear();
    expect(
      (await f.participant("/portal/me/coordination/op", "POST", { op, runId: "bad-run" })).status,
    ).toBe(400);
    expect(f.request).not.toHaveBeenCalled();
    f.request.mockRejectedValueOnce(new NativeCoordinationError(409, "coordination_run_changed"));
    const stale = await f.participant("/portal/me/coordination/op", "POST", {
      op,
      runId: f.run.runId,
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "coordination_run_changed" });
  });
  it("does not initialize from a participant request and propagates rejected moves and transaction conflicts", async () => {
    const f = fixture();
    f.read.mockResolvedValueOnce(undefined);
    expect((await f.participant("/portal/me/coordination/projection")).status).toBe(404);
    expect(f.initialize).not.toHaveBeenCalled();
    f.request.mockResolvedValueOnce({ status: 422, body: { error: "invalid_op" }, revision: 4 });
    expect(
      (await f.participant("/portal/me/coordination/op", "POST", { op: { kind: "bad" } })).status,
    ).toBe(422);
    f.request.mockRejectedValueOnce(new NativeCoordinationError(401, "unauthorized"));
    expect((await f.participant("/portal/me/coordination/projection")).status).toBe(401);
    f.request.mockRejectedValueOnce(new DeploymentConflict("coordination_conflict"));
    expect((await f.participant("/portal/me/coordination/projection")).status).toBe(409);
  });
  it("settles schedule locks and explicit end through the native transaction", async () => {
    const f = fixture();
    expect((await f.organizer(`/events/${f.event.eventId}/lock-scoring`)).status).toBe(200);
    expect(f.schedule).toHaveBeenLastCalledWith(
      expect.objectContaining({ patch: { scoringLocked: true }, close: false }),
    );
    const end = await f.organizer(`/events/${f.event.eventId}/end`);
    expect(end.status).toBe(200);
    expect(await end.json()).toEqual({
      eventId: f.event.eventId,
      status: "ENDED",
      endsAt: AT,
      updatedDeployments: 0,
    });
    expect(f.schedule).toHaveBeenLastCalledWith(
      expect.objectContaining({
        patch: { status: "ENDED", endsAt: AT, scoringLocked: true },
        close: true,
      }),
    );
    expect(f.awsSchedule).not.toHaveBeenCalled();
    expect(f.purge).not.toHaveBeenCalled();
  });
  it("rejects uninitialized native events instead of taking the AWS-only End path", async () => {
    const f = fixture();
    f.read.mockResolvedValue(undefined);
    const response = await f.organizer(`/events/${f.event.eventId}/end`);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "coordination_not_initialized" });
    expect(f.schedule).not.toHaveBeenCalled();
    expect(f.awsSchedule).not.toHaveBeenCalled();
    expect(f.initialize).not.toHaveBeenCalled();
    expect(f.repository.events.get(f.event.eventId)).toEqual(f.event);
  });
  it("ends AWS-only events even when native support is configured, without reading a native run", async () => {
    const f = fixture();
    const aws = {
      ...f.event,
      status: "READY" as const,
      problems: [{ problemId: "hello-world", defaultRegion: "us-east-1" }],
    };
    f.repository.events.set(aws.eventId, aws);
    expect((await f.organizer(`/events/${aws.eventId}/end`)).status).toBe(200);
    expect(f.awsSchedule).toHaveBeenCalledWith(
      aws,
      { status: "ENDED", endsAt: AT, scoringLocked: true },
      new Date(NOW + 1).toISOString(),
    );
    expect(f.read).not.toHaveBeenCalled();
    expect(f.schedule).not.toHaveBeenCalled();
  });
});

describe("native Battle organizer reset", () => {
  const resetPath = (eventId: string, problemId = "ac26-crypto-battle") =>
    `/events/${eventId}/problems/${problemId}/coordination/reset`;

  it.each(["Admin", "Operator"])("allows %s to rotate the current reviewed run", async (role) => {
    const f = fixture();
    f.claims.event.requestContext.authorizer.claims["custom:userRole"] = role;
    const response = await f.organizer(resetPath(f.event.eventId), "POST", { runId: f.run.runId });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      eventId: f.event.eventId,
      problemId: f.run.problemId,
      runId: "01K00000000000000000000005",
      previousRunId: f.run.runId,
    });
    expect(f.read).toHaveBeenCalledWith(f.event.eventId, f.run.problemId);
    expect(f.resolve).toHaveBeenCalledExactlyOnceWith(f.run);
    expect(f.reset).toHaveBeenCalledExactlyOnceWith({
      event: f.event,
      artifact: {
        problemId: f.run.problemId,
        artifactDigest: f.run.artifactDigest,
        pluginKey: f.run.pluginKey,
        catalogKey: f.run.catalogKey,
        stateBudget: f.descriptor.stateBudget,
        plugin,
      },
      expectedRunId: f.run.runId,
      now: expect.any(Function),
    });
    expect(f.reset.mock.calls[0]?.[0].now()).toBe(NOW);
    expect(f.initialize).not.toHaveBeenCalled();
    expect(f.sdk).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "{}"])("accepts a legacy empty reset body (%s)", async (body) => {
    const f = fixture();
    const response = await f.app.request(
      resetPath(f.event.eventId),
      { method: "POST", ...(body === undefined ? {} : { body }) },
      f.claims,
    );
    expect(response.status).toBe(200);
    expect(f.reset).toHaveBeenCalledWith(expect.objectContaining({ expectedRunId: f.run.runId }));
  });

  it("rejects participant keys, missing authentication and read-only organizer roles", async () => {
    const f = fixture();
    const path = resetPath(f.event.eventId);
    expect((await f.app.request(path, { method: "POST" })).status).toBe(401);
    expect((await f.participant(path, "POST", {})).status).toBe(401);
    f.claims.event.requestContext.authorizer.claims["custom:userRole"] = "Viewer";
    const response = await f.organizer(path);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden_role" });
    expect(f.read).not.toHaveBeenCalled();
    expect(f.reset).not.toHaveBeenCalled();
  });

  it("returns 404 for absent events, unconfigured problems and uninitialized runs", async () => {
    const f = fixture();
    const missing = await f.organizer(resetPath("01K00000000000000000000009"));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found" });
    const otherProblem = await f.organizer(resetPath(f.event.eventId, "hello-world"));
    expect(otherProblem.status).toBe(404);
    expect(await otherProblem.json()).toEqual({ error: "coordination_not_configured" });
    expect(f.read).not.toHaveBeenCalled();
    f.read.mockResolvedValueOnce(undefined);
    const uninitialized = await f.organizer(resetPath(f.event.eventId));
    expect(uninitialized.status).toBe(404);
    expect(await uninitialized.json()).toEqual({ error: "coordination_not_initialized" });
    f.repository.events.set(f.event.eventId, {
      ...f.event,
      problems: [{ problemId: "hello-world", defaultRegion: "us-east-1" }],
    });
    const unconfigured = await f.organizer(resetPath(f.event.eventId));
    expect(unconfigured.status).toBe(404);
    expect(await unconfigured.json()).toEqual({ error: "coordination_not_configured" });
    expect(f.reset).not.toHaveBeenCalled();
  });

  it.each([{ eventId: "01K00000000000000000000009" }, { problemId: "hello-world" }])(
    "does not reset a run outside the requested event/problem scope (%s)",
    async (changes) => {
      const f = fixture();
      f.read.mockResolvedValueOnce({ ...f.run, ...changes });
      expect((await f.organizer(resetPath(f.event.eventId))).status).toBe(404);
      expect(f.reset).not.toHaveBeenCalled();
    },
  );

  it.each([
    { status: "ENDED" as const },
    { status: "TEARDOWN" as const },
    { status: "ARCHIVED" as const },
    { endsAt: AT },
  ])("rejects an ended event (%s)", async (changes) => {
    const f = fixture();
    f.repository.events.set(f.event.eventId, { ...f.event, ...changes });
    const response = await f.organizer(resetPath(f.event.eventId));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "event_ended" });
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.reset).not.toHaveBeenCalled();
  });

  it("rejects closed runs and stale reset retries before resolving an artifact", async () => {
    const f = fixture();
    f.read.mockResolvedValueOnce({ ...f.run, closed: true });
    const closed = await f.organizer(resetPath(f.event.eventId));
    expect(closed.status).toBe(409);
    expect(await closed.json()).toEqual({ error: "event_ended" });
    const stale = await f.organizer(resetPath(f.event.eventId), "POST", {
      runId: "01K00000000000000000000009",
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "run_rotation_conflict" });
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.reset).not.toHaveBeenCalled();
  });

  it.each([{ runId: "invalid" }, { eventId: "01K00000000000000000000009" }])(
    "rejects invalid reset input (%s)",
    async (body) => {
      const f = fixture();
      const response = await f.organizer(resetPath(f.event.eventId), "POST", body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_request" });
      expect(f.reset).not.toHaveBeenCalled();
    },
  );

  it("propagates atomic rotation conflicts and does not expose retired state", async () => {
    const f = fixture();
    f.reset.mockRejectedValueOnce(new NativeCoordinationError(409, "run_rotation_conflict"));
    const response = await f.organizer(resetPath(f.event.eventId));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "run_rotation_conflict" });
    expect(f.reset).toHaveBeenCalledWith(expect.objectContaining({ expectedRunId: f.run.runId }));
  });

  it("fails closed when the current pinned artifact cannot be resolved", async () => {
    const f = fixture();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    f.resolve.mockRejectedValueOnce(new Error("Pinned artifact missing"));
    const response = await f.organizer(resetPath(f.event.eventId));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "coordination_unavailable" });
    expect(f.reset).not.toHaveBeenCalled();
  });
});

function teardownFixture() {
  const f = fixture();
  const close = vi.spyOn(f.work, "closeEvent").mockImplementation(async (current) => {
    f.repository.events.set(current.eventId, { ...current, status: "TEARDOWN" });
    return "closing";
  });
  const targets = vi.spyOn(f.work, "listTargetJobs").mockResolvedValue([]);
  const expected = vi.spyOn(f.work, "setTeardownExpected").mockResolvedValue();
  const dispatch = vi.spyOn(f.work, "requestTeardown").mockResolvedValue("enqueued");
  const archive = vi.spyOn(f.work, "archiveTeardown").mockResolvedValue(false);
  const coordination = {
    store: f.store,
    catalog: async () => ({ [f.descriptor.problemId]: f.descriptor }),
    resolve: f.resolve,
  };
  const beforeClose = async (event: EventRecord) =>
    (await settleNativeEvent(
      coordination,
      event,
      () => NOW,
      { status: "TEARDOWN", endsAt: AT, scoringLocked: true },
      true,
    )) ?? event;
  return { ...f, close, targets, expected, dispatch, archive, beforeClose, coordination };
}

function teardownJob(f: ReturnType<typeof teardownFixture>, team: TeamRecord): DeploymentJob {
  return {
    eventId: f.event.eventId,
    teamId: team.teamId,
    jobId: team.teamId,
    problemId: "hello-world",
    region: "us-east-1",
    awsAccountId: "123456789012",
    status: "COMPLETE",
    expiresAt: f.event.expiresAt,
    score: 100,
    attempt: 1,
    revision: 1,
    createdAt: AT,
    updatedAt: AT,
    stackName: `battle-${team.teamId}`,
    problemDir: "problems/challenges/hello-world",
    artifactDigest: contentDigest("aws-problem"),
    connection: {
      eventId: f.event.eventId,
      teamId: team.teamId,
      accountId: "123456789012",
      region: "us-east-1",
      roleArn: "arn:aws:iam::123456789012:role/competitor",
      externalIdParameter: "/tenkacloud/external-id",
      version: 1,
      verifiedAt: AT,
    },
    scoring: { kind: "flag", points: 100, flagOutputKey: "Flag", wrongPenalty: 0 },
  };
}

describe("explicit organizer DELETE native payload cleanup", () => {
  it.each(["Admin", "Operator"])("allows %s to purge a settled native-only event", async (role) => {
    const f = teardownFixture();
    f.claims.event.requestContext.authorizer.claims["custom:userRole"] = role;
    const response = await f.organizer(`/events/${f.event.eventId}`, "DELETE");
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      eventId: f.event.eventId,
      enqueued: 0,
      skipped: 0,
      failed: 0,
    });
    expect(f.purge).toHaveBeenCalledExactlyOnceWith(f.event.eventId, f.run.problemId);
    expect(f.schedule).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: { status: "TEARDOWN", endsAt: AT, scoringLocked: true },
        close: true,
      }),
    );
    expect(f.schedule.mock.invocationCallOrder[0]).toBeLessThan(
      f.close.mock.invocationCallOrder[0] ?? 0,
    );
    expect(f.archive.mock.invocationCallOrder[0]).toBeLessThan(
      f.purge.mock.invocationCallOrder[0] ?? 0,
    );
    expect(f.sdk).not.toHaveBeenCalled();
  });

  it("retains private payloads until every mixed-event teardown dispatch is accepted", async () => {
    const f = teardownFixture();
    f.repository.events.set(f.event.eventId, {
      ...f.event,
      problems: [...f.event.problems, { problemId: "hello-world", defaultRegion: "us-east-1" }],
    });
    f.targets.mockImplementation(async (_eventId, teamId) =>
      f.teams.filter((team) => team.teamId === teamId).map((team) => teardownJob(f, team)),
    );
    let acceptLast: () => void = () => undefined;
    const lastDispatch = new Promise<undefined>((resolve) => {
      acceptLast = () => resolve(undefined);
    });
    let signalDispatch: () => void = () => undefined;
    const dispatchStarted = new Promise<undefined>((resolve) => {
      signalDispatch = () => resolve(undefined);
    });
    f.dispatch.mockResolvedValueOnce("enqueued").mockImplementationOnce(async () => {
      signalDispatch();
      await lastDispatch;
      return "skipped";
    });
    const response = f.organizer(`/events/${f.event.eventId}`, "DELETE");
    await dispatchStarted;
    expect(f.purge).not.toHaveBeenCalled();
    acceptLast();
    const result = await response;
    expect(result.status).toBe(202);
    expect(await result.json()).toMatchObject({ enqueued: 1, skipped: 1, failed: 0 });
    expect(f.purge).toHaveBeenCalledOnce();
    expect(f.dispatch.mock.invocationCallOrder.at(-1)).toBeLessThan(
      f.purge.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("retains native payloads on dispatch or target-discovery failure", async () => {
    const f = teardownFixture();
    f.targets.mockResolvedValueOnce([teardownJob(f, f.team)]);
    f.dispatch.mockRejectedValueOnce(new DeploymentConflict("teardown_request_conflict"));
    const partial = await f.organizer(`/events/${f.event.eventId}`, "DELETE");
    expect(partial.status).toBe(202);
    expect(await partial.json()).toMatchObject({ failed: 1 });
    expect(f.purge).not.toHaveBeenCalled();
    f.targets.mockRejectedValueOnce(
      new DeploymentConflict("historical_attempt_resources_unresolved"),
    );
    const unresolved = await f.organizer(`/events/${f.event.eventId}`, "DELETE");
    expect(unresolved.status).toBe(409);
    expect(f.purge).not.toHaveBeenCalled();
    expect(f.repository.events.get(f.event.eventId)?.status).toBe("TEARDOWN");
  });

  it("retains native state when the shared operator teardown has no cleanup callback", async () => {
    const f = teardownFixture();
    expect(
      await requestEventTeardown({
        repository: f.repository,
        work: f.work,
        eventId: f.event.eventId,
        now: NOW,
        beforeClose: f.beforeClose,
      }),
    ).toMatchObject({ status: 202, body: { failed: 0 } });
    expect(f.schedule).toHaveBeenCalledOnce();
    expect(f.purge).not.toHaveBeenCalled();
    expect(await f.store.read(f.event.eventId, f.run.problemId)).toEqual(f.run);
  });

  it("retries cleanup on the archived fast path without requiring deleted payloads or artifacts", async () => {
    const f = teardownFixture();
    f.repository.events.set(f.event.eventId, {
      ...f.event,
      status: "ARCHIVED",
      teardownExpected: 2,
    });
    f.summary.mockResolvedValue({ ...f.run, closed: true, purgeState: "pending" });
    f.read.mockRejectedValue(new NativeCoordinationError(409, "coordination_run_closed"));
    f.resolve.mockRejectedValue(new Error("Artifact no longer available"));
    f.close.mockResolvedValue("archived");
    const response = await f.organizer(`/events/${f.event.eventId}`, "DELETE");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ enqueued: 0, skipped: 2, failed: 0 });
    expect(f.purge).toHaveBeenCalledWith(f.event.eventId, f.run.problemId);
    expect(f.closeFence).toHaveBeenCalledExactlyOnceWith(f.event.eventId, f.run.problemId);
    expect(f.targets).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.schedule).not.toHaveBeenCalled();
  });

  it.each(["pending", "complete"] as const)(
    "lets ordinary drain resume a previously requested %s purge",
    async (purgeState) => {
      const f = teardownFixture();
      f.summary.mockResolvedValue({ ...f.run, closed: true, purgeState });
      f.read.mockRejectedValue(new NativeCoordinationError(409, "coordination_run_closed"));
      const archived = { ...f.event, status: "ARCHIVED" as const };
      f.repository.events.set(f.event.eventId, archived);
      f.close.mockResolvedValue("archived");
      const response = await requestEventTeardown({
        repository: f.repository,
        work: f.work,
        eventId: f.event.eventId,
        now: NOW,
        beforeClose: f.beforeClose,
      });
      expect(response.status).toBe(200);
      expect(f.purge).toHaveBeenCalledTimes(purgeState === "pending" ? 1 : 0);
      expect(f.closeFence).toHaveBeenCalledExactlyOnceWith(f.event.eventId, f.run.problemId);
      expect(f.read).not.toHaveBeenCalled();
      expect(f.resolve).not.toHaveBeenCalled();
    },
  );

  it.each(["READY", "ARCHIVED"] as const)(
    "does not report success if cleanup fails for a %s event",
    async (status) => {
      const f = teardownFixture();
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      f.repository.events.set(f.event.eventId, { ...f.event, status });
      if (status === "ARCHIVED") f.close.mockResolvedValue("archived");
      f.purge.mockRejectedValueOnce(new Error("Cleanup interrupted"));
      const failed = await f.organizer(`/events/${f.event.eventId}`, "DELETE");
      expect(failed.status).toBe(500);
      expect(await failed.json()).toEqual({ error: "internal_error" });
      expect(f.purge).toHaveBeenCalledOnce();
      f.repository.events.set(f.event.eventId, { ...f.event, status: "ARCHIVED" });
      f.summary.mockResolvedValue({ ...f.run, closed: true, purgeState: "pending" });
      f.read.mockRejectedValue(new NativeCoordinationError(409, "coordination_run_closed"));
      f.close.mockResolvedValue("archived");
      const retry = await f.organizer(`/events/${f.event.eventId}`, "DELETE");
      expect(retry.status).toBe(200);
      expect(f.closeFence).toHaveBeenCalledWith(f.event.eventId, f.run.problemId);
    },
  );

  it("propagates an interrupted pending purge before claiming that a retry is closed", async () => {
    const f = teardownFixture();
    f.repository.events.set(f.event.eventId, { ...f.event, status: "ARCHIVED" });
    f.summary.mockResolvedValue({ ...f.run, closed: true, purgeState: "pending" });
    f.purge.mockRejectedValueOnce(new NativeCoordinationError(503, "coordination_unavailable"));
    const response = await f.organizer(`/events/${f.event.eventId}`, "DELETE");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "coordination_unavailable" });
    expect(f.closeFence).not.toHaveBeenCalled();
    expect(f.close).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.resolve).not.toHaveBeenCalled();
  });

  it("still validates the pinned artifact for a retained closed run", async () => {
    const f = teardownFixture();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    f.repository.events.set(f.event.eventId, { ...f.event, status: "ARCHIVED" });
    f.summary.mockResolvedValue({ ...f.run, closed: true });
    f.read.mockResolvedValue({ ...f.run, closed: true });
    f.resolve.mockRejectedValueOnce(new Error("Pinned artifact missing"));
    const response = await f.organizer(`/events/${f.event.eventId}`, "DELETE");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "coordination_unavailable" });
    expect(f.purge).not.toHaveBeenCalled();
    expect(f.close).not.toHaveBeenCalled();
  });

  it("requires organizer write permission before closing or purging an event", async () => {
    const f = teardownFixture();
    const path = `/events/${f.event.eventId}`;
    expect((await f.app.request(path, { method: "DELETE" })).status).toBe(401);
    expect((await f.participant(path, "DELETE")).status).toBe(401);
    f.claims.event.requestContext.authorizer.claims["custom:userRole"] = "Viewer";
    expect((await f.organizer(path, "DELETE")).status).toBe(403);
    expect(f.close).not.toHaveBeenCalled();
    expect(f.summary).not.toHaveBeenCalled();
    expect(f.purge).not.toHaveBeenCalled();
  });

  it("keeps EndEvent projection and history available without initiating cleanup", async () => {
    const f = teardownFixture();
    expect((await f.organizer(`/events/${f.event.eventId}/end`)).status).toBe(200);
    f.repository.events.set(f.event.eventId, { ...f.event, status: "ENDED" });
    f.read.mockResolvedValue({ ...f.run, closed: true });
    expect((await f.participant("/portal/me/coordination/projection")).status).toBe(200);
    expect((await (await f.participant("/portal/me")).json()).problems).toHaveLength(1);
    expect((await f.participant("/portal/me/score-events")).status).toBe(200);
    expect(f.purge).not.toHaveBeenCalled();
  });

  it("exposes only safe pending cleanup metadata for the organizer retry control", async () => {
    const f = teardownFixture();
    f.repository.events.set(f.event.eventId, { ...f.event, status: "ARCHIVED" });
    f.summary.mockResolvedValue({ ...f.run, closed: true, purgeState: "pending" });
    f.read.mockRejectedValue(new NativeCoordinationError(409, "coordination_run_closed"));
    const detail = await f.app.request(`/events/${f.event.eventId}`, { method: "GET" }, f.claims);
    expect(detail.status).toBe(200);
    expect((await detail.json()).nativeRuns).toEqual([
      {
        runId: f.run.runId,
        problemId: f.run.problemId,
        revision: f.run.revision,
        status: "CLOSED",
        purgeState: "pending",
      },
    ]);
    expect(f.read).not.toHaveBeenCalled();
    expect(f.resolve).not.toHaveBeenCalled();
  });

  it.each(["TEARDOWN", "ARCHIVED"] as const)(
    "serves metadata and scores after cleanup of a %s event",
    async (status) => {
      const f = teardownFixture();
      f.repository.events.set(f.event.eventId, { ...f.event, status });
      f.summary.mockResolvedValue({ ...f.run, closed: true, purgeState: "complete" });
      f.read.mockRejectedValue(new NativeCoordinationError(409, "coordination_run_closed"));
      vi.spyOn(f.repository, "listTeamScores").mockResolvedValue([
        { eventId: f.event.eventId, teamId: f.team.teamId, score: 75, completedProblems: 1 },
      ]);
      const score = {
        jobId: f.run.runId,
        problemId: f.run.problemId,
        points: 75,
        source: "coordination" as const,
        result: "ok" as const,
        occurredAt: AT,
      };
      f.history.mockResolvedValue([score]);
      const detail = await f.app.request(
        `/events/${f.event.eventId}?withScoreEvents=true`,
        { method: "GET" },
        f.claims,
      );
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({
        nativeRuns: [
          {
            runId: f.run.runId,
            problemId: f.run.problemId,
            revision: f.run.revision,
            status: "CLOSED",
            purgeState: "complete",
          },
        ],
        scoreEventsByTeam: [
          expect.objectContaining({ teamId: f.team.teamId, projectedTotal: 75 }),
          expect.any(Object),
        ],
      });
      expect((await (await f.participant("/portal/me")).json()).problems).toEqual([]);
      expect(await (await f.participant("/portal/me/score-events")).json()).toEqual({
        entries: [score],
      });
      expect(await (await f.participant("/portal/leaderboard")).json()).toMatchObject({
        entries: [
          expect.objectContaining({ teamId: f.team.teamId, score: 75 }),
          expect.any(Object),
        ],
      });
      expect(f.read).not.toHaveBeenCalled();
      expect(f.resolve).not.toHaveBeenCalled();
      const projection = await f.participant("/portal/me/coordination/projection");
      expect(projection.status).toBe(409);
      expect(await projection.json()).toEqual({ error: "coordination_run_closed" });
      expect(f.request).not.toHaveBeenCalled();
    },
  );
});
