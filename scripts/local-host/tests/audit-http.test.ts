import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomToken } from "../auth";
import { startHttpHost } from "../http";
import { HostingService } from "../service";
import { HostStore } from "../store";
import {
  legacyAuditSnapshot,
  rejectLegacyAuditWrites,
  seedLegacyAudit,
} from "./audit-retirement-fixture";
import { ExerciseFixture } from "./exercise-fixture";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function fixture(guardLegacyWrites = true) {
  const directory = mkdtempSync(join(tmpdir(), "tenka-audit-http-"));
  const store = new HostStore(new Database(join(directory, "host.sqlite")));
  const engine = new ExerciseFixture((path) => new Database(path));
  const key = randomToken();
  const secret = randomToken();
  const logs: unknown[] = [];
  seedLegacyAudit(store);
  if (guardLegacyWrites) rejectLegacyAuditWrites(store);
  const before = legacyAuditSnapshot(store);
  const service = new HostingService(store, engine, key, Date.now, (message) => logs.push(message));
  const host = await startHttpHost({
    kind: "admin",
    hostname: "127.0.0.1",
    port: 0,
    staticRoot: directory,
    service,
    log: (error) => logs.push(error),
  });
  const portal = await startHttpHost({
    kind: "participant",
    hostname: "127.0.0.1",
    port: 0,
    staticRoot: directory,
    service,
    log: (error) => logs.push(error),
  });
  cleanups.push(async () => {
    await service.drain();
    for (const job of store.jobs()) if (job.unit) await engine.stop(job);
    await portal.close();
    await host.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const request = (path: string, method = "GET", body?: unknown, token = "") =>
    fetch(`${host.origin}/api${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const bootstrap = await request("/host/bootstrap", "POST", {
    key,
    username: "admin",
    password: secret,
  });
  expect(bootstrap.status).toBe(201);
  const { idToken: admin } = (await bootstrap.json()) as { idToken: string };
  const enable = (enabled: boolean) =>
    request("/feature-flags", "PUT", { key: "audit", enabled }, admin);
  const newEvent = () =>
    request(
      "/events",
      "POST",
      { name: secret, teams: [{ internalSlug: "alpha" }], problems: [{ problemId: "sqli-demo" }] },
      admin,
    );
  return {
    directory,
    before,
    store,
    service,
    engine,
    host,
    portal,
    request,
    admin,
    secret,
    key,
    enable,
    logs,
    newEvent,
  };
}

test("retired audit endpoints and enablement are unavailable while host access boundaries remain", async () => {
  const f = await fixture();
  for (const enabled of [true, false]) expect((await f.enable(enabled)).status).toBe(400);
  for (const path of ["/admin/audit-log", "/admin/audit-log/export"]) {
    expect((await f.request(path, "GET", undefined, f.admin)).status).toBe(404);
    expect((await f.request(path)).status).toBe(401);
    expect(
      (
        await fetch(`${f.portal.origin}/api${path}`, {
          headers: { authorization: `Bearer ${f.admin}` },
        })
      ).status,
    ).toBe(404);
  }
  for (const role of ["Operator", "Viewer"] as const) {
    const username = role.toLowerCase();
    expect(
      (await f.request("/host/users", "POST", { username, password: f.secret, role }, f.admin))
        .status,
    ).toBe(201);
    const signedIn = await f.request("/host/login", "POST", { username, password: f.secret });
    const { idToken } = (await signedIn.json()) as { idToken: string };
    expect((await f.request("/admin/audit-log", "GET", undefined, idToken)).status).toBe(404);
    expect(
      (await f.request("/feature-flags", "PUT", { key: "registration", enabled: true }, idToken))
        .status,
    ).toBe(403);
  }
  expect(
    (await f.request("/host/login", "POST", { username: "admin", password: randomToken() })).status,
  ).toBe(401);
  expect(legacyAuditSnapshot(f.store)).toEqual(f.before);
  expect(f.logs).toEqual([]);
});

test("event and deployment mutations keep atomic business transactions without audit storage", async () => {
  const f = await fixture();
  f.store.database.exec(
    "CREATE TRIGGER reject_team BEFORE INSERT ON host_teams BEGIN SELECT RAISE(ABORT, 'test team persistence failure'); END;",
  );
  expect((await f.newEvent()).status).toBe(500);
  expect(f.store.events()).toEqual([]);
  expect(f.store.statement("SELECT * FROM host_teams").all()).toEqual([]);
  f.store.database.exec("DROP TRIGGER reject_team");
  const { eventId } = (await (await f.newEvent()).json()) as { eventId: string };
  f.store.database.exec(
    "CREATE TRIGGER reject_job BEFORE INSERT ON host_jobs BEGIN SELECT RAISE(ABORT, 'test job persistence failure'); END;",
  );
  expect((await f.request(`/events/${eventId}/deploy`, "POST", {}, f.admin)).status).toBe(500);
  await f.service.drain();
  expect(f.store.event(eventId).status).toBe("DRAFT");
  expect(f.store.jobs()).toEqual([]);
  expect(f.engine.starts).toEqual([]);
  f.store.database.exec("DROP TRIGGER reject_job");
  expect((await f.request(`/events/${eventId}/deploy`, "POST", {}, f.admin)).status).toBe(202);
  await f.service.drain();
  expect(f.store.event(eventId).status).toBe("READY");
  expect(f.store.jobs(eventId)[0]?.status).toBe("COMPLETE");
  expect(legacyAuditSnapshot(f.store)).toEqual(f.before);
});

test("accepted runtime completion and teardown ignore retired audit storage", async () => {
  const f = await fixture();
  const { eventId } = (await (await f.newEvent()).json()) as { eventId: string };
  const { promise: ready, resolve: resume } = Promise.withResolvers<boolean>();
  const start = f.engine.start.bind(f.engine);
  f.engine.start = async (job, retain) => {
    await ready;
    await start(job, retain);
  };
  expect((await f.request(`/events/${eventId}/deploy`, "POST", {}, f.admin)).status).toBe(202);
  expect(f.store.jobs(eventId)).toHaveLength(1);
  resume(true);
  await f.service.drain();
  expect(f.store.jobs(eventId)[0]?.status).toBe("COMPLETE");
  expect(f.store.event(eventId).status).toBe("READY");
  expect((await f.request(`/events/${eventId}`, "DELETE", undefined, f.admin)).status).toBe(202);
  await f.service.drain();
  expect(f.store.jobs(eventId)[0]?.status).toBe("DELETED");
  expect(legacyAuditSnapshot(f.store)).toEqual(f.before);
  expect(f.logs).toEqual([]);
});

test("account verification revokes eligibility and ordinary account mutations remain available", async () => {
  const f = await fixture();
  let failVerification = false;
  f.service.accountConnection = {
    operatorAccountId: "999999999999",
    region: "ap-northeast-1",
    externalId: f.secret,
    verify: async () => {
      if (failVerification) throw new Error(f.secret);
    },
  };
  const accountId = "111111111111";
  expect(
    (
      await f.request(
        "/admin/competitor-accounts",
        "POST",
        { awsAccountId: accountId, alias: f.secret },
        f.admin,
      )
    ).status,
  ).toBe(201);
  expect(
    (await f.request(`/admin/competitor-accounts/${accountId}/verify`, "POST", {}, f.admin)).status,
  ).toBe(200);
  expect(f.store.account(accountId).verified).toBe(true);
  failVerification = true;
  expect(
    (await f.request(`/admin/competitor-accounts/${accountId}/verify`, "POST", {}, f.admin)).status,
  ).toBe(422);
  expect(f.store.account(accountId).verified).toBe(false);
  expect(
    (await f.request(`/admin/competitor-accounts/${accountId}`, "DELETE", undefined, f.admin))
      .status,
  ).toBe(200);
  const bulk = await f.request(
    "/admin/competitor-accounts/bulk",
    "POST",
    {
      accounts: [
        { awsAccountId: "222222222222" },
        { awsAccountId: "invalid" },
        { awsAccountId: "333333333333" },
      ],
    },
    f.admin,
  );
  expect(bulk.status).toBe(200);
  expect(await bulk.json()).toMatchObject({ created: 2, invalid: 1, failed: 0 });
  expect(legacyAuditSnapshot(f.store)).toEqual(f.before);
  expect(f.logs).toEqual([]);
});

test("browser revocation still invalidates only the revoked session", async () => {
  const f = await fixture();
  const signedIn = await f.request("/host/login", "POST", {
    username: "admin",
    password: f.secret,
  });
  const session = (await signedIn.json()) as { idToken: string; refreshToken: string };
  const revoked = await fetch(`${f.host.origin}/api/host/oauth2/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: session.refreshToken }),
  });
  expect(revoked.status).toBe(200);
  expect((await f.request("/host/me", "GET", undefined, session.idToken)).status).toBe(401);
  expect((await f.request("/host/me", "GET", undefined, f.admin)).status).toBe(200);
  expect(legacyAuditSnapshot(f.store)).toEqual(f.before);
});

test.each([
  { operation: "event-teardown", expected: "teardown", status: "DELETED" },
  { operation: "stop", expected: "stop", status: "STOPPED" },
  { operation: "restart", expected: "restart", status: "COMPLETE" },
  { operation: "teardown", expected: "teardown", status: "DELETED" },
] as const)(
  "restart completes accepted $operation from durable business state",
  async ({ operation, expected, status }) => {
    const f = await fixture(false);
    const { eventId } = (await (await f.newEvent()).json()) as { eventId: string };
    expect((await f.request(`/events/${eventId}/deploy`, "POST", {}, f.admin)).status).toBe(202);
    await f.service.drain();
    const job = f.store.jobs(eventId)[0];
    if (!job) throw new Error("Expected a deployed job.");
    if (operation === "restart") {
      expect(
        (await f.request(`/events/${eventId}/deployments/${job.jobId}/stop`, "POST", {}, f.admin))
          .status,
      ).toBe(202);
      await f.service.drain();
    }
    // Retired metadata for this exact job deliberately disagrees with its business intent.
    f.store.statement("INSERT INTO host_audit_pending_jobs VALUES (?,1,?)").run(
      job.jobId,
      JSON.stringify({
        operationId: "00000000-0000-4000-8000-000000000004",
        actor: { kind: "system" },
        action: expected === "teardown" ? "environment.restart" : "environment.teardown",
        resource: { kind: "job", id: job.jobId },
        phase: "result",
        outcome: "unknown",
      }),
    );
    const legacy = legacyAuditSnapshot(f.store);
    rejectLegacyAuditWrites(f.store);
    const snapshot = join(f.directory, "accepted.sqlite");
    const runtimeMethods = { teardown: "stop", stop: "pause", restart: "resume" } as const;
    const runtimeMethod = runtimeMethods[expected];
    const original = f.engine[runtimeMethod].bind(f.engine);
    f.engine[runtimeMethod] = async (target) => {
      // The accepted job/event transaction must already be durable before external work starts.
      f.store.statement("VACUUM INTO ?").run(snapshot);
      await original(target);
    };
    const suffix = operation === "teardown" ? "" : `/${operation}`;
    const path =
      operation === "event-teardown"
        ? `/events/${eventId}`
        : `/events/${eventId}/deployments/${job.jobId}${suffix}`;
    expect(
      (
        await f.request(
          path,
          operation.endsWith("teardown") ? "DELETE" : "POST",
          undefined,
          f.admin,
        )
      ).status,
    ).toBe(202);
    await f.service.drain();
    const store = new HostStore(new Database(snapshot));
    try {
      const engine = new ExerciseFixture((path) => new Database(path));
      const calls: string[] = [];
      engine.pause = async () => {
        calls.push("stop");
      };
      engine.resume = async () => {
        calls.push("restart");
      };
      engine.stop = async () => {
        calls.push("teardown");
      };
      engine.recover = async () => {
        throw new Error("Adoption cannot complete an accepted operation.");
      };
      const service = new HostingService(store, engine, randomToken());
      await service.recover();
      expect(calls).toEqual([expected]);
      expect(store.job(job.jobId).status).toBe(status);
      expect(store.job(job.jobId).operation).toBeUndefined();
      if (expected === "teardown") expect(store.job(job.jobId).unit).toBeNull();
      expect(legacyAuditSnapshot(store)).toEqual(legacy);
    } finally {
      store.close();
    }
  },
);
