import { handle, type LambdaEvent } from "hono/aws-lambda";
import { describe, expect, it } from "vitest";
import { createCloudApp } from "../../lib/problem-deploy/handlers/cloud-api/app.js";
import { FakeRepository } from "./fake-repository.js";

const NOW = Date.parse("2026-10-01T08:00:00Z");
const AUTH = {
  issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_pool",
  audience: "organizer-client",
};
const createBody = {
  name: "Cloud event",
  teams: [{ internalSlug: "team-a" }, { internalSlug: "team-b" }],
  problems: [{ problemId: "problem-one", defaultRegion: "us-east-1" }],
};
interface Created {
  eventId: string;
  teams: { teamId: string; teamLoginKey: string }[];
}
function fixture() {
  const repository = new FakeRepository();
  const app = createCloudApp({
    repository,
    now: () => NOW,
    organizerAuth: AUTH,
    allowedOrigins: ["https://console.example.test"],
  });
  async function organizer(
    path: string,
    method = "GET",
    data?: unknown,
    role = "Admin",
    changes: Record<string, unknown> = {},
  ) {
    const claims = {
      sub: "organizer-sub",
      token_use: "id",
      iss: AUTH.issuer,
      aud: AUTH.audience,
      exp: String(NOW / 1000 + 3600),
      "custom:userRole": role,
      ...changes,
    };
    return app.request(
      path,
      {
        method,
        ...(data
          ? { body: JSON.stringify(data), headers: { "content-type": "application/json" } }
          : {}),
      },
      { event: { requestContext: { authorizer: { claims } } } },
    );
  }
  const participant = (path: string, key: string) =>
    app.request(path, { headers: { authorization: `Bearer ${key}` } });
  const create = async () =>
    (await (await organizer("/events", "POST", createBody)).json()) as Created;
  return { app, repository, organizer, participant, create };
}

describe("restored cloud HTTP contract with explicit mocked Cognito-authorizer context", () => {
  it("passes the actual REST API Gateway v1 event through the Hono Lambda adapter", async () => {
    const f = fixture();
    const event: LambdaEvent = {
      version: "1.0",
      httpMethod: "GET",
      headers: { host: "api.example.test" },
      path: "/events",
      body: null,
      isBase64Encoded: false,
      resource: "/events",
      requestContext: {
        accountId: "123456789012",
        apiId: "test-api",
        authorizer: {
          claims: {
            sub: "organizer",
            token_use: "id",
            iss: AUTH.issuer,
            aud: AUTH.audience,
            exp: String(NOW / 1000 + 3600),
            "custom:userRole": "Admin",
          },
        },
        domainName: "api.example.test",
        domainPrefix: "api",
        extendedRequestId: "test",
        httpMethod: "GET",
        identity: { sourceIp: "127.0.0.1", userAgent: "synthetic-test" },
        path: "/events",
        protocol: "HTTP/1.1",
        requestId: "test",
        requestTime: "01/Oct/2026:08:00:00 +0000",
        requestTimeEpoch: NOW,
        resourcePath: "/events",
        stage: "test",
      },
    };
    const result = await handle(f.app)(event);
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ items: [] });
  });
  it("does not authorize decoded HTTP JWTs or a missing authorizer context", async () => {
    const f = fixture();
    expect((await f.app.request("/events")).status).toBe(401);
    expect(
      (await f.app.request("/events", { headers: { authorization: "Bearer forged.token.value" } }))
        .status,
    ).toBe(401);
    expect(f.repository.events.size).toBe(0);
  });
  it.each([
    { iss: "https://attacker.example" },
    { aud: "another-client" },
    { token_use: "access" },
    { sub: "" },
    { exp: "not-a-time" },
    { exp: String(NOW / 1000) },
  ])("rejects invalid gateway claims: %s", async (changes) => {
    const f = fixture();
    expect((await f.organizer("/events", "GET", undefined, "Admin", changes)).status).toBe(401);
  });
  it.each(["", "unknown", "TenantAdmin"])(
    "does not promote unknown/legacy roles: %s",
    async (role) => {
      const f = fixture();
      expect((await f.organizer("/events", "GET", undefined, role)).status).toBe(403);
    },
  );
  it("permits Viewer reads and prevents Viewer event creation", async () => {
    const f = fixture();
    expect((await f.organizer("/events", "GET", undefined, "Viewer")).status).toBe(200);
    expect((await f.organizer("/events", "POST", createBody, "Viewer")).status).toBe(403);
    expect(f.repository.events.size).toBe(0);
  });
  it("creates an event and opaque team keys using existing frontend response fields", async () => {
    const f = fixture();
    const response = await f.organizer("/events", "POST", createBody, "Operator");
    expect(response.status).toBe(201);
    const created = (await response.json()) as Created;
    expect(created.eventId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
    expect(created.teams).toHaveLength(2);
    expect(created.teams.every((team) => /^[A-Za-z0-9_-]{43}$/u.test(team.teamLoginKey))).toBe(
      true,
    );
    expect(created.teams[0]?.teamLoginKey).not.toBe(created.teams[1]?.teamLoginKey);
    expect(f.repository.teams.size).toBe(2);
    expect(JSON.stringify(created)).not.toContain("tenant");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it.each([
    { ...createBody, teams: [createBody.teams[0], createBody.teams[0]] },
    { ...createBody, problems: [createBody.problems[0], createBody.problems[0]] },
    { ...createBody, eventId: "client-chosen" },
    { ...createBody, teams: Array.from({ length: 50 }, (_, i) => ({ internalSlug: `team-${i}` })) },
    { ...createBody, problems: [{ problemId: "one", defaultRegion: "cn-north-1" }] },
  ])("rejects invalid creation before storage: %s", async (data) => {
    const f = fixture();
    expect((await f.organizer("/events", "POST", data)).status).toBe(400);
    expect(f.repository.events.size).toBe(0);
  });
  it("accepts the advertised 48-team/50-problem creation limit and rejects the next problem", async () => {
    const f = fixture();
    const input = {
      ...createBody,
      teams: Array.from({ length: 48 }, (_, index) => ({ internalSlug: `team-${index}` })),
      problems: Array.from({ length: 50 }, (_, index) => ({
        problemId: `problem-${index}`,
        defaultRegion: "us-east-1",
      })),
    };
    expect((await f.organizer("/events", "POST", input)).status).toBe(201);
    expect(
      (
        await f.organizer("/events", "POST", {
          ...input,
          problems: [...input.problems, { problemId: "one-too-many", defaultRegion: "us-east-1" }],
        })
      ).status,
    ).toBe(400);
  });
  it("hides credentials from ordinary detail, Viewer, participant and scoreboard responses", async () => {
    const f = fixture();
    const created = await f.create();
    const key = created.teams[0]?.teamLoginKey ?? "";
    const detail = await f.organizer(`/events/${created.eventId}`);
    expect(await detail.text()).not.toContain(key);
    expect(
      (
        await f.organizer(
          `/events/${created.eventId}?withTeamLoginKeys=true`,
          "GET",
          undefined,
          "Viewer",
        )
      ).status,
    ).toBe(403);
    expect(
      await (await f.organizer(`/events/${created.eventId}?withTeamLoginKeys=true`)).text(),
    ).toContain(key);
    expect(await (await f.participant("/portal/me", key)).text()).not.toContain(key);
    expect(await (await f.participant("/portal/leaderboard", key)).text()).not.toContain(key);
  });
  it("rotates and revokes access with role and event/team boundaries", async () => {
    const f = fixture();
    const created = await f.create();
    const team = created.teams[0];
    if (!team) throw new Error("Expected team");
    expect((await f.participant("/portal/me", team.teamLoginKey)).status).toBe(200);
    const path = `/events/${created.eventId}/teams/${team.teamId}`;
    expect((await f.organizer(`${path}/access`, "DELETE", undefined, "Operator")).status).toBe(403);
    const rotated = (await (
      await f.organizer(`${path}/rotate-login-key`, "POST", {}, "Operator")
    ).json()) as { teamLoginKey: string };
    expect((await f.participant("/portal/me", team.teamLoginKey)).status).toBe(401);
    expect((await f.participant("/portal/me", rotated.teamLoginKey)).status).toBe(200);
    expect((await f.organizer(`${path}/access`, "DELETE")).status).toBe(200);
    expect((await f.participant("/portal/me", rotated.teamLoginKey)).status).toBe(401);
    const other = await f.create();
    expect(
      (
        await f.organizer(
          `/events/${other.eventId}/teams/${team.teamId}/rotate-login-key`,
          "POST",
          {},
        )
      ).status,
    ).toBe(404);
  });
  it("scopes participant reads and leaderboard to the authenticated event, ignoring caller-selected scope", async () => {
    const f = fixture();
    const first = await f.create();
    const other = await f.create();
    const mine = first.teams[0];
    const theirs = other.teams[0];
    if (!mine || !theirs) throw new Error("Expected teams");
    f.repository.deployments.push({
      jobId: "01J00000000000000000000001",
      eventId: first.eventId,
      teamId: mine.teamId,
      problemId: "problem-one",
      region: "us-east-1",
      awsAccountId: "123456789012",
      status: "COMPLETE",
      expiresAt: NOW / 1000 + 3600,
      score: 10,
    });
    const ownView = (await (
      await f.participant(
        `/portal/me?eventId=${other.eventId}&teamId=${theirs.teamId}`,
        mine.teamLoginKey,
      )
    ).json()) as { team: { eventId: string }; problems: { score: number }[] };
    expect(ownView.team.eventId).toBe(first.eventId);
    expect(ownView.problems[0]?.score).toBe(10);
    const board = (await (
      await f.participant("/portal/leaderboard", mine.teamLoginKey)
    ).json()) as { eventId: string; entries: { teamId: string; score: number }[] };
    expect(board.eventId).toBe(first.eventId);
    expect(board.entries).toHaveLength(2);
    expect(board.entries[0]?.score).toBe(10);
    expect(board.entries.some((entry) => entry.teamId === theirs.teamId)).toBe(false);
  });
  it("does not leak ranking during the historical freeze interval", async () => {
    const f = fixture();
    const created = await f.create();
    const event = f.repository.events.get(created.eventId);
    if (!event) throw new Error("Expected event");
    f.repository.events.set(event.eventId, {
      ...event,
      endsAt: new Date(NOW + 60_000).toISOString(),
      scoreboardFreezeMinutes: 30,
    });
    expect(
      await (
        await f.participant("/portal/leaderboard", created.teams[0]?.teamLoginKey ?? "")
      ).json(),
    ).toMatchObject({ entries: [], scoreboardFrozen: true });
  });
  it("allows only the configured UI origins and keeps future runner routes unavailable", async () => {
    const f = fixture();
    expect(
      (
        await f.app.request("/events", {
          method: "OPTIONS",
          headers: { origin: "https://console.example.test" },
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await f.app.request("/events", {
          method: "OPTIONS",
          headers: { origin: "https://attacker.example" },
        })
      ).status,
    ).toBe(403);
    expect((await f.organizer("/events/not-an-event/deploy", "POST", {})).status).toBe(404);
  });
});
