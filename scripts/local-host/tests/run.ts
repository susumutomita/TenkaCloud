import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { id, randomToken } from "../auth";
import { assertHostingModule, narrowCatalog, publicMetadata } from "../browser-metadata";
import { DAEMON_UNAVAILABLE_MESSAGE, DockerHostingEngine } from "../docker-engine";
import { persistentKey, prepareDatabase, privateDirectory } from "../files";
import { type GatewayPortRange, parseGatewayPorts } from "../gateway-ports";
import { SurfaceGateways } from "../gateways";
import { type HttpHost, startHttpHost } from "../http";
import { object, type SqlDatabase } from "../model";
import { parseOptions } from "../options";
import { HostingService } from "../service";
import { HostStore } from "../store";
import { ExerciseFixture } from "./exercise-fixture";

// eslint-disable-next-line sonarjs/no-hardcoded-ip -- RFC1918 parser test vector; no connection is made.
const TEST_PRIVATE_ADDRESS = "192.168.1.2";

interface ResponseData<Body = Record<string, unknown>> {
  status: number;
  body: Body;
  response: Response;
}

interface PortalView {
  eventGate: { kind: string };
  problems: {
    instructions: string;
    lifecycle?: unknown;
    stackOutputs: Record<string, string>;
  }[];
}

function required<T>(value: T | undefined | null): T {
  assert.ok(value !== undefined && value !== null, "Expected a nonempty test value.");
  return value;
}

interface CreatedEvent {
  eventId: string;
  teams: {
    teamId: string;
    teamLoginKey: string;
  }[];
}

type DatabaseConstructor = new (path: string) => SqlDatabase;
const testCases: {
  name: string;
  run: () => Promise<void>;
}[] = [];

function test(name: string, run: () => Promise<void>) {
  testCases.push({ name, run });
}
let openDatabase: (path: string) => SqlDatabase;

/** A per-fixture gateway range; a slot whose port is taken by another process is skipped. */
function testGatewayPorts(): GatewayPortRange {
  const start = 20_000 + randomInt(800) * 50;
  return { start, end: start + 39 };
}

async function fixture(
  operation: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
): Promise<void> {
  const environment = await createFixture();
  try {
    await operation(environment);
  } finally {
    await environment.close();
  }
}

async function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), "tenkacloud-host-test-"));
  privateDirectory(directory);
  const databasePath = join(directory, "state.sqlite");
  prepareDatabase(databasePath);
  const key = persistentKey(join(directory, "host-key"));
  const staticRoot = join(directory, "assets");
  mkdirSync(staticRoot);
  writeFileSync(
    join(staticRoot, "host.html"),
    "<!doctype html><title>HTTP boundary fixture, not the production UI</title>",
  );
  let clock = Date.parse("2026-09-15T00:00:00Z");
  const gatewayPorts = testGatewayPorts();
  let store = new HostStore(openDatabase(databasePath));
  const engine = new ExerciseFixture(openDatabase);
  let service = new HostingService(
    store,
    engine,
    key,
    () => clock,
    () => {
      /* Expected boundary failures are asserted by the caller. */
    },
  );
  service.gatewayPorts = gatewayPorts;
  let gateways: SurfaceGateways;
  let admin: HttpHost;
  let participant: HttpHost;
  let adminToken = "";
  let refreshToken = "";
  async function start(): Promise<void> {
    gateways = new SurfaceGateways("127.0.0.1", service, gatewayPorts);
    service.surfaceLink = (job, team) => gateways.link(job, team);
    service.closeSurface = (jobId) => gateways.closeJob(jobId);
    participant = await startHttpHost({
      kind: "participant",
      hostname: "127.0.0.1",
      port: 0,
      staticRoot,
      service,
      log: () => {
        /* Expected boundary failures are asserted by the caller. */
      },
    });
    admin = await startHttpHost({
      kind: "admin",
      hostname: "127.0.0.1",
      port: 0,
      staticRoot,
      service,
      participantOrigin: participant.origin,
      log: () => {
        /* Expected boundary failures are asserted by the caller. */
      },
    });
  }
  async function request<Body = Record<string, unknown>>(
    role: "admin" | "participant",
    path: string,
    method = "GET",
    body?: unknown,
    token?: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<ResponseData<Body>> {
    const origin = role === "admin" ? admin.origin : participant.origin;
    const bearer = token ?? (role === "admin" ? adminToken : "");
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    const raw = await response.text();
    let data: unknown;
    try {
      data = JSON.parse(raw) as unknown;
    } catch {
      data = { text: raw };
    }
    return {
      status: response.status,
      body: data as Body,
      response,
    };
  }
  async function login(): Promise<void> {
    const response = await request("admin", "/api/host/login", "POST", { key }, "");
    assert.equal(response.status, 200);
    adminToken = response.body.idToken as string;
    refreshToken = response.body.refreshToken as string;
  }
  async function create(name = "Two-team event"): Promise<CreatedEvent> {
    const response = await request("admin", "/api/events", "POST", {
      name,
      teams: [{ internalSlug: "team-a" }, { internalSlug: "team-b" }],
      problems: [{ problemId: "sqli-demo", defaultRegion: "local" }],
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body as unknown as CreatedEvent;
  }
  async function deploy(eventId: string): Promise<void> {
    const result = await request("admin", `/api/events/${eventId}/deploy`, "POST", {});
    assert.equal(result.status, 202, JSON.stringify(result.body));
    await service.drain();
  }
  async function begin(eventId: string, duration = 60_000): Promise<void> {
    const result = await request("admin", `/api/events/${eventId}/schedule`, "PATCH", {
      startNow: true,
      endsAt: new Date(clock + duration).toISOString(),
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
  }
  async function challenge(teamKey: string) {
    const view = await request<PortalView>(
      "participant",
      "/api/portal/me",
      "GET",
      undefined,
      teamKey,
    );
    assert.equal(view.status, 200, JSON.stringify(view.body));
    const link = required(required(view.body.problems[0]).stackOutputs.Web);
    const response = await fetch(link, { redirect: "manual" });
    await response.text();
    assert.equal(response.status, 303);
    const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
    const origin = new URL(link).origin;
    const attacked = await fetch(`${origin}/login`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie,
        origin,
      },
      body: new URLSearchParams({ username: "admin' --", password: randomToken() }),
    });
    const body = (await attacked.json()) as { flag?: string };
    assert.equal(attacked.status, 200);
    assert.ok(body.flag);
    return {
      origin,
      cookie,
      flag: body.flag,
      usedLink: link,
    };
  }
  async function restart(): Promise<void> {
    await service.drain();
    await Promise.all([admin.close(), participant.close()]);
    await gateways.close();
    store.close();
    store = new HostStore(openDatabase(databasePath));
    service = new HostingService(
      store,
      engine,
      key,
      () => clock,
      () => {
        /* Expected boundary failures are asserted by the caller. */
      },
    );
    service.gatewayPorts = gatewayPorts;
    await service.recover();
    await start();
  }
  await start();
  await login();
  return {
    directory,
    databasePath,
    key,
    engine,
    gatewayPorts,
    request,
    create,
    deploy,
    begin,
    challenge,
    restart,
    login,
    get store() {
      return store;
    },
    get service() {
      return service;
    },
    get admin() {
      return admin;
    },
    get participant() {
      return participant;
    },
    get adminToken() {
      return adminToken;
    },
    get refreshToken() {
      return refreshToken;
    },
    advance(milliseconds: number) {
      clock += milliseconds;
    },
    async close() {
      await service.drain();
      await Promise.all([admin.close(), participant.close()]);
      await gateways.close();
      await engine.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
test("No automatic login, and public configuration has no host/team credentials", () =>
  fixture(async (f) => {
    const event = await f.create();
    for (const role of ["admin", "participant"] as const) {
      const response = await f.request(role, "/runtime-config.json");
      assert.equal(response.status, 200);
      const serialized = JSON.stringify(response.body);
      assert.ok(!serialized.includes(f.key));
      assert.ok(!serialized.includes("localTeamLoginKey"));
      for (const team of event.teams) assert.ok(!serialized.includes(team.teamLoginKey));
    }
    assert.equal((await f.request("admin", "/api/events", "GET", undefined, "")).status, 401);
    assert.equal((await f.request("participant", "/api/portal/me")).status, 401);
    assert.equal(
      (await f.request("admin", "/api/host/login", "POST", { key: "incorrect" }, "")).status,
      401,
    );
  }));
test("Host and participant listeners reject the other role", () =>
  fixture(async (f) => {
    const event = await f.create();
    assert.equal(
      (
        await f.request(
          "admin",
          "/api/events",
          "GET",
          undefined,
          required(event.teams[0]).teamLoginKey,
        )
      ).status,
      401,
    );
    assert.equal(
      (await f.request("participant", "/api/events", "GET", undefined, f.adminToken)).status,
      404,
    );
    assert.equal(
      (await f.request("participant", "/api/portal/me", "GET", undefined, f.adminToken)).status,
      401,
    );
    assert.equal(
      (await f.request("participant", "/api/host/login", "POST", { key: f.key })).status,
      404,
    );
  }));
test("Host/Origin, malformed bodies and private filesystem routes fail closed", () =>
  fixture(async (f) => {
    assert.equal(
      (
        await f.request("admin", "/api/events", "GET", undefined, undefined, {
          origin: "https://evil.example",
        })
      ).status,
      403,
    );
    const wrongHostStatus = await new Promise<number>((accept, reject) => {
      const request = httpRequest(
        `${f.admin.origin}/api/events`,
        { headers: { host: "evil.example" } },
        (response) => {
          response.resume();
          response.once("end", () => accept(response.statusCode ?? 0));
        },
      );
      request.once("error", reject);
      request.end();
    });
    assert.equal(wrongHostStatus, 403);
    for (const path of ["/host-key.json", "/state.sqlite", "/assets/%2e%2e/state.sqlite"]) {
      const result = await f.request("admin", path);
      assert.equal(result.status, 404);
      assert.ok(!JSON.stringify(result.body).includes(f.key));
    }
    const malformed = await fetch(`${f.admin.origin}/api/host/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    assert.equal(malformed.status, 400);
    await malformed.text();
    const oversized = await fetch(`${f.admin.origin}/api/host/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "x".repeat(70_000) }),
    });
    assert.equal(oversized.status, 413);
    await oversized.text();
  }));
test("Real HTTP exercise, separate team flags and single award under concurrent submissions", () =>
  fixture(async (f) => {
    const event = await f.create();
    await f.deploy(event.eventId);
    await f.begin(event.eventId);
    const a = required(event.teams[0]);
    const b = required(event.teams[1]);
    const ca = await f.challenge(a.teamLoginKey);
    const cb = await f.challenge(b.teamLoginKey);
    assert.notEqual(ca.flag, cb.flag);
    assert.notEqual(ca.origin, cb.origin);
    const requests = await Promise.all(
      Array.from({ length: 12 }, () =>
        f.request(
          "participant",
          "/api/portal/me/submit-flag",
          "POST",
          { problemId: "sqli-demo", flag: ca.flag },
          a.teamLoginKey,
        ),
      ),
    );
    assert.ok(requests.every((result) => result.status === 200));
    assert.equal(requests.filter((result) => result.body.kind === "ok").length, 1);
    assert.equal(f.store.team(a.teamId).score, 100);
    assert.equal(f.store.team(a.teamId).scoreEvents.length, 1);
    assert.equal(f.store.team(b.teamId).score, 0);
    const stolen = await f.request(
      "participant",
      "/api/portal/me/submit-flag",
      "POST",
      { problemId: "sqli-demo", flag: ca.flag },
      b.teamLoginKey,
    );
    assert.equal(stolen.body.kind, "wrong");
    assert.equal(f.store.team(b.teamId).score, -5);
    const forged = await f.request(
      "participant",
      "/api/portal/me/submit-flag",
      "POST",
      {
        problemId: "sqli-demo",
        flag: cb.flag,
        teamId: a.teamId,
      },
      b.teamLoginKey,
    );
    assert.equal(forged.status, 400);
  }));
test("Idempotent wrong submissions, hint charges and payload conflict detection", () =>
  fixture(async (f) => {
    const event = await f.create();
    await f.deploy(event.eventId);
    await f.begin(event.eventId);
    const a = required(event.teams[0]);
    const headers = { "idempotency-key": "retry-one-0001" };
    for (let index = 0; index < 2; index++) {
      assert.equal(
        (
          await f.request(
            "participant",
            "/api/portal/me/submit-flag",
            "POST",
            { problemId: "sqli-demo", flag: "wrong" },
            a.teamLoginKey,
            headers,
          )
        ).status,
        200,
      );
    }
    assert.equal(f.store.team(a.teamId).score, -5);
    assert.equal(
      (
        await f.request(
          "participant",
          "/api/portal/me/submit-flag",
          "POST",
          { problemId: "sqli-demo", flag: "different" },
          a.teamLoginKey,
          headers,
        )
      ).status,
      409,
    );
    const path = "/api/portal/me/problems/sqli-demo/hints/hint-1/reveal";
    for (let index = 0; index < 2; index++)
      assert.equal((await f.request("participant", path, "POST", {}, a.teamLoginKey)).status, 200);
    assert.equal(f.store.team(a.teamId).score, -25);
  }));
test("Start, lock and end gates also prevent early instructions and writeup disclosure", () =>
  fixture(async (f) => {
    const event = await f.create();
    await f.deploy(event.eventId);
    const a = required(event.teams[0]);
    const before = await f.request<PortalView>(
      "participant",
      "/api/portal/me",
      "GET",
      undefined,
      a.teamLoginKey,
    );
    assert.equal(before.body.eventGate.kind, "scoring_not_started");
    assert.equal(required(before.body.problems[0]).instructions, "");
    assert.deepEqual(required(before.body.problems[0]).stackOutputs, {});
    const submit = () =>
      f.request(
        "participant",
        "/api/portal/me/submit-flag",
        "POST",
        { problemId: "sqli-demo", flag: "wrong" },
        a.teamLoginKey,
      );
    assert.equal((await submit()).body.kind, "scoring_not_started");
    await f.begin(event.eventId);
    const during = await f.request<PortalView>(
      "participant",
      "/api/portal/me",
      "GET",
      undefined,
      a.teamLoginKey,
    );
    assert.ok(!JSON.stringify(during.body).includes("private-solution"));
    assert.ok(!JSON.stringify(during.body).includes("private-english-solution"));
    assert.equal(required(during.body.problems[0]).lifecycle, undefined);
    assert.equal(
      (await f.request("admin", `/api/events/${event.eventId}/lock-scoring`, "POST", {})).status,
      200,
    );
    assert.equal((await submit()).body.kind, "scoring_locked");
    await f.request("admin", `/api/events/${event.eventId}/lock-scoring`, "DELETE", {});
    assert.equal((await submit()).status, 200);
    assert.equal(
      (await f.request("admin", `/api/events/${event.eventId}/end`, "POST", {})).status,
      200,
    );
    assert.equal((await submit()).body.kind, "scoring_ended");
  }));
test("Verifier completion after the server deadline does not persist a score", () =>
  fixture(async (f) => {
    const event = await f.create();
    await f.deploy(event.eventId);
    await f.begin(event.eventId, 1000);
    const a = required(event.teams[0]);
    const challenge = await f.challenge(a.teamLoginKey);
    f.engine.verifyDelay = 50;
    const request = f.request(
      "participant",
      "/api/portal/me/submit-flag",
      "POST",
      { problemId: "sqli-demo", flag: challenge.flag },
      a.teamLoginKey,
    );
    setTimeout(() => f.advance(1001), 10);
    assert.equal((await request).body.kind, "scoring_ended");
    assert.equal(f.store.team(a.teamId).score, 0);
    assert.equal(f.store.team(a.teamId).snapshot, null);
  }));
test("Challenge handoffs are one-use, private, route-limited and revoked by team-key rotation", () =>
  fixture(async (f) => {
    const event = await f.create();
    await f.deploy(event.eventId);
    await f.begin(event.eventId);
    const a = required(event.teams[0]);
    const b = required(event.teams[1]);
    const ca = await f.challenge(a.teamLoginKey);
    const cb = await f.challenge(b.teamLoginKey);
    const reused = await fetch(ca.usedLink, { redirect: "manual" });
    assert.equal(reused.status, 401);
    await reused.text();
    const leaked = await fetch(`${cb.origin}/`, { headers: { cookie: ca.cookie } });
    assert.equal(leaked.status, 401);
    await leaked.text();
    const verifier = await fetch(`${ca.origin}/verify`, { headers: { cookie: ca.cookie } });
    assert.equal(verifier.status, 404);
    await verifier.text();
    // A `no-referrer` document makes browsers send `Origin: null` on the exercise's own form
    // POST, which the same-origin gate would refuse (found by the browser rehearsal).
    const exercisePage = await fetch(`${ca.origin}/`, { headers: { cookie: ca.cookie } });
    assert.equal(exercisePage.status, 200);
    assert.equal(exercisePage.headers.get("referrer-policy"), "same-origin");
    await exercisePage.text();
    const csrf = await fetch(`${ca.origin}/login`, {
      method: "POST",
      headers: { cookie: ca.cookie, origin: f.participant.origin },
      body: "username=admin",
    });
    assert.equal(csrf.status, 403);
    await csrf.text();
    const rotated = await f.request<{ teamLoginKey: string }>(
      "admin",
      `/api/events/${event.eventId}/teams/${a.teamId}/rotate-login-key`,
      "POST",
      {},
    );
    assert.equal(rotated.status, 200);
    assert.equal(
      (await f.request("participant", "/api/portal/me", "GET", undefined, a.teamLoginKey)).status,
      401,
    );
    const revoked = await fetch(`${ca.origin}/`, { headers: { cookie: ca.cookie } });
    assert.equal(revoked.status, 401);
    await revoked.text();
    assert.equal(
      (
        await f.request(
          "participant",
          "/api/portal/me",
          "GET",
          undefined,
          rotated.body.teamLoginKey,
        )
      ).status,
      200,
    );
  }));
test("Restart preserves teams, credentials, score history, receipt and real runtime", () =>
  fixture(async (f) => {
    const event = await f.create();
    await f.deploy(event.eventId);
    await f.begin(event.eventId);
    const a = required(event.teams[0]);
    const challenge = await f.challenge(a.teamLoginKey);
    const headers = { "idempotency-key": "durable-request-1" };
    const body = { problemId: "sqli-demo", flag: challenge.flag };
    assert.equal(
      (
        await f.request(
          "participant",
          "/api/portal/me/submit-flag",
          "POST",
          body,
          a.teamLoginKey,
          headers,
        )
      ).status,
      200,
    );
    const starts = f.engine.starts.length;
    await f.restart();
    assert.equal(f.engine.starts.length, starts);
    assert.equal(f.store.team(a.teamId).score, 100);
    assert.equal(f.store.team(a.teamId).scoreEvents.length, 1);
    assert.equal(
      (
        await f.request(
          "participant",
          "/api/portal/me/submit-flag",
          "POST",
          body,
          a.teamLoginKey,
          headers,
        )
      ).body.kind,
      "ok",
    );
    assert.equal(f.store.team(a.teamId).scoreEvents.length, 1);
    const after = await f.challenge(a.teamLoginKey);
    assert.equal(after.flag, challenge.flag);
    await f.request("admin", `/api/events/${event.eventId}/end`, "POST", {});
    await f.restart();
    assert.equal(f.store.event(event.eventId).status, "ENDED");
  }));
test("Runtime failures stay failures; retry and teardown preserve ownership on failure", () =>
  fixture(async (f) => {
    const event = await f.create();
    f.engine.failStart = true;
    await f.deploy(event.eventId);
    assert.equal(f.store.event(event.eventId).status, "DEPLOYING");
    assert.ok(
      f.store.jobs(event.eventId).every((job) => job.status === "FAILED" && job.unit !== null),
    );
    f.engine.failStart = false;
    await f.deploy(event.eventId);
    await f.begin(event.eventId);
    f.engine.failStop = true;
    assert.equal(
      (await f.request("admin", `/api/events/${event.eventId}`, "DELETE", {})).status,
      202,
    );
    await f.service.drain();
    assert.ok(
      f.store.jobs(event.eventId).every((job) => job.status === "FAILED" && job.unit !== null),
    );
    assert.equal(
      (await f.request("admin", `/api/events/${event.eventId}/archive`, "POST", {})).status,
      409,
    );
    f.engine.failStop = false;
    await f.request("admin", `/api/events/${event.eventId}`, "DELETE", {});
    await f.service.drain();
    assert.ok(
      f.store.jobs(event.eventId).every((job) => job.status === "DELETED" && job.unit === null),
    );
    assert.equal(f.store.teams(event.eventId).length, 2);
  }));
test("Teardown never affects another event; participants cannot reset or stop", () =>
  fixture(async (f) => {
    const first = await f.create("First");
    const second = await f.create("Second");
    await f.deploy(first.eventId);
    await f.deploy(second.eventId);
    await f.begin(first.eventId);
    await f.begin(second.eventId);
    const b = required(second.teams[0]);
    const original = await f.challenge(b.teamLoginKey);
    for (const action of ["start", "stop", "reset", "terminal-handoff"]) {
      assert.equal(
        (
          await f.request(
            "participant",
            `/api/portal/me/problems/sqli-demo/${action}`,
            "POST",
            {},
            required(first.teams[0]).teamLoginKey,
          )
        ).status,
        404,
      );
    }
    await f.request("admin", `/api/events/${first.eventId}`, "DELETE", {});
    await f.service.drain();
    assert.ok(f.store.jobs(second.eventId).every((job) => job.status === "COMPLETE"));
    assert.equal((await f.challenge(b.teamLoginKey)).flag, original.flag);
    const foreign = await f.request(
      "admin",
      `/api/events/${first.eventId}/teams/${b.teamId}/rotate-login-key`,
      "POST",
      {},
    );
    assert.equal(foreign.status, 404);
  }));
test("Session revocation, expiration and invalid-login rate limiting", () =>
  fixture(async (f) => {
    const revoked = await fetch(`${f.admin.origin}/api/host/oauth2/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: f.refreshToken }),
    });
    assert.equal(revoked.status, 200);
    await revoked.text();
    assert.equal((await f.request("admin", "/api/events")).status, 401);
    await f.login();
    f.advance(15 * 60_000 + 1);
    assert.equal((await f.request("admin", "/api/events")).status, 401);
    f.advance(60_001);
    for (let index = 0; index < 10; index++)
      assert.equal(
        (await f.request("admin", "/api/host/login", "POST", { key: "invalid" }, "")).status,
        401,
      );
    assert.equal(
      (await f.request("admin", "/api/host/login", "POST", { key: "invalid" }, "")).status,
      429,
    );
  }));
test("SQLite rejects a second writer and private files reject symlinks", () =>
  fixture(async (f) => {
    const second = openDatabase(f.databasePath);
    assert.throws(() => new HostStore(second), /lock/iu);
    second.close();
    assert.equal(statSync(f.databasePath).mode & 0o777, 0o600);
    assert.equal(statSync(f.directory).mode & 0o777, 0o700);
    assert.equal(persistentKey(join(f.directory, "host-key")), f.key);
    const link = join(f.directory, "linked-key");
    symlinkSync(join(f.directory, "host-key"), link);
    assert.throws(() => persistentKey(link));
  }));
test("Input validation, metadata allowlist, safe LAN opt-in and stable identifiers", async () => {
  const metadata = {
    id: "demo",
    name: "Demo",
    description: "secret",
    instructions: "early",
    scoring: { flag: "SECRET" },
    writeup: "answer",
    i18n: {
      en: {
        name: "Demo",
        writeup: "translated-answer",
        hints: ["hint-answer"],
      },
    },
    runtime: {
      provider: "docker",
      engine: "compose",
      secretEnv: ["FLAG_SEED"],
    },
  };
  const sanitized = required(
    publicMetadata(JSON.stringify(metadata), "/repo/problems/challenges/demo/metadata.json"),
  );
  for (const hidden of ["secret", "early", "SECRET", "answer", "FLAG_SEED"])
    assert.ok(!sanitized.includes(hidden));
  assert.throws(() => parseOptions(["--lan", "0.0.0.0", "--unsafe-lan"], "/tmp"));
  assert.throws(() => parseOptions(["--lan", TEST_PRIVATE_ADDRESS], "/tmp"));
  assert.throws(() => parseOptions(["--admin-port", "5175"], "/tmp"));
  assert.equal(
    parseOptions(["--lan", TEST_PRIVATE_ADDRESS, "--unsafe-lan"], "/tmp").hostname,
    TEST_PRIVATE_ADDRESS,
  );
  const ids = Array.from({ length: 100 }, () => id());
  assert.equal(new Set(ids).size, 100);
  assert.ok(ids.every((value) => /^[0-9A-HJKMNP-TV-Z]{26}$/u.test(value)));
  assert.equal(randomToken().length, 43);
  await fixture(async (f) => {
    assert.equal(
      (
        await f.request("admin", "/api/events", "POST", {
          name: "",
          teams: [],
          problems: [],
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.request("admin", "/api/events", "POST", {
          name: "Invalid",
          teams: [{ internalSlug: "a" }],
          problems: [{ problemId: "not-supported" }],
        })
      ).status,
      422,
    );
  });
});
test("Multiple teammates get independent one-use handoffs", () =>
  fixture(async (f) => {
    const event = await f.create();
    await f.deploy(event.eventId);
    await f.begin(event.eventId);
    const key = required(event.teams[0]).teamLoginKey;
    const [first, second] = await Promise.all([
      f.request<PortalView>("participant", "/api/portal/me", "GET", undefined, key),
      f.request<PortalView>("participant", "/api/portal/me", "GET", undefined, key),
    ]);
    const firstLink = required(required(first.body.problems[0]).stackOutputs.Web);
    const secondLink = required(required(second.body.problems[0]).stackOutputs.Web);
    assert.notEqual(firstLink, secondLink);
    for (const link of [firstLink, secondLink]) {
      const response = await fetch(link, { redirect: "manual" });
      assert.equal(response.status, 303);
      await response.text();
    }
  }));
test("Lost and interrupted environments become retryable after restart", () =>
  fixture(async (f) => {
    const event = await f.create();
    await f.deploy(event.eventId);
    const first = required(f.store.jobs(event.eventId)[0]);
    await f.engine.stop(first);
    await f.restart();
    assert.equal(f.store.job(first.jobId).status, "FAILED");
    assert.equal(f.store.event(event.eventId).status, "DEPLOYING");
    await f.deploy(event.eventId);
    assert.equal(f.store.event(event.eventId).status, "READY");
    const other = await f.create("Interrupted");
    await f.deploy(other.eventId);
    const pending = required(f.store.jobs(other.eventId)[0]);
    await f.engine.stop(pending);
    pending.status = "IN_PROGRESS";
    pending.unit = null;
    f.store.putJob(pending);
    await f.restart();
    assert.equal(f.store.job(pending.jobId).status, "FAILED");
    await f.deploy(other.eventId);
    assert.equal(f.store.event(other.eventId).status, "READY");
  }));
test("Hosting build excludes unrelated problem code, templates and installed packs", async () => {
  const code = `const a = import.meta.glob("../../../../problems/*/*/metadata.json");
const b = import.meta.glob("../../../../problems/*/*/*.yaml");
const c = import.meta.glob("../../../../.tenkacloud/pack-store/snapshots/**/metadata.json");`;
  const transformed = required(
    narrowCatalog(code, "/repo/apps/application-admin-console/src/data/problems.ts"),
  );
  assert.ok(!transformed.includes("pack-store"));
  assert.ok(!transformed.includes("problems/*/*"));
  assert.ok(transformed.includes("sqli-demo/__local_host_empty__/**/*"));
  const plugins = required(
    narrowCatalog(
      'import.meta.glob("../../../../problems/*/*/portal/*.tsx")',
      "/repo/apps/participant-portal/src/plugins/loader.ts",
    ),
  );
  assert.ok(plugins.includes("problems/challenges/sqli-demo/portal/"));
  assert.doesNotThrow(() =>
    assertHostingModule("/repo/problems/challenges/sqli-demo/metadata.json"),
  );
  assert.throws(() =>
    assertHostingModule("/repo/problems/challenges/sqli-demo/local/app/server.mjs"),
  );
  assert.throws(() => assertHostingModule("/repo/problems/challenges/other/metadata.json"));
  assert.throws(() => assertHostingModule("/repo/.tenkacloud/pack-store/snapshots/secret.json"));
  assert.throws(() =>
    narrowCatalog("changed-glob", "/repo/apps/participant-portal/src/plugins/loader.ts"),
  );
});

test("Stopping, restarting and removing team A's environment leaves team B untouched", () =>
  fixture(async (f) => {
    const event = await f.create();
    await f.deploy(event.eventId);
    await f.begin(event.eventId);
    const a = required(event.teams[0]);
    const b = required(event.teams[1]);
    const jobA = required(f.store.jobs(event.eventId, a.teamId)[0]).jobId;
    const jobB = required(f.store.jobs(event.eventId, b.teamId)[0]).jobId;
    const ca = await f.challenge(a.teamLoginKey);
    let cb = await f.challenge(b.teamLoginKey);
    const solved = await f.request(
      "participant",
      "/api/portal/me/submit-flag",
      "POST",
      { problemId: "sqli-demo", flag: cb.flag },
      b.teamLoginKey,
    );
    assert.equal(solved.body.kind, "ok");
    const teamB = () => {
      const job = f.store.job(jobB);
      const team = f.store.team(b.teamId);
      return {
        status: job.status,
        unit: job.unit,
        offset: job.offset,
        operation: job.operation,
        running: f.engine.running.has(jobB),
        score: team.score,
        scoreEvents: team.scoreEvents.length,
        snapshot: team.snapshot,
      };
    };
    const untouched = teamB();
    assert.equal(untouched.score, 100);
    async function assertTeamBUntouched(): Promise<void> {
      assert.deepEqual(teamB(), untouched);
      // Team B's existing gateway session keeps serving its own environment.
      const page = await fetch(`${cb.origin}/`, { headers: { cookie: cb.cookie } });
      assert.equal(page.status, 200);
      await page.text();
      const again = await f.challenge(b.teamLoginKey);
      assert.equal(again.origin, cb.origin);
      assert.equal(again.flag, cb.flag);
      assert.ok(!f.engine.stops.includes(jobB));
      assert.ok(!f.engine.pauses.includes(jobB));
      assert.ok(!f.engine.resumes.includes(jobB));
      assert.equal(f.store.event(event.eventId).status, "READY");
    }
    const operate = async (method: string, suffix: string) => {
      const response = await f.request(
        "admin",
        `/api/events/${event.eventId}/deployments/${jobA}${suffix}`,
        method,
        method === "POST" ? {} : undefined,
      );
      assert.equal(response.status, 202, JSON.stringify(response.body));
      await f.service.drain();
    };

    await operate("POST", "/stop");
    assert.equal(f.store.job(jobA).status, "STOPPED");
    assert.equal(f.store.job(jobA).operation, undefined);
    assert.ok(f.store.job(jobA).unit, "A stopped environment keeps its ownership record.");
    await assert.rejects(fetch(`${ca.origin}/`, { headers: { cookie: ca.cookie } }));
    const stoppedView = await f.request<PortalView & { problems: { status: string }[] }>(
      "participant",
      "/api/portal/me",
      "GET",
      undefined,
      a.teamLoginKey,
    );
    assert.equal(required(stoppedView.body.problems[0]).status, "DELETED");
    assert.deepEqual(required(stoppedView.body.problems[0]).stackOutputs, {});
    const refused = await f.request(
      "participant",
      "/api/portal/me/submit-flag",
      "POST",
      { problemId: "sqli-demo", flag: ca.flag },
      a.teamLoginKey,
    );
    assert.equal(refused.status, 409);
    await assertTeamBUntouched();

    // A deliberately stopped environment neither fails recovery nor demotes the ready event.
    await f.restart();
    assert.equal(f.store.job(jobA).status, "STOPPED");
    // Gateway sessions live in memory; the reopened gateway keeps its fixed port.
    const reopened = await f.challenge(b.teamLoginKey);
    assert.equal(reopened.origin, cb.origin);
    cb = reopened;
    await assertTeamBUntouched();

    await operate("POST", "/restart");
    assert.equal(f.store.job(jobA).status, "COMPLETE");
    assert.deepEqual(f.engine.resumes, [jobA]);
    assert.equal((await f.challenge(a.teamLoginKey)).flag, ca.flag);
    await assertTeamBUntouched();

    await operate("DELETE", "");
    assert.equal(f.store.job(jobA).status, "DELETED");
    assert.equal(f.store.job(jobA).unit, null);
    assert.deepEqual(f.engine.stops, [jobA]);
    await assertTeamBUntouched();

    // A removed environment is rebuilt from scratch by restart.
    const starts = f.engine.starts.length;
    await operate("POST", "/restart");
    assert.equal(f.store.job(jobA).status, "COMPLETE");
    assert.equal(f.engine.starts.length, starts + 1);
    await assertTeamBUntouched();
    assert.equal(f.store.team(a.teamId).score, 0);
  }));
test("Environment operations are event-scoped, serialized and explained when refused", () =>
  fixture(async (f) => {
    const first = await f.create("First");
    const second = await f.create("Second");
    await f.deploy(first.eventId);
    await f.deploy(second.eventId);
    const foreignJob = required(f.store.jobs(second.eventId)[0]).jobId;
    const foreign = await f.request(
      "admin",
      `/api/events/${first.eventId}/deployments/${foreignJob}/stop`,
      "POST",
      {},
    );
    assert.equal(foreign.status, 404);
    assert.equal(f.store.job(foreignJob).status, "COMPLETE");
    const job = required(f.store.jobs(first.eventId)[0]).jobId;
    const path = `/api/events/${first.eventId}/deployments/${job}`;
    f.engine.operationDelay = 500;
    const stop = await f.request("admin", `${path}/stop`, "POST", {});
    const overlapping = await f.request("admin", `${path}/restart`, "POST", {});
    assert.equal(stop.status, 202);
    assert.equal(overlapping.status, 409);
    assert.match(String(overlapping.body.message), /already in progress/u);
    await f.service.drain();
    f.engine.operationDelay = 0;
    const again = await f.request("admin", `${path}/stop`, "POST", {});
    assert.equal(again.status, 409);
    assert.match(String(again.body.message), /Only a running environment/u);
    await f.begin(first.eventId);
    await f.request("admin", `/api/events/${first.eventId}/end`, "POST", {});
    const late = await f.request("admin", `${path}/restart`, "POST", {});
    assert.equal(late.status, 409);
    assert.match(String(late.body.message), /prepared or is ready/u);
    const detail = await f.request<{
      deploymentsByProblem: Record<string, { jobId: string; status: string }[]>;
    }>("admin", `/api/events/${first.eventId}`);
    const stopped = required(detail.body.deploymentsByProblem["sqli-demo"]).find(
      (entry) => entry.jobId === job,
    );
    assert.equal(required(stopped).status, "STOPPED");
  }));
test("Exercise gateways use the fixed port of their slot and skip ports held elsewhere", () =>
  fixture(async (f) => {
    const blocker = createNetServer();
    await new Promise<void>((accept) => blocker.listen(f.gatewayPorts.start, "127.0.0.1", accept));
    try {
      const event = await f.create();
      await f.deploy(event.eventId);
      await f.begin(event.eventId);
      const detail = await f.request<{
        deploymentsByProblem: Record<string, { jobId: string; gatewayPort?: number }[]>;
      }>("admin", `/api/events/${event.eventId}`);
      for (const team of event.teams) {
        const job = required(f.store.jobs(event.eventId, team.teamId)[0]);
        const expected = f.gatewayPorts.start + job.offset / 1000 - 1;
        assert.notEqual(expected, f.gatewayPorts.start, "The occupied first port is skipped.");
        assert.ok(expected <= f.gatewayPorts.end);
        const reported = required(detail.body.deploymentsByProblem["sqli-demo"]).find(
          (entry) => entry.jobId === job.jobId,
        );
        assert.equal(required(reported).gatewayPort, expected);
        const { origin } = await f.challenge(team.teamLoginKey);
        assert.equal(Number(new URL(origin).port), expected);
      }
    } finally {
      await new Promise<void>((accept) => blocker.close(() => accept()));
    }
    assert.deepEqual(parseGatewayPorts("5200-5239"), { start: 5200, end: 5239 });
    assert.equal(parseOptions([], "/tmp").gatewayPorts.start, 5200);
    assert.throws(() => parseOptions(["--gateway-ports", "5170-5180"], "/tmp"), /must not/u);
    assert.throws(() => parseOptions(["--gateway-ports", "6000-5000"], "/tmp"));
    assert.throws(() => parseOptions(["--gateway-ports", "80-90"], "/tmp"));
  }));
test("A never-started event recovers from teardown; one that ran stays final", () =>
  fixture(async (f) => {
    const event = await f.create();
    f.engine.failStart = true;
    f.engine.failStop = true;
    await f.deploy(event.eventId);
    assert.ok(f.store.jobs(event.eventId).every((job) => job.status === "FAILED" && job.unit));
    f.engine.failStop = false;
    // The recovery the error message used to recommend.
    assert.equal(
      (await f.request("admin", `/api/events/${event.eventId}`, "DELETE", {})).status,
      202,
    );
    await f.service.drain();
    assert.equal(f.store.event(event.eventId).status, "TEARDOWN");
    assert.equal(f.store.event(event.eventId).endsAt, undefined);
    f.engine.failStart = false;
    await f.deploy(event.eventId);
    assert.equal(f.store.event(event.eventId).status, "READY");
    await f.begin(event.eventId);
    await f.request("admin", `/api/events/${event.eventId}/end`, "POST", {});
    await f.request("admin", `/api/events/${event.eventId}`, "DELETE", {});
    await f.service.drain();
    const refused = await f.request("admin", `/api/events/${event.eventId}/deploy`, "POST", {});
    assert.equal(refused.status, 409);
    assert.match(String(refused.body.message), /already ran/u);
  }));
test("Without a Docker daemon, deployment reports that cause and retry advice", async () => {
  const bin = mkdtempSync(join(tmpdir(), "tenkacloud-no-daemon-"));
  const fake = join(bin, "docker");
  // Test double at the process boundary: the real Docker CLI's unreachable-daemon output.
  writeFileSync(
    fake,
    '#!/bin/sh\nif [ "$2" = "version" ]; then echo "Docker Compose version v2"; exit 0; fi\necho "failed to connect to the docker API at unix:///var/run/docker.sock; check if the path is correct and if the daemon is running" >&2\nexit 1\n',
    { mode: 0o700 },
  );
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path ?? ""}`;
  const data = privateDirectory(mkdtempSync(join(tmpdir(), "tenkacloud-no-daemon-data-")));
  const databasePath = join(data, "hosting.sqlite");
  prepareDatabase(databasePath);
  const store = new HostStore(openDatabase(databasePath));
  try {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const engine = new DockerHostingEngine(root, data);
    const service = new HostingService(store, engine, persistentKey(join(data, "host-key")));
    const problem = required(engine.catalog()[0]);
    const session = await service.admin({
      method: "POST",
      path: "/host/login",
      query: new URLSearchParams(),
      body: { key: persistentKey(join(data, "host-key")) },
      token: "",
    });
    const token = String(object(session.body).idToken);
    const call = (method: string, requestPath: string, body: unknown = {}) =>
      service.admin({ method, path: requestPath, query: new URLSearchParams(), body, token });
    const created = object(
      (
        await call("POST", "/events", {
          name: "No daemon",
          teams: [{ internalSlug: "team-a" }, { internalSlug: "team-b" }],
          problems: [{ problemId: problem.problemId }],
        })
      ).body,
    );
    const eventId = String(created.eventId);
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.equal((await call("POST", `/events/${eventId}/deploy`)).status, 202);
      await service.drain();
      const jobs = store.jobs(eventId);
      assert.equal(jobs.length, 2);
      for (const job of jobs) {
        assert.equal(job.status, "FAILED");
        // The daemon failure is not masked by the equally failing cleanup, and the advice is
        // the retry that actually works (not a teardown).
        assert.equal(job.error, DAEMON_UNAVAILABLE_MESSAGE);
        assert.ok(job.unit, "Ownership is retained until a cleanup succeeds.");
      }
      assert.equal(store.event(eventId).status, "DEPLOYING");
    }
  } finally {
    process.env.PATH = path;
    store.close();
    rmSync(bin, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }
});

async function main(): Promise<void> {
  const hasBun = "Bun" in globalThis;
  const moduleName = hasBun ? "bun:sqlite" : "node:sqlite";
  const driver = (await import(moduleName)) as {
    Database?: DatabaseConstructor;
    DatabaseSync?: DatabaseConstructor;
  };
  const Constructor = driver.Database ?? driver.DatabaseSync;
  if (!Constructor) throw new Error("No real SQLite driver available.");
  openDatabase = (path) => new Constructor(path);
  const results: {
    name: string;
    status: string;
    milliseconds: number;
    error?: string;
  }[] = [];
  for (const entry of testCases) {
    const start = Date.now();
    try {
      console.log(`RUN ${entry.name}`);
      await entry.run();
      results.push({
        name: entry.name,
        status: "passed",
        milliseconds: Date.now() - start,
      });
      console.log(`PASS ${entry.name}`);
    } catch (error) {
      results.push({
        name: entry.name,
        status: "failed",
        milliseconds: Date.now() - start,
        error: error instanceof Error ? error.stack : String(error),
      });
      console.error(`FAIL ${entry.name}\n${error instanceof Error ? error.stack : String(error)}`);
    }
  }
  const report = {
    runtime: hasBun ? "Bun" : "Node",
    version: process.version,
    sqlite: moduleName,
    timestamp: new Date().toISOString(),
    passed: results.filter((result) => result.status === "passed").length,
    failed: results.filter((result) => result.status === "failed").length,
    scope:
      "Real HTTP and SQLite control-plane integration with a test-only exercise adapter, not production Docker/UI verification",
    results,
  };
  if (process.env.HOST_TEST_REPORT)
    writeFileSync(process.env.HOST_TEST_REPORT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.passed} passed; ${report.failed} failed.`);
  if (report.failed) process.exitCode = 1;
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
