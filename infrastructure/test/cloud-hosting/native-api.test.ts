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
} from "../../lib/problem-deploy/control-data/domain/deployment-work.js";
import type { EventRecord } from "../../lib/problem-deploy/control-data/domain/events.js";
import type { TeamRecord } from "../../lib/problem-deploy/control-data/domain/teams.js";
import { DynamoDeploymentWork } from "../../lib/problem-deploy/control-data/dynamodb-deployment-work.js";
import { DynamoDeploymentsCoordination } from "../../lib/problem-deploy/control-data/dynamodb-deployments-coordination.js";
import { createCloudApp } from "../../lib/problem-deploy/handlers/cloud-api/app.js";
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
  const initialize = vi.spyOn(store, "initialize").mockResolvedValue(run);
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
    initialize,
    request,
    schedule,
    history,
    accepting,
    connection,
    accept,
    awsSchedule,
    resolve,
    organizer,
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
