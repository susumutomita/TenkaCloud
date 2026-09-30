import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomToken } from "../auth";
import { startHttpHost } from "../http";
import { HostingService } from "../service";
import { HostStore } from "../store";
import { ExerciseFixture } from "./exercise-fixture";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "tenka-audit-http-"));
  const store = new HostStore(new Database(join(directory, "host.sqlite")));
  const engine = new ExerciseFixture((path) => new Database(path));
  const key = randomToken();
  const secret = randomToken();
  const logs: unknown[] = [];
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
  const list = async () => {
    const result = await request("/admin/audit-log", "GET", undefined, admin);
    expect(result.status).toBe(200);
    return (await result.json()) as {
      items: {
        action: string;
        actor: string;
        actorRole?: string;
        outcome: string;
        phase: string;
        operationId: string;
      }[];
      collection: { enabled: boolean; missed: number };
    };
  };
  const newEvent = () =>
    request(
      "/events",
      "POST",
      { name: secret, teams: [{ internalSlug: "alpha" }], problems: [{ problemId: "sqli-demo" }] },
      admin,
    );
  return {
    directory,
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
    list,
    logs,
    newEvent,
  };
}

test("real HTTP audit defaults off, restricts reads to Admin, excludes credentials and remains readable while off", async () => {
  const f = await fixture();
  expect((await f.list()).items).toEqual([]);
  expect((await f.enable(true)).status).toBe(200);
  for (const role of ["Operator", "Viewer"] as const) {
    const username = role.toLowerCase();
    expect(
      (await f.request("/host/users", "POST", { username, password: f.secret, role }, f.admin))
        .status,
    ).toBe(201);
    const session = await f.request("/host/login", "POST", { username, password: f.secret });
    const { idToken } = (await session.json()) as { idToken: string };
    expect((await f.request("/admin/audit-log", "GET", undefined, idToken)).status).toBe(403);
    expect((await f.request("/admin/audit-log/export", "GET", undefined, idToken)).status).toBe(
      403,
    );
    expect(
      (await f.request("/feature-flags", "PUT", { key: "audit", enabled: false }, idToken)).status,
    ).toBe(403);
  }
  expect(
    (await f.request("/host/login", "POST", { username: f.secret, password: f.secret })).status,
  ).toBe(401);
  expect((await f.newEvent()).status).toBe(201);
  const on = await f.list();
  expect(
    on.items.some(
      (item) =>
        item.action === "organizer.login" &&
        item.actor === "anonymous" &&
        item.outcome === "denied",
    ),
  ).toBe(true);
  expect(
    on.items
      .filter((item) => item.action === "feature.updated" && item.outcome === "denied")
      .map((item) => item.actorRole)
      .sort((a, b) => String(a).localeCompare(String(b))),
  ).toEqual(["Operator", "Viewer"]);
  const csv = await f.request("/admin/audit-log/export", "GET", undefined, f.admin);
  expect(csv.status).toBe(200);
  expect(csv.headers.get("content-type")).toBe("text/csv; charset=utf-8");
  expect(csv.headers.get("cache-control")).toBe("no-store");
  const exported = await csv.text();
  const database = JSON.stringify(f.store.statement("SELECT body FROM host_audit_records").all());
  for (const secret of [f.secret, f.key, f.admin]) {
    expect(exported).not.toContain(secret);
    expect(database).not.toContain(secret);
  }
  expect(f.logs).toEqual([]);
  expect(
    (
      await fetch(`${f.portal.origin}/api/admin/audit-log`, {
        headers: { authorization: `Bearer ${f.admin}` },
      })
    ).status,
  ).toBe(404);
  expect((await f.enable(false)).status).toBe(200);
  const stopped = await f.list();
  expect(stopped.collection.enabled).toBe(false);
  expect(stopped.items[0]?.action).toBe("audit.disabled");
  expect((await f.newEvent()).status).toBe(201);
  expect((await f.list()).items).toEqual(stopped.items);
  expect(
    (await f.request("/admin/audit-log?tenantId=elsewhere", "GET", undefined, f.admin)).status,
  ).toBe(400);
});

test("audit storage failure prevents synchronous changes and external dispatch without hiding its failure", async () => {
  const f = await fixture();
  const created = await f.newEvent();
  const { eventId } = (await created.json()) as { eventId: string };
  expect((await f.enable(true)).status).toBe(200);
  f.store.database.exec(
    "CREATE TRIGGER fail_audit BEFORE INSERT ON host_audit_records BEGIN SELECT RAISE(ABORT, 'unavailable'); END;",
  );
  expect((await f.newEvent()).status).toBe(503);
  expect(f.store.events()).toHaveLength(1);
  expect(
    (
      await f.request(
        "/host/users",
        "POST",
        { username: "blocked-user", password: randomToken(), role: "Viewer" },
        f.admin,
      )
    ).status,
  ).toBe(503);
  expect(f.store.organizers().some((user) => user.username === "blocked-user")).toBe(false);
  expect((await f.request(`/events/${eventId}/deploy`, "POST", {}, f.admin)).status).toBe(503);
  await f.service.drain();
  expect(f.store.jobs()).toEqual([]);
  expect(f.engine.starts).toEqual([]);
  expect(f.store.event(eventId).status).toBe("DRAFT");
  const encodedId = `%${eventId.charCodeAt(0).toString(16)}${eventId.slice(1)}`;
  for (const path of [`/events/${encodedId}/archive`, `/events//${eventId}/%61rchive/`]) {
    expect((await f.request(path, "POST", {}, f.admin)).status).toBe(503);
    expect(f.store.event(eventId).status).toBe("DRAFT");
  }
  expect((await f.enable(false)).status).toBe(503);
  expect(f.store.featureFlags().audit).toBe(true);
  f.store.database.exec("DROP TRIGGER fail_audit");
  expect((await f.list()).collection.missed).toBeGreaterThan(0);
  expect(f.logs).toEqual([]);
});

test("an accepted runtime result persists when audit storage later fails", async () => {
  const f = await fixture();
  const created = await f.newEvent();
  const { eventId } = (await created.json()) as { eventId: string };
  expect((await f.enable(true)).status).toBe(200);
  const { promise: ready, resolve: resume } = Promise.withResolvers<boolean>();
  const start = f.engine.start.bind(f.engine);
  f.engine.start = async (job, retain) => {
    await ready;
    await start(job, retain);
  };
  expect((await f.request(`/events/${eventId}/deploy`, "POST", {}, f.admin)).status).toBe(202);
  const accepted = (await f.list()).items.find((item) => item.action === "event.deploy");
  expect(accepted?.outcome).toBe("accepted");
  f.store.database.exec(
    "CREATE TRIGGER fail_audit BEFORE INSERT ON host_audit_records BEGIN SELECT RAISE(ABORT, 'unavailable'); END;",
  );
  resume(true);
  await f.service.drain();
  expect(f.store.jobs(eventId)[0]?.status).toBe("COMPLETE");
  expect(f.store.event(eventId).status).toBe("READY");
  f.store.database.exec("DROP TRIGGER fail_audit");
  expect((await f.list()).collection.missed).toBe(1);
  expect((await f.request(`/events/${eventId}`, "DELETE", undefined, f.admin)).status).toBe(202);
  await f.service.drain();
  const cleanup = (await f.list()).items.filter((item) => item.action === "event.teardown");
  expect(cleanup.map((item) => item.phase).sort((a, b) => a.localeCompare(b))).toEqual([
    "cleanup",
    "request",
  ]);
  expect(new Set(cleanup.map((item) => item.operationId)).size).toBe(1);
  expect(f.store.jobs(eventId)[0]?.status).toBe("DELETED");
  expect(f.logs).toEqual([]);
});

test("competitor account audit uses account IDs, and failed verification still revokes eligibility during audit failure", async () => {
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
  expect((await f.enable(true)).status).toBe(200);
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
  f.store.database.exec(
    "CREATE TRIGGER fail_audit BEFORE INSERT ON host_audit_records BEGIN SELECT RAISE(ABORT, 'unavailable'); END;",
  );
  failVerification = true;
  expect(
    (await f.request(`/admin/competitor-accounts/${accountId}/verify`, "POST", {}, f.admin)).status,
  ).toBe(422);
  expect(f.store.account(accountId).verified).toBe(false);
  expect(
    (await f.request(`/admin/competitor-accounts/${accountId}`, "DELETE", undefined, f.admin))
      .status,
  ).toBe(503);
  expect(f.store.accounts()).toHaveLength(1);
  f.store.database.exec("DROP TRIGGER fail_audit");
  expect(
    (await f.request(`/admin/competitor-accounts/${accountId}`, "DELETE", undefined, f.admin))
      .status,
  ).toBe(200);
  const result = await f.request(
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
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ created: 2, invalid: 1, failed: 0 });
  const rows = f.service.audit.list(new URLSearchParams()).items;
  expect(
    rows.some(
      (item) => item.action === "competitor_account.registered" && item.target === accountId,
    ),
  ).toBe(true);
  expect(
    rows.some((item) => item.action === "competitor_account.verified" && item.target === accountId),
  ).toBe(true);
  expect(
    rows.some((item) => item.action === "competitor_account.deleted" && item.target === accountId),
  ).toBe(true);
  expect(JSON.stringify(rows)).not.toContain(f.secret);
  expect(f.logs).toEqual([]);
});

test("the browser revocation endpoint revokes its session even if optional audit storage fails", async () => {
  const f = await fixture();
  expect((await f.enable(true)).status).toBe(200);
  const signedIn = await f.request("/host/login", "POST", {
    username: "admin",
    password: f.secret,
  });
  const session = (await signedIn.json()) as { idToken: string; refreshToken: string };
  f.store.database.exec(
    "CREATE TRIGGER fail_audit BEFORE INSERT ON host_audit_records BEGIN SELECT RAISE(ABORT, 'unavailable'); END;",
  );
  const revoked = await fetch(`${f.host.origin}/api/host/oauth2/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: session.refreshToken }),
  });
  expect(revoked.status).toBe(200);
  expect((await f.request("/host/me", "GET", undefined, session.idToken)).status).toBe(401);
  f.store.database.exec("DROP TRIGGER fail_audit");
  expect((await f.list()).collection.missed).toBe(1);
  expect(f.logs).toEqual([]);
});

test.each([
  { operation: "event-teardown", expected: "teardown", status: "DELETED" },
  { operation: "stop", expected: "stop", status: "STOPPED" },
  { operation: "restart", expected: "restart", status: "COMPLETE" },
  { operation: "teardown", expected: "teardown", status: "DELETED" },
] as const)(
  "restart completes accepted $operation before recording success",
  async ({ operation, expected, status }) => {
    const f = await fixture();
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
    expect((await f.enable(true)).status).toBe(200);
    const snapshot = join(f.directory, "accepted.sqlite");
    const accept = f.service.audit.accept.bind(f.service.audit);
    f.service.audit.accept = (intent, jobs, work) => {
      const result = accept(intent, jobs, work);
      f.store.statement("VACUUM INTO ?").run(snapshot);
      return result;
    };
    const suffix = operation === "teardown" ? "" : `/${operation}`;
    const path =
      operation === "event-teardown"
        ? `/events/${eventId}`
        : `/events/${eventId}/deployments/${job.jobId}${suffix}`;
    const method = operation.endsWith("teardown") ? "DELETE" : "POST";
    expect((await f.request(path, method, undefined, f.admin)).status).toBe(202);
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
      const action = operation === "event-teardown" ? "event.teardown" : `environment.${operation}`;
      expect(
        service.audit.list(new URLSearchParams({ action })).items.map((row) => row.outcome),
      ).toEqual(["succeeded", "unknown", "accepted"]);
    } finally {
      store.close();
    }
  },
);
