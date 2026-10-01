import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUDIT_EXPORT_ROWS, AUDIT_MAX_ROWS, AUDIT_RETENTION_MS, HostAuditLog } from "../audit-log";
import type { AuditActor, AuditRecord } from "../audit-record";
import { HostStore } from "../store";

const actor: AuditActor = {
  kind: "organizer",
  userId: randomUUID(),
  role: "Admin",
  authMethod: "local-password",
};
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});
function fixture(durable = false) {
  const directory = mkdtempSync(join(tmpdir(), "tenka-audit-"));
  const path = durable ? join(directory, "host.sqlite") : ":memory:";
  let store = new HostStore(new Database(path));
  let now = Date.now();
  let audit = new HostAuditLog(store, () => now);
  cleanups.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    get store() {
      return store;
    },
    get audit() {
      return audit;
    },
    advance(ms: number) {
      now += ms;
    },
    reopen() {
      store.close();
      store = new HostStore(new Database(path));
      audit = new HostAuditLog(store, () => now);
    },
  };
}
function record(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    operationId: randomUUID(),
    phase: "request",
    actor,
    action: "event.created",
    resource: { kind: "event", id: randomUUID() },
    outcome: "succeeded",
    ...overrides,
  };
}

test("audit defaults off, records both transitions atomically and stays readable after restart while off", () => {
  const f = fixture(true);
  f.audit.append(record());
  expect(f.audit.list(new URLSearchParams()).items).toEqual([]);
  f.audit.setEnabled(true, actor);
  f.store.transaction(() => f.audit.append(record()));
  f.audit.setEnabled(false, actor);
  f.audit.append(record());
  f.reopen();
  const page = f.audit.list(new URLSearchParams());
  expect(page.collection.enabled).toBe(false);
  expect(page.items.map((item) => item.action)).toEqual([
    "audit.disabled",
    "event.created",
    "audit.enabled",
  ]);
  expect(page.items[1]?.actor).toBe(actor.userId);
  expect(page.items[1]?.actorRole).toBe("Admin");
  expect(f.audit.exportCsv(new URLSearchParams())).toContain('"event.created"');
});

test("an audit failure rolls back synchronous work; observed external results survive and expose a durable gap", () => {
  const f = fixture(true);
  f.audit.setEnabled(true, actor);
  f.store.database.exec(
    "CREATE TRIGGER audit_failure BEFORE INSERT ON host_audit_records BEGIN SELECT RAISE(ABORT, 'private-provider-response'); END;",
  );
  const errors = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    expect(() =>
      f.store.transaction(() => {
        f.store.setFeatureFlag("saml", true);
        f.audit.append(record());
      }),
    ).toThrow("Audit storage is unavailable");
    expect(f.store.featureFlags().saml).toBe(false);
    f.store.setFeatureFlag("saml", true);
    f.audit.observe(record({ phase: "result", actor: { kind: "system" } }));
    expect(f.store.featureFlags().saml).toBe(true);
    expect(f.audit.list(new URLSearchParams()).collection.missed).toBe(1);
    expect(() => f.audit.setEnabled(false, actor)).toThrow("Audit storage is unavailable");
    expect(f.store.featureFlags().audit).toBe(true);
    expect(errors).not.toHaveBeenCalled();
  } finally {
    errors.mockRestore();
  }
  f.reopen();
  const state = f.audit.list(new URLSearchParams()).collection;
  expect(state.missed).toBe(1);
  expect(state.gapStatusDurable).toBe(true);
  expect(state.firstGapAt).not.toBeNull();
});

test("operation observations are idempotent without erasing an unknown outcome", () => {
  const f = fixture(true);
  f.audit.setEnabled(true, actor);
  const pending = record({
    phase: "result",
    outcome: "unknown",
    actor: { kind: "system" },
    action: "environment.restart",
  });
  f.audit.observe(pending);
  f.audit.observe(pending);
  f.reopen();
  f.audit.observe(pending);
  f.audit.observe({ ...pending, outcome: "succeeded" });
  const rows = f.audit.list(new URLSearchParams({ action: "environment.restart" })).items;
  expect(rows.map((row) => row.outcome)).toEqual(["succeeded", "unknown"]);
  expect(rows.map((row) => row.operationId)).toEqual([pending.operationId, pending.operationId]);
});

test("audit rejects arbitrary fields and identifiers without saving or logging supplied secrets", () => {
  const f = fixture();
  f.audit.setEnabled(true, actor);
  const secret = `private-${randomUUID()}`;
  const log = spyOn(console, "log").mockImplementation(() => undefined);
  const error = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    for (const unsafe of [
      { ...record(), extra: { password: secret } },
      { ...record(), actor: { ...actor, actorUsername: secret } },
      { ...record(), resource: { kind: "event", id: secret } },
    ])
      expect(() => f.audit.append(unsafe as AuditRecord)).toThrow("Audit storage is unavailable");
    const stored = f.store.statement("SELECT body FROM host_audit_records").all();
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(JSON.stringify(f.audit.list(new URLSearchParams()))).not.toContain(secret);
    expect(f.audit.exportCsv(new URLSearchParams())).not.toContain(secret);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
});

test("pagination is bounded, retention prunes old records and oversized exports explicitly fail", () => {
  const f = fixture();
  f.audit.setEnabled(true, actor);
  f.store.transaction(() => {
    for (let index = 0; index < AUDIT_MAX_ROWS + 1; index += 1) f.audit.append(record());
  });
  const first = f.audit.list(new URLSearchParams({ limit: "2" }));
  expect(first.items).toHaveLength(2);
  expect(first.collection.discarded).toBe(2);
  if (!first.nextCursor) throw new Error("Expected a second audit page.");
  const next = f.audit.list(new URLSearchParams({ limit: "2", cursor: first.nextCursor }));
  expect(next.items).toHaveLength(2);
  expect(new Set([...first.items, ...next.items].map((row) => row.id)).size).toBe(4);
  expect(() => f.audit.exportCsv(new URLSearchParams())).toThrow(
    `Export exceeds ${AUDIT_EXPORT_ROWS} rows`,
  );
  expect(() => f.audit.list(new URLSearchParams({ limit: "201" }))).toThrow("Invalid audit page");
  expect(() => f.audit.list(new URLSearchParams("tenantId=foreign"))).toThrow(
    "Invalid audit filter",
  );
  expect(() => f.audit.list(new URLSearchParams("limit=1&limit=2"))).toThrow(
    "Invalid audit filter",
  );
  f.advance(AUDIT_RETENTION_MS + 1);
  const expired = f.audit.list(new URLSearchParams());
  expect(expired.items).toEqual([]);
  expect(expired.collection.discarded).toBe(AUDIT_MAX_ROWS + 2);
}, 30_000);

test("failed enable leaves collection off and organizer deletion retains the operation-time actor", () => {
  const f = fixture();
  f.store.database.exec(
    "CREATE TRIGGER audit_failure BEFORE INSERT ON host_audit_records BEGIN SELECT RAISE(ABORT, 'unavailable'); END;",
  );
  expect(() => f.audit.setEnabled(true, actor)).toThrow("Audit storage is unavailable");
  expect(f.store.featureFlags().audit).toBe(false);
  expect(f.audit.list(new URLSearchParams()).items).toEqual([]);
  f.store.database.exec("DROP TRIGGER audit_failure;");
  f.audit.setEnabled(true, actor);
  const viewerId = randomUUID();
  f.store.insertOrganizer({
    id: viewerId,
    username: "viewer",
    role: "Viewer",
    status: "active",
    authVersion: 1,
    passwordHash: randomUUID(),
    createdAt: Date.now(),
  });
  f.audit.append(
    record({
      actor: { kind: "organizer", userId: viewerId, role: "Viewer", authMethod: "local-password" },
      outcome: "denied",
      reason: "not_permitted",
    }),
  );
  f.store.deleteOrganizer(viewerId);
  const rows = f.audit.list(new URLSearchParams({ principal: viewerId })).items;
  expect(rows).toHaveLength(1);
  expect(rows[0]?.actorRole).toBe("Viewer");
  expect(rows[0]?.outcome).toBe("denied");
});

test("accepted jobs keep actor and operation identity across restart without replaying stopped collection", () => {
  const f = fixture(true);
  f.audit.setEnabled(true, actor);
  const jobId = randomUUID();
  const operation = record({ action: "environment.restart", resource: { kind: "job", id: jobId } });
  f.audit.accept(operation, [jobId], () => undefined);
  f.reopen();
  f.audit.settleJob(jobId, "unknown");
  f.audit.settleJob(jobId, "COMPLETE");
  f.audit.settleJob(jobId, "COMPLETE");
  const rows = f.audit.list(new URLSearchParams({ action: "environment.restart" })).items;
  expect(rows.map((row) => row.outcome)).toEqual(["succeeded", "unknown", "accepted"]);
  expect(new Set(rows.map((row) => row.operationId))).toEqual(new Set([operation.operationId]));
  expect(rows.every((row) => row.actorRole === "Admin")).toBe(true);
  f.audit.accept({ ...operation, operationId: randomUUID() }, [jobId], () => undefined);
  f.audit.setEnabled(false, actor);
  f.audit.setEnabled(true, actor);
  const before = f.audit.list(new URLSearchParams()).items;
  f.audit.settleJob(jobId, "COMPLETE");
  expect(f.audit.list(new URLSearchParams()).items).toEqual(before);
});

test("nested business transactions roll back their audit record with the outer operation", () => {
  const f = fixture();
  f.audit.setEnabled(true, actor);
  const before = f.audit.list(new URLSearchParams()).items;
  expect(() =>
    f.store.transaction(() => {
      f.audit.commit(record(), () => f.store.setFeatureFlag("saml", true));
      throw new Error("Business operation rejected");
    }),
  ).toThrow("Business operation rejected");
  expect(f.store.featureFlags().saml).toBe(false);
  expect(f.audit.list(new URLSearchParams()).items).toEqual(before);
  f.store.transaction(() => {
    f.store.setFeatureFlag("saml", true);
    try {
      f.audit.commit(record(), () => {
        throw new Error("Inner operation rejected");
      });
    } catch {
      /* The outer write remains valid after the savepoint rolls back. */
    }
  });
  expect(f.store.featureFlags().saml).toBe(true);
  expect(f.audit.list(new URLSearchParams()).items).toEqual(before);
});

test("recovered runtime status only confirms the accepted operation's postcondition", () => {
  const f = fixture(true);
  f.audit.setEnabled(true, actor);
  for (const [action, expected] of [
    ["environment.stop", "STOPPED"],
    ["event.teardown", "DELETED"],
    ["environment.teardown", "DELETED"],
  ] as const) {
    const jobId = randomUUID();
    f.audit.accept(record({ action }), [jobId], () => undefined);
    f.reopen();
    f.audit.settleJob(jobId, "COMPLETE");
    expect(f.audit.list(new URLSearchParams({ action })).items.map((row) => row.outcome)).toEqual([
      "unknown",
      "accepted",
    ]);
    f.audit.settleJob(jobId, expected);
    expect(f.audit.list(new URLSearchParams({ action })).items.map((row) => row.outcome)).toEqual([
      "succeeded",
      "unknown",
      "accepted",
    ]);
  }
});
