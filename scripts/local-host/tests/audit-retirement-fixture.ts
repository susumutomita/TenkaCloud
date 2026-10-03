import type { HostStore } from "../store";

/** A database written by the retired feature, never a production schema migration. */
export function createLegacyAuditSchema(store: HostStore): void {
  store.database.exec(`
    CREATE TABLE host_audit_records(
      seq INTEGER PRIMARY KEY AUTOINCREMENT, occurred_at INTEGER NOT NULL,
      operation_id TEXT NOT NULL, phase TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
      resource_kind TEXT NOT NULL, resource_id TEXT NOT NULL, outcome TEXT NOT NULL,
      body TEXT NOT NULL CHECK(length(body)<=2048),
      UNIQUE(operation_id,phase,resource_kind,resource_id,outcome)
    ) STRICT;
    CREATE INDEX host_audit_time ON host_audit_records(occurred_at);
    CREATE TABLE host_audit_pending_jobs(
      job_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, body TEXT NOT NULL CHECK(length(body)<=2048)
    ) STRICT;
    CREATE TABLE host_audit_status(
      id INTEGER PRIMARY KEY CHECK(id=1), missed INTEGER NOT NULL DEFAULT 0,
      first_gap_at INTEGER, last_gap_at INTEGER, discarded INTEGER NOT NULL DEFAULT 0
    ) STRICT;
  `);
}

export function seedLegacyAudit(store: HostStore): void {
  createLegacyAuditSchema(store);
  store.database.exec(`
    INSERT INTO host_audit_status VALUES (1,2,1,2,3);
    INSERT INTO host_settings(key,value) VALUES ('flag:audit','true')
      ON CONFLICT(key) DO UPDATE SET value=excluded.value;
  `);
  const operationId = "00000000-0000-4000-8000-000000000001";
  const resourceId = "00000000-0000-4000-8000-000000000002";
  const record = {
    operationId,
    phase: "request",
    actor: { kind: "host-key", role: "Admin", authMethod: "host-key" },
    action: "event.created",
    resource: { kind: "event", id: resourceId },
    outcome: "succeeded",
  };
  store
    .statement(
      "INSERT INTO host_audit_records VALUES (1,1,?,'request','host-key','event.created','event',?,'succeeded',?)",
    )
    .run(operationId, resourceId, JSON.stringify(record));
  store.statement("INSERT INTO host_audit_pending_jobs VALUES (?,1,?)").run(
    resourceId,
    JSON.stringify({
      ...record,
      action: "event.deploy",
      resource: { kind: "job", id: resourceId },
      phase: "result",
      outcome: "unknown",
    }),
  );
}

export function legacyAuditSnapshot(store: HostStore) {
  return {
    records: store.statement("SELECT * FROM host_audit_records ORDER BY seq").all(),
    pending: store.statement("SELECT * FROM host_audit_pending_jobs ORDER BY job_id").all(),
    status: store.statement("SELECT * FROM host_audit_status ORDER BY id").all(),
    flag: store.statement("SELECT value FROM host_settings WHERE key='flag:audit'").get(),
  };
}

/** Any accidental collection, pruning or pending-job settlement fails the business test. */
export function rejectLegacyAuditWrites(store: HostStore): void {
  for (const table of ["host_audit_records", "host_audit_pending_jobs", "host_audit_status"])
    for (const operation of ["INSERT", "UPDATE", "DELETE"])
      store.database.exec(
        `CREATE TRIGGER reject_${table}_${operation} BEFORE ${operation} ON ${table}
         BEGIN SELECT RAISE(ABORT, 'retired audit storage must remain untouched'); END;`,
      );
}
