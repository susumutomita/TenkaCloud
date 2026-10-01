import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  contentDigest,
  DeploymentConflict,
  type DeploymentJob,
} from "../../lib/problem-deploy/control-data/domain/deployment-work.js";
import type { EventRecord } from "../../lib/problem-deploy/control-data/domain/events.js";
import type { TeamRecord } from "../../lib/problem-deploy/control-data/domain/teams.js";
import { DynamoDeploymentWork } from "../../lib/problem-deploy/control-data/dynamodb-deployment-work.js";
import { createCloudApp } from "../../lib/problem-deploy/handlers/cloud-api/app.js";
import type { CloudProblem } from "../../lib/problem-deploy/handlers/cloud-api/deployment-routes.js";
import { FakeRepository } from "./fake-repository.js";

const NOW = Date.parse("2026-10-01T09:00:00Z");
const AT = new Date(NOW).toISOString();
const AUTH = {
  issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_pool",
  audience: "client",
};
const clients: DynamoDBClient[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) client.destroy();
});
function fixture() {
  const repository = new FakeRepository();
  const event: EventRecord = {
    eventId: ulid(),
    name: "Synthetic event",
    status: "READY",
    teamCount: 1,
    problems: [{ problemId: "hello-world", defaultRegion: "us-east-1" }],
    startsAt: AT,
    createdAt: AT,
    updatedAt: AT,
    expiresAt: NOW / 1000 + 86400,
  };
  const team: TeamRecord = {
    eventId: event.eventId,
    teamId: ulid(),
    internalSlug: "team-a",
    teamLoginKey: "A".repeat(43),
    authVersion: 1,
    accessRevoked: false,
    createdAt: AT,
    updatedAt: AT,
    expiresAt: event.expiresAt,
  };
  repository.events.set(event.eventId, event);
  repository.teams.set(`${event.eventId}/${team.teamId}`, team);
  const binding = {
    id: "reviewed",
    accountId: "123456789012",
    region: "us-east-1",
    roleArn: "arn:aws:iam::123456789012:role/Reviewed",
    externalIdParameterArn: "arn:aws:ssm:us-east-1:123456789012:parameter/reviewed",
    reviewedProblemIds: ["hello-world"],
  };
  const connection = {
    ...binding,
    eventId: event.eventId,
    teamId: team.teamId,
    version: 1,
    verifiedAt: AT,
    externalIdParameter: binding.externalIdParameterArn,
  };
  const problem = {
    problemId: "hello-world",
    problemDir: "problems/challenges/hello-world",
    artifactDigest: contentDigest("template"),
    catalogKey: `catalogs/${contentDigest("catalog")}.json`,
    scoring: { kind: "flag" as const, points: 100, wrongPenalty: 5, flagOutputKey: "PrivateFlag" },
    parameters: { GeneratedToken: "__RANDOM_PASSWORD__", Literal: "kept" },
  };
  const client = new DynamoDBClient({
    region: "us-east-1",
    credentials: { accessKeyId: "DUMMYIDEXAMPLE", secretAccessKey: "DUMMYEXAMPLEKEY" },
  });
  clients.push(client);
  // HTTP contract tests only. Storage transactions have separate intercepted-SDK and real-Local tests.
  const work = new DynamoDeploymentWork(DynamoDBDocumentClient.from(client), {
    events: "events",
    teams: "teams",
    deployments: "deployments",
  });
  const sdk = vi
    .spyOn(DynamoDBDocumentClient.prototype, "send")
    .mockRejectedValue(new Error("Unexpected SDK access in HTTP contract test"));
  const accepting = vi.spyOn(work, "acceptingNewDeployments").mockResolvedValue(true);
  const getConnection = vi.spyOn(work, "getConnection").mockResolvedValue(connection);
  const getTarget = vi.spyOn(work, "getTarget").mockResolvedValue(undefined);
  const pin = vi
    .spyOn(work, "pinRequest")
    .mockImplementation(async (_event, _key, _hash, proposal) => proposal);
  const accept = vi.spyOn(work, "accept").mockImplementation(async ({ job }) => ({
    kind: "accepted",
    jobId: job.jobId,
    attempt: job.attempt,
  }));
  const save = vi.spyOn(work, "saveVerifiedConnection").mockResolvedValue();
  const schedule = vi.spyOn(work, "setSchedule").mockResolvedValue();
  const submit = vi
    .spyOn(work, "submitFlag")
    .mockResolvedValue({ kind: "ok", scoreDelta: 100, totalScore: 100 });
  const history = vi.spyOn(work, "listScoreEvents").mockResolvedValue([]);
  const close = vi.spyOn(work, "closeEvent").mockImplementation(async (current) => {
    repository.events.set(current.eventId, { ...current, status: "TEARDOWN" });
    return "closing";
  });
  const targets = vi.spyOn(work, "listTargetJobs").mockResolvedValue([]);
  const expected = vi.spyOn(work, "setTeardownExpected").mockResolvedValue();
  const teardown = vi.spyOn(work, "requestTeardown").mockResolvedValue("enqueued");
  const archive = vi.spyOn(work, "archiveTeardown").mockResolvedValue(false);
  const catalog = vi.fn(
    async (): Promise<Readonly<Record<string, CloudProblem>>> => ({ "hello-world": problem }),
  );
  const verify = vi.fn(async () => undefined);
  const app = createCloudApp({
    repository,
    now: () => NOW,
    organizerAuth: AUTH,
    allowedOrigins: [],
    deployment: { work, catalog, controlPlaneAccount: "210987654321" },
    connections: { bindings: [binding], verify },
  });
  const claims = (role: string) => ({
    event: {
      requestContext: {
        authorizer: {
          claims: {
            sub: "organizer",
            token_use: "id",
            iss: AUTH.issuer,
            aud: AUTH.audience,
            exp: String(NOW / 1000 + 60),
            "custom:userRole": role,
          },
        },
      },
    },
  });
  const organizer = (
    path: string,
    method = "POST",
    body: unknown = {},
    role = "Admin",
    key?: string,
  ) =>
    app.request(
      path,
      {
        method,
        body: JSON.stringify(body),
        headers: { "content-type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
      },
      claims(role),
    );
  const participant = (path: string, method = "GET", body?: unknown, key = team.teamLoginKey) =>
    app.request(path, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "Idempotency-Key": "submission",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const path = `/events/${event.eventId}`;
  return {
    repository,
    event,
    team,
    binding,
    connection,
    problem,
    work,
    sdk,
    getConnection,
    getTarget,
    pin,
    accept,
    accepting,
    save,
    schedule,
    submit,
    history,
    close,
    targets,
    expected,
    teardown,
    archive,
    catalog,
    verify,
    app,
    claims,
    organizer,
    participant,
    path,
  };
}
async function acceptedJob(f: ReturnType<typeof fixture>): Promise<DeploymentJob> {
  expect((await f.organizer(`${f.path}/deploy`, "POST", {}, "Operator", "operation")).status).toBe(
    202,
  );
  const job = f.accept.mock.calls[0]?.[0].job;
  if (!job) throw new Error("Expected an accepted job");
  return job;
}

describe("cloud execution HTTP authorization, replay and lifecycle contracts", () => {
  it("creates and plans independent team regions in one AWS account", async () => {
    const f = fixture();
    const response = await f.organizer("/events", "POST", {
      name: "Shared account regions",
      teams: [
        { internalSlug: "tokyo", awsAccountId: f.binding.accountId, region: "ap-northeast-1" },
        { internalSlug: "virginia", awsAccountId: f.binding.accountId, region: "us-east-1" },
      ],
      problems: [{ problemId: "hello-world", defaultRegion: "us-east-1" }],
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as { eventId: string };
    const teams = await f.repository.listTeamsByEvent(created.eventId);
    f.getConnection.mockImplementation(async (eventId, teamId) => {
      const team = teams.find((item) => item.teamId === teamId);
      if (!team?.region) throw new Error("Missing selected team region");
      return { ...f.connection, eventId, teamId, region: team.region };
    });
    expect(
      (
        await f.organizer(
          `/events/${created.eventId}/deploy`,
          "POST",
          {},
          "Operator",
          "shared-regions",
        )
      ).status,
    ).toBe(202);
    const jobs = f.accept.mock.calls.map(([input]) => input.job);
    expect(jobs).toHaveLength(2);
    expect(jobs.map((job) => job.region).sort()).toEqual(["ap-northeast-1", "us-east-1"]);
    expect(new Set(jobs.map((job) => job.awsAccountId))).toEqual(new Set([f.binding.accountId]));
    expect(new Set(jobs.map((job) => job.stackName)).size).toBe(2);
    for (const job of jobs) {
      expect(job.connection).toMatchObject({
        eventId: created.eventId,
        teamId: job.teamId,
        accountId: job.awsAccountId,
        region: job.region,
      });
      expect(job.parameters?.ExternalId).toBe(job.jobId);
    }
    expect(f.sdk).not.toHaveBeenCalled();
  });
  it.each([
    "unavailable",
    "constructor",
    "sqli-demo",
    "db-a1-table-primary-key",
    "hello-world-battle",
  ])("rejects %s outside the real execution catalog before event creation", async (problemId) => {
    const f = fixture();
    const count = f.repository.events.size;
    const response = await f.organizer("/events", "POST", {
      name: "Unavailable problem",
      teams: [{ internalSlug: "new-team", awsAccountId: "123456789012", region: "us-east-1" }],
      problems: [{ problemId, defaultRegion: "us-east-1" }],
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "unsupported_runtime_problem" });
    expect(f.repository.events.size).toBe(count);
    expect(f.accept).not.toHaveBeenCalled();
  });
  it.each(["sqli-demo", "db-a1-table-primary-key"])(
    "refuses a retained Docker problem %s before preparing any cloud work",
    async (problemId) => {
      const f = fixture();
      f.repository.events.set(f.event.eventId, {
        ...f.event,
        problems: [...f.event.problems, { problemId, defaultRegion: "local" }],
      });
      const response = await f.organizer(`${f.path}/deploy`);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: "unsupported_runtime_problem" });
      expect(f.pin).not.toHaveBeenCalled();
      expect(f.getConnection).not.toHaveBeenCalled();
      expect(f.accept).not.toHaveBeenCalled();
      expect(f.sdk).not.toHaveBeenCalled();
    },
  );
  it("rejects known installation shutdown before planning or binding work", async () => {
    const f = fixture();
    f.accepting.mockResolvedValue(false);
    const response = await f.organizer(`${f.path}/deploy`);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "installation_draining" });
    expect(f.pin).not.toHaveBeenCalled();
    expect(f.getConnection).not.toHaveBeenCalled();
    expect(f.accept).not.toHaveBeenCalled();
  });
  it("pins an operation before accepting a scoped job, generating only private persisted parameters", async () => {
    const f = fixture();
    const response = await f.organizer(`${f.path}/deploy`, "POST", {}, "Operator", "operation");
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ eventId: f.event.eventId, enqueued: 1, skipped: 0 });
    expect(response.headers.get("Idempotency-Key")).toBe("operation");
    const job = f.accept.mock.calls[0]?.[0].job;
    expect(job).toMatchObject({
      eventId: f.event.eventId,
      teamId: f.team.teamId,
      attempt: 1,
      connection: f.connection,
      parameters: { Literal: "kept", TenkaCloudAccountId: "210987654321" },
    });
    expect(job?.parameters?.GeneratedToken).toMatch(/^[a-f0-9]{48}$/u);
    expect(job?.parameters?.ExternalId).toBe(job?.jobId);
    expect(f.pin.mock.invocationCallOrder[0]).toBeLessThan(
      f.accept.mock.invocationCallOrder[0] ?? 0,
    );
    expect(f.sdk).not.toHaveBeenCalled();
  });
  it.each(["Viewer", "unknown"])(
    "rejects %s before reading connection or accepting work",
    async (role) => {
      const f = fixture();
      expect((await f.organizer(`${f.path}/deploy`, "POST", {}, role)).status).toBe(403);
      expect(f.getConnection).not.toHaveBeenCalled();
      expect(f.accept).not.toHaveBeenCalled();
    },
  );
  it.each([
    { teamIds: [ulid()] },
    { problemIds: ["hello-world", "hello-world"] },
    { problemIds: ["unknown"] },
    { forceRedeploy: true },
  ])("rejects invalid or cross-scope selections: %j", async (body) => {
    const f = fixture();
    expect((await f.organizer(`${f.path}/deploy`, "POST", body)).status).toBe(400);
    expect(f.accept).not.toHaveBeenCalled();
  });
  it("fails closed for missing event, malformed body, oversize payload and unsupported problem", async () => {
    const f = fixture();
    expect((await f.organizer(`/events/${ulid()}/deploy`)).status).toBe(404);
    for (const body of ["{", " ".repeat(65537)])
      expect(
        (await f.app.request(`${f.path}/deploy`, { method: "POST", body }, f.claims("Admin")))
          .status,
      ).toBe(400);
    f.catalog.mockResolvedValue({});
    expect((await f.organizer(`${f.path}/deploy`)).status).toBe(409);
    expect(f.accept).not.toHaveBeenCalled();
  });
  it.each(["missing", "team-account", "team-region", "problem-account", "region", "review"])(
    "refuses an unverified or mismatched connection: %s",
    async (change) => {
      const f = fixture();
      if (change === "missing") f.getConnection.mockResolvedValue(undefined);
      if (change === "team-account")
        f.repository.teams.set(`${f.event.eventId}/${f.team.teamId}`, {
          ...f.team,
          awsAccountId: "999999999999",
        });
      if (change === "team-region")
        f.repository.teams.set(`${f.event.eventId}/${f.team.teamId}`, {
          ...f.team,
          region: "us-west-2",
        });
      if (change === "problem-account")
        f.repository.events.set(f.event.eventId, {
          ...f.event,
          problems: [
            {
              problemId: "hello-world",
              defaultRegion: "us-east-1",
              defaultAwsAccountId: "999999999999",
            },
          ],
        });
      if (change === "region")
        f.getConnection.mockResolvedValue({ ...f.connection, region: "us-west-2" });
      if (change === "review")
        f.getConnection.mockResolvedValue({ ...f.connection, reviewedProblemIds: ["other"] });
      expect((await f.organizer(`${f.path}/deploy`)).status).toBe(409);
      expect(f.accept).not.toHaveBeenCalled();
    },
  );
  it("skips existing jobs and retries only a still-failed owned attempt", async () => {
    const f = fixture();
    const job = await acceptedJob(f);
    f.accept.mockClear();
    f.repository.deployments.push(job);
    expect(await (await f.organizer(`${f.path}/deploy`)).json()).toMatchObject({
      enqueued: 0,
      skipped: 1,
    });
    f.repository.deployments[0] = { ...job, status: "FAILED" };
    f.getTarget.mockResolvedValue({ ...job, status: "FAILED", attempt: 3 });
    expect((await f.organizer(`${f.path}/deploy`, "POST", { retryFailedOnly: true })).status).toBe(
      202,
    );
    expect(f.accept.mock.calls[0]?.[0]).toMatchObject({
      retryOf: 3,
      job: { jobId: job.jobId, attempt: 4 },
    });
    f.getTarget.mockResolvedValue({ ...job, status: "COMPLETE" });
    expect((await f.organizer(`${f.path}/deploy`, "POST", { retryFailedOnly: true })).status).toBe(
      409,
    );
    f.repository.deployments = [];
    expect(
      await (await f.organizer(`${f.path}/deploy`, "POST", { retryFailedOnly: true })).json(),
    ).toMatchObject({ enqueued: 0, skipped: 1 });
  });
  it("rejects a changed pinned catalog or target and disappearance of the connection before acceptance", async () => {
    const f = fixture();
    f.pin.mockImplementation(async () => ({
      createdAt: AT,
      catalogKey: "other",
      targets: [],
      skipped: 0,
    }));
    expect((await f.organizer(`${f.path}/deploy`)).status).toBe(409);
    f.pin.mockImplementation(async () => ({
      createdAt: AT,
      catalogKey: f.problem.catalogKey,
      targets: [{ jobId: ulid(), teamId: ulid(), problemId: "hello-world", attempt: 1 }],
      skipped: 0,
    }));
    expect((await f.organizer(`${f.path}/deploy`)).status).toBe(409);
    f.pin.mockImplementation(async (_event, _key, _hash, proposal) => proposal);
    f.getConnection.mockResolvedValueOnce(f.connection).mockResolvedValueOnce(undefined);
    expect((await f.organizer(`${f.path}/deploy`)).status).toBe(409);
    expect(f.accept).not.toHaveBeenCalled();
  });
  it("surfaces durable receipt conflicts and failed dispatch acceptance without a false success", async () => {
    const f = fixture();
    f.pin.mockRejectedValueOnce(new DeploymentConflict("idempotency_key_reused"));
    expect((await f.organizer(`${f.path}/deploy`)).status).toBe(422);
    f.accept.mockRejectedValueOnce(new DeploymentConflict("deployment_acceptance_conflict"));
    expect((await f.organizer(`${f.path}/deploy`)).status).toBe(409);
  });
  it("uses the authenticated team and current attempt for scoring and bounded history", async () => {
    const f = fixture();
    const job = await acceptedJob(f);
    f.getTarget.mockResolvedValue({ ...job, attempt: 2 });
    const result = await f.participant("/portal/me/submit-flag", "POST", {
      problemId: "hello-world",
      flag: "synthetic",
    });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ kind: "ok", scoreDelta: 100, totalScore: 100 });
    expect(f.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        team: f.team,
        event: f.event,
        jobId: job.jobId,
        attempt: 2,
        requestKey: "submission",
      }),
    );
    expect((await f.participant("/portal/me/score-events?limit=7")).status).toBe(200);
    expect(f.history).toHaveBeenCalledWith(f.event.eventId, f.team.teamId, 7);
    expect((await f.participant("/portal/me/score-events?limit=101")).status).toBe(400);
    expect(
      (
        await f.participant("/portal/me/submit-flag", "POST", {
          problemId: "hello-world",
          flag: "x",
          teamId: ulid(),
        })
      ).status,
    ).toBe(400);
    f.getTarget.mockResolvedValue(undefined);
    expect(
      (
        await f.participant("/portal/me/submit-flag", "POST", {
          problemId: "hello-world",
          flag: "x",
        })
      ).status,
    ).toBe(404);
    for (const path of ["/portal/me/submit-flag", "/portal/me/score-events"])
      expect(
        (
          await f.participant(
            path,
            path.endsWith("submit-flag") ? "POST" : "GET",
            undefined,
            "B".repeat(43),
          )
        ).status,
      ).toBe(401);
  });
});

describe("verified connection and schedule routes", () => {
  it("verifies the exact allowlisted connection before versioned persistence and hides secret references", async () => {
    const f = fixture();
    const path = `${f.path}/teams/${f.team.teamId}/connection`;
    expect((await f.organizer(path, "POST", { bindingId: "reviewed" }, "Operator")).status).toBe(
      403,
    );
    expect((await f.organizer(path, "POST", { bindingId: "other" })).status).toBe(403);
    const result = await f.organizer(path, "POST", { bindingId: "reviewed" });
    expect(result.status).toBe(200);
    const text = await result.text();
    expect(text).not.toContain(f.binding.roleArn);
    expect(text).not.toContain(f.binding.externalIdParameterArn);
    expect(f.verify).toHaveBeenCalledWith(f.binding);
    expect(f.save).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: f.event.eventId,
        teamId: f.team.teamId,
        version: 2,
        bindingId: "reviewed",
      }),
      1,
    );
    expect(f.verify.mock.invocationCallOrder[0]).toBeLessThan(
      f.save.mock.invocationCallOrder[0] ?? 0,
    );
  });
  it.each([
    "missing-team",
    "missing-event",
    "account",
    "region",
    "expired-event",
    "expired-team",
    "revoked",
  ])("does not verify an invalid connection scope: %s", async (change) => {
    const f = fixture();
    const key = `${f.event.eventId}/${f.team.teamId}`;
    const missing = {
      "missing-team": () => f.repository.teams.delete(key),
      "missing-event": () => f.repository.events.delete(f.event.eventId),
    };
    if (change === "missing-team" || change === "missing-event") missing[change]();
    if (change === "account")
      f.repository.teams.set(key, { ...f.team, awsAccountId: "999999999999" });
    if (change === "region") f.repository.teams.set(key, { ...f.team, region: "us-west-2" });
    if (change === "expired-event")
      f.repository.events.set(f.event.eventId, { ...f.event, expiresAt: NOW / 1000 });
    if (change === "expired-team")
      f.repository.teams.set(key, { ...f.team, expiresAt: NOW / 1000 });
    if (change === "revoked") f.repository.teams.set(key, { ...f.team, accessRevoked: true });
    expect(
      (
        await f.organizer(`${f.path}/teams/${f.team.teamId}/connection`, "POST", {
          bindingId: "reviewed",
        })
      ).status,
    ).toBe(["missing-team", "missing-event"].includes(change) ? 404 : 409);
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
  });
  it("does not save a connection after verification failure and reports a CAS conflict", async () => {
    const f = fixture();
    const path = `${f.path}/teams/${f.team.teamId}/connection`;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    f.verify.mockRejectedValueOnce(new Error("Synthetic denied verification"));
    expect((await f.organizer(path, "POST", { bindingId: "reviewed" })).status).toBe(500);
    expect(f.save).not.toHaveBeenCalled();
    f.getConnection.mockResolvedValue(undefined);
    f.save.mockRejectedValueOnce(new DeploymentConflict("connection_changed"));
    expect((await f.organizer(path, "POST", { bindingId: "reviewed" })).status).toBe(409);
    expect(f.save).toHaveBeenCalledWith(expect.objectContaining({ version: 1 }), undefined);
  });
  it("starts an event with monotonic CAS time and independently locks/unlocks scoring", async () => {
    const f = fixture();
    expect(
      (
        await f.organizer(
          `${f.path}/schedule`,
          "PATCH",
          { startNow: true, scoreboardFreezeMinutes: 0 },
          "Operator",
        )
      ).status,
    ).toBe(200);
    expect(f.schedule).toHaveBeenCalledWith(
      f.event,
      { startsAt: AT, endsAt: undefined, scoreboardFreezeMinutes: 0 },
      new Date(NOW + 1).toISOString(),
    );
    for (const method of ["POST", "DELETE"]) {
      expect((await f.organizer(`${f.path}/lock-scoring`, method)).status).toBe(200);
      expect(f.schedule).toHaveBeenLastCalledWith(
        f.event,
        { scoringLocked: method === "POST" },
        new Date(NOW + 1).toISOString(),
      );
    }
    expect(
      (await f.organizer(`${f.path}/schedule`, "PATCH", { startNow: true }, "Viewer")).status,
    ).toBe(403);
  });
  it("ends AWS-only scoring at server time without changing or deleting deployments", async () => {
    const f = fixture();
    const response = await f.organizer(`${f.path}/end`, "POST", {}, "Operator");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      eventId: f.event.eventId,
      status: "ENDED",
      endsAt: AT,
      updatedDeployments: 0,
    });
    expect(f.schedule).toHaveBeenCalledWith(
      f.event,
      { status: "ENDED", endsAt: AT, scoringLocked: true },
      new Date(NOW + 1).toISOString(),
    );
    expect(f.close).not.toHaveBeenCalled();
    expect(f.teardown).not.toHaveBeenCalled();
    expect(f.accept).not.toHaveBeenCalled();
    expect(f.sdk).not.toHaveBeenCalled();
  });
  it("protects End with organizer authorization, event existence, and schedule CAS", async () => {
    const f = fixture();
    expect((await f.organizer(`${f.path}/end`, "POST", {}, "Viewer")).status).toBe(403);
    expect(f.schedule).not.toHaveBeenCalled();
    f.schedule.mockRejectedValueOnce(new DeploymentConflict("event_schedule_changed"));
    expect((await f.organizer(`${f.path}/end`)).status).toBe(409);
    f.repository.events.clear();
    expect((await f.organizer(`${f.path}/end`)).status).toBe(404);
  });
  it.each(["TEARDOWN", "ARCHIVED"] as const)(
    "does not reopen an event in %s through End",
    async (status) => {
      const f = fixture();
      f.repository.events.set(f.event.eventId, { ...f.event, status });
      expect((await f.organizer(`${f.path}/end`)).status).toBe(409);
      expect(f.schedule).not.toHaveBeenCalled();
    },
  );
  it("does not mistake a native-selected event for AWS-only when native composition is absent", async () => {
    const f = fixture();
    f.repository.events.set(f.event.eventId, {
      ...f.event,
      problems: [{ problemId: "ac26-crypto-battle", defaultRegion: "us-east-1" }],
    });
    const response = await f.organizer(`${f.path}/end`);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "coordination_not_initialized" });
    expect(f.schedule).not.toHaveBeenCalled();
  });
  it.each([
    {},
    { startNow: true, startsAt: AT },
    { startsAt: new Date(NOW - 60001).toISOString() },
    { endsAt: AT },
    { startsAt: new Date(NOW + 2000).toISOString(), endsAt: new Date(NOW + 1000).toISOString() },
    { deployAt: AT },
  ])("rejects invalid schedule without writing: %j", async (body) => {
    const f = fixture();
    expect((await f.organizer(`${f.path}/schedule`, "PATCH", body)).status).toBe(400);
    expect(f.schedule).not.toHaveBeenCalled();
  });
  it("does not update absent events or swallow a stale schedule conflict", async () => {
    const f = fixture();
    f.schedule.mockRejectedValueOnce(new DeploymentConflict("event_schedule_changed"));
    expect((await f.organizer(`${f.path}/schedule`, "PATCH", { startNow: true })).status).toBe(409);
    f.repository.events.clear();
    expect((await f.organizer(`${f.path}/schedule`, "PATCH", { startNow: true })).status).toBe(404);
    expect((await f.organizer(`${f.path}/lock-scoring`)).status).toBe(404);
  });
});

describe("existing event DELETE contract with durable-teardown repository boundary", () => {
  it("closes intake before strong target discovery and durably queues each owned job", async () => {
    const f = fixture();
    const job = await acceptedJob(f);
    f.targets.mockResolvedValue([job]);
    const result = await f.organizer(f.path, "DELETE", {}, "Operator");
    expect(result.status).toBe(202);
    expect(await result.json()).toEqual({
      eventId: f.event.eventId,
      enqueued: 1,
      skipped: 0,
      failed: 0,
    });
    expect(f.close.mock.invocationCallOrder[0]).toBeLessThan(
      f.targets.mock.invocationCallOrder[0] ?? 0,
    );
    expect(f.targets).toHaveBeenCalledWith(f.event.eventId, f.team.teamId);
    expect(f.expected).toHaveBeenCalledWith(f.event.eventId, 1);
    expect(f.expected.mock.invocationCallOrder[0]).toBeLessThan(
      f.teardown.mock.invocationCallOrder[0] ?? 0,
    );
    expect(f.teardown).toHaveBeenCalledWith(job, new Date(NOW + 1).toISOString());
    f.accept.mockClear();
    expect((await f.organizer(`${f.path}/deploy`)).status).toBe(409);
    expect(f.accept).not.toHaveBeenCalled();
    f.teardown.mockResolvedValue("skipped");
    expect(await (await f.organizer(f.path, "DELETE")).json()).toMatchObject({
      enqueued: 0,
      skipped: 1,
      failed: 0,
    });
  });
  it("requires organizer write permission and does not discover foreign or missing scopes", async () => {
    const f = fixture();
    expect((await f.organizer(f.path, "DELETE", {}, "Viewer")).status).toBe(403);
    expect((await f.participant(f.path, "DELETE")).status).toBe(401);
    expect((await f.organizer(`/events/${ulid()}`, "DELETE")).status).toBe(404);
    expect(f.close).not.toHaveBeenCalled();
    expect(f.targets).not.toHaveBeenCalled();
  });
  it("reports partial acceptance failure without reopening the event or claiming all resources deleted", async () => {
    const f = fixture();
    const job = await acceptedJob(f);
    f.targets.mockResolvedValue([job]);
    f.teardown.mockRejectedValueOnce(new DeploymentConflict("teardown_request_conflict"));
    const result = await f.organizer(f.path, "DELETE");
    expect(result.status).toBe(202);
    expect(await result.json()).toEqual({
      eventId: f.event.eventId,
      enqueued: 0,
      skipped: 0,
      failed: 1,
    });
    expect(f.repository.events.get(f.event.eventId)?.status).toBe("TEARDOWN");
    expect(f.archive).toHaveBeenCalledWith(f.event.eventId);
  });
  it("returns an already-archived result without re-enqueueing or modifying deployment state", async () => {
    const f = fixture();
    f.repository.events.set(f.event.eventId, {
      ...f.event,
      status: "ARCHIVED",
      teardownExpected: 4,
      teardownCompleted: 4,
    });
    f.close.mockResolvedValue("archived");
    const result = await f.organizer(f.path, "DELETE");
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ enqueued: 0, skipped: 4, failed: 0 });
    expect(f.targets).not.toHaveBeenCalled();
    expect(f.teardown).not.toHaveBeenCalled();
  });
  it("projects a failed teardown to the existing organizer status/failure fields without exposing its owner", async () => {
    const f = fixture();
    const job = await acceptedJob(f);
    f.repository.deployments = [
      {
        ...job,
        status: "COMPLETE",
        teardownStatus: "FAILED",
        teardownFailureReason: "worker_failed",
      },
    ];
    const response = await f.app.request(f.path, { method: "GET" }, f.claims("Admin"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      deploymentsByProblem: {
        "hello-world": [{ jobId: job.jobId, status: "FAILED", failureReason: "worker_failed" }],
      },
    });
  });
});

it("keeps the event closed and refuses a completeness claim when old-attempt resources are unresolved", async () => {
  const f = fixture();
  f.targets.mockRejectedValue(new DeploymentConflict("historical_attempt_resources_unresolved"));
  const response = await f.organizer(f.path, "DELETE");
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "historical_attempt_resources_unresolved" });
  expect(f.repository.events.get(f.event.eventId)?.status).toBe("TEARDOWN");
  expect(f.expected).not.toHaveBeenCalled();
  expect(f.teardown).not.toHaveBeenCalled();
  expect(f.archive).not.toHaveBeenCalled();
});
