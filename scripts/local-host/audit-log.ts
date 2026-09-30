import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  type AuditAction,
  type AuditActor,
  type AuditOperation,
  type AuditRecord,
  auditActionSchema,
  auditIdentifierSchema,
  auditRecordSchema,
} from "./audit-record";
import { HostError, type Job } from "./model";
import type { HostStore } from "./store";

export const AUDIT_MAX_ROWS = 10_000;
export const AUDIT_EXPORT_ROWS = 5_000;
export const AUDIT_RETENTION_MS = 30 * 24 * 60 * 60_000;
const AUDIT_MAX_BYTES = 2048;
const completedJobStatus: Partial<Record<AuditAction, Job["status"]>> = {
  "event.deploy": "COMPLETE",
  "event.teardown": "DELETED",
  "environment.restart": "COMPLETE",
  "environment.stop": "STOPPED",
  "environment.teardown": "DELETED",
};
function jobOutcome(action: AuditAction, status: Job["status"] | "unknown") {
  if (status === "FAILED") return "failed";
  return status === completedJobStatus[action] ? "succeeded" : "unknown";
}
interface StoredAudit {
  seq: number;
  occurredAt: number;
  body: string;
}
interface AuditStatus {
  missed: number;
  firstGapAt: number | null;
  lastGapAt: number | null;
  discarded: number;
}
function unavailable(): HostError {
  return new HostError(
    503,
    "Audit storage is unavailable. No audit payload was logged.",
    "audit_unavailable",
  );
}
function parseQuery(query: URLSearchParams, exporting: boolean) {
  const allowed = new Set(
    exporting
      ? ["from", "to", "principal", "action"]
      : ["from", "to", "principal", "action", "limit", "cursor"],
  );
  if ([...query.keys()].some((key) => !allowed.has(key) || query.getAll(key).length !== 1))
    throw new HostError(400, "Invalid audit filter.", "invalid_filter");
  const date = (key: "from" | "to") => {
    const value = query.get(key);
    if (value === null) return undefined;
    if (!z.string().datetime({ offset: true }).safeParse(value).success)
      throw new HostError(400, "Invalid audit date.", `invalid_${key}`);
    return Date.parse(value);
  };
  const from = date("from");
  const to = date("to");
  if (from !== undefined && to !== undefined && from > to)
    throw new HostError(400, "The audit date range is reversed.", "invalid_filter");
  const positive = (key: "limit" | "cursor", fallback: number, maximum: number) => {
    const raw = query.get(key);
    if (raw === null) return fallback;
    const value = Number(raw);
    if (!/^[1-9]\d*$/u.test(raw) || !Number.isSafeInteger(value) || value > maximum)
      throw new HostError(400, "Invalid audit page.", `invalid_${key}`);
    return value;
  };
  const principal = query.get("principal");
  if (
    principal !== null &&
    !["anonymous", "system"].includes(principal) &&
    !auditIdentifierSchema.safeParse(principal).success
  )
    throw new HostError(400, "Use an organizer ID, anonymous or system.", "invalid_principal");
  const action = query.get("action");
  if (action !== null && !auditActionSchema.safeParse(action).success)
    throw new HostError(400, "Use an exact audit action.", "invalid_action");
  return {
    from,
    to,
    principal,
    action,
    limit: positive("limit", 50, 200),
    cursor: positive("cursor", Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
  };
}
function wire(row: StoredAudit) {
  const record = auditRecordSchema.parse(JSON.parse(row.body));
  return {
    id: String(row.seq),
    tenantId: "local-host",
    actor: record.actor.kind === "organizer" ? record.actor.userId : record.actor.kind,
    action: record.action,
    outcome: record.outcome,
    target: record.resource.kind === "host" ? "host" : record.resource.id,
    occurredAt: new Date(row.occurredAt).toISOString(),
    actorKind: record.actor.kind,
    ...(record.actor.kind === "organizer"
      ? { actorRole: record.actor.role, authMethod: record.actor.authMethod }
      : {}),
    resourceKind: record.resource.kind,
    operationId: record.operationId,
    phase: record.phase,
    ...(record.reason ? { reason: record.reason } : {}),
  };
}
function csvCell(value: string | undefined): string {
  const text = value ?? "";
  const escaped = /^[=+@\-\t\r\n]/u.test(text) ? `'${text}` : text;
  return `"${escaped.replaceAll('"', '""')}"`;
}

export class HostAuditLog {
  private unsavedGaps = 0;
  constructor(
    private readonly store: HostStore,
    private readonly now: () => number,
  ) {
    store.database.exec(`
      CREATE TABLE IF NOT EXISTS host_audit_records(
        seq INTEGER PRIMARY KEY AUTOINCREMENT, occurred_at INTEGER NOT NULL,
        operation_id TEXT NOT NULL, phase TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
        resource_kind TEXT NOT NULL, resource_id TEXT NOT NULL, outcome TEXT NOT NULL, body TEXT NOT NULL CHECK(length(body)<=2048),
        UNIQUE(operation_id,phase,resource_kind,resource_id,outcome)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS host_audit_time ON host_audit_records(occurred_at);
      CREATE TABLE IF NOT EXISTS host_audit_pending_jobs(
        job_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, body TEXT NOT NULL CHECK(length(body)<=2048)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS host_audit_status(
        id INTEGER PRIMARY KEY CHECK(id=1), missed INTEGER NOT NULL DEFAULT 0,
        first_gap_at INTEGER, last_gap_at INTEGER, discarded INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      INSERT OR IGNORE INTO host_audit_status(id) VALUES (1);
    `);
  }
  private prune(): void {
    this.store
      .statement("DELETE FROM host_audit_pending_jobs WHERE created_at<?")
      .run(this.now() - AUDIT_RETENTION_MS);
    const removed = this.store
      .statement(`DELETE FROM host_audit_records WHERE occurred_at<? OR seq IN
      (SELECT seq FROM host_audit_records ORDER BY seq DESC LIMIT -1 OFFSET ?) RETURNING seq`)
      .all(this.now() - AUDIT_RETENTION_MS, AUDIT_MAX_ROWS);
    if (removed.length)
      this.store
        .statement("UPDATE host_audit_status SET discarded=discarded+? WHERE id=1")
        .run(removed.length);
  }
  commit<T>(operation: AuditOperation | undefined, work: () => T): T {
    return this.store.transaction(() => {
      if (operation) this.append({ ...operation, phase: "request", outcome: "succeeded" });
      return work();
    });
  }
  // Persist acceptance before starting external work. A failed audit write starts no work.
  accept<T>(operation: AuditOperation | undefined, jobIds: readonly string[], work: () => T): T {
    return this.store.transaction(() => {
      if (operation) {
        this.append({ ...operation, phase: "request", outcome: "accepted" });
        this.retainAcceptedJobs(operation, jobIds);
      }
      return work();
    });
  }
  private retainAcceptedJobs(operation: AuditOperation, jobIds: readonly string[]): void {
    try {
      if (!this.store.featureFlags().audit) return;
      for (const jobId of jobIds) {
        const record = auditRecordSchema.parse({
          ...operation,
          resource: { kind: "job", id: jobId },
          phase: "result",
          outcome: "unknown",
        });
        this.store
          .statement(
            "INSERT INTO host_audit_pending_jobs(job_id,created_at,body) VALUES (?,?,?) ON CONFLICT(job_id) DO UPDATE SET created_at=excluded.created_at,body=excluded.body",
          )
          .run(jobId, this.now(), JSON.stringify(record));
      }
    } catch {
      throw unavailable();
    }
  }
  settleJob(jobId: string, status: Job["status"] | "unknown"): void {
    try {
      this.store.transaction(() => {
        const pending = this.store
          .statement("SELECT body FROM host_audit_pending_jobs WHERE job_id=?")
          .get(jobId) as { body: string } | null;
        if (!pending) return;
        const record = auditRecordSchema.parse(JSON.parse(pending.body));
        const outcome = jobOutcome(record.action, status);
        const phase =
          record.action === "event.teardown" || record.action === "environment.teardown"
            ? "cleanup"
            : "result";
        this.append({
          ...record,
          phase,
          outcome,
          ...(outcome === "failed" ? { reason: "operation_failed" as const } : {}),
        });
        if (outcome !== "unknown")
          this.store.statement("DELETE FROM host_audit_pending_jobs WHERE job_id=?").run(jobId);
      });
    } catch {
      this.unsavedGaps += 1;
      this.flushGaps();
    }
  }
  // Synchronous business writes call this within their own transaction.
  append(input: AuditRecord): void {
    try {
      if (!this.store.featureFlags().audit) return;
      const record = auditRecordSchema.parse(input);
      const body = JSON.stringify(record);
      if (Buffer.byteLength(body) > AUDIT_MAX_BYTES) throw unavailable();
      this.store
        .statement(`INSERT INTO host_audit_records
        (occurred_at,operation_id,phase,actor,action,resource_kind,resource_id,outcome,body) VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(operation_id,phase,resource_kind,resource_id,outcome) DO NOTHING`)
        .run(
          this.now(),
          record.operationId,
          record.phase,
          record.actor.kind === "organizer" ? record.actor.userId : record.actor.kind,
          record.action,
          record.resource.kind,
          record.resource.kind === "host" ? "host" : record.resource.id,
          record.outcome,
          body,
        );
      this.prune();
    } catch {
      throw unavailable();
    }
  }
  setEnabled(enabled: boolean, actor: AuditActor): void {
    try {
      this.store.transaction(() => {
        if (this.store.featureFlags().audit === enabled) return;
        if (enabled) this.store.setFeatureFlag("audit", true);
        this.append({
          operationId: randomUUID(),
          phase: "recording",
          actor,
          action: enabled ? "audit.enabled" : "audit.disabled",
          resource: { kind: "feature", id: "audit" },
          outcome: "succeeded",
        });
        if (!enabled) {
          this.store.setFeatureFlag("audit", false);
          this.store.statement("DELETE FROM host_audit_pending_jobs").run();
        }
      });
    } catch {
      throw unavailable();
    }
  }
  // Accepted external operations must retain their result even if optional audit storage fails.
  observe(input: AuditRecord): void {
    try {
      if (!this.store.featureFlags().audit) return;
      this.store.transaction(() => this.append(input));
    } catch {
      this.unsavedGaps += 1;
      this.flushGaps();
    }
  }
  private flushGaps(): void {
    if (!this.unsavedGaps) return;
    try {
      this.store
        .statement(`UPDATE host_audit_status SET missed=missed+?,
        first_gap_at=COALESCE(first_gap_at,?),last_gap_at=? WHERE id=1`)
        .run(this.unsavedGaps, this.now(), this.now());
      this.unsavedGaps = 0;
    } catch {
      // The current process can report this gap even when the whole database is unwritable.
    }
  }
  private status() {
    this.flushGaps();
    const row = this.store
      .statement(`SELECT missed,first_gap_at AS firstGapAt,last_gap_at AS lastGapAt,discarded
      FROM host_audit_status WHERE id=1`)
      .get() as AuditStatus;
    return {
      enabled: this.store.featureFlags().audit,
      retentionDays: 30,
      maxRows: AUDIT_MAX_ROWS,
      missed: row.missed + this.unsavedGaps,
      firstGapAt: row.firstGapAt,
      lastGapAt: row.lastGapAt,
      discarded: row.discarded,
      gapStatusDurable: this.unsavedGaps === 0,
    };
  }
  private rows(query: ReturnType<typeof parseQuery>, limit: number): StoredAudit[] {
    const clauses = ["seq<?"];
    const bindings: (number | string)[] = [query.cursor];
    for (const [column, operator, value] of [
      ["occurred_at", ">=", query.from],
      ["occurred_at", "<=", query.to],
      ["actor", "=", query.principal],
      ["action", "=", query.action],
    ] as const) {
      if (value !== undefined && value !== null) {
        clauses.push(`${column}${operator}?`);
        bindings.push(value);
      }
    }
    return this.store
      .statement(
        `SELECT seq,occurred_at AS occurredAt,body FROM host_audit_records WHERE ${clauses.join(" AND ")} ORDER BY seq DESC LIMIT ?`,
      )
      .all(...bindings, limit) as StoredAudit[];
  }
  list(query: URLSearchParams) {
    const filters = parseQuery(query, false);
    try {
      this.store.transaction(() => this.prune());
      const rows = this.rows(filters, filters.limit + 1);
      const items = rows.slice(0, filters.limit).map(wire);
      return {
        items,
        ...(rows.length > filters.limit ? { nextCursor: items.at(-1)?.id } : {}),
        collection: this.status(),
      };
    } catch {
      throw unavailable();
    }
  }
  exportCsv(query: URLSearchParams): string {
    const filters = parseQuery(query, true);
    let rows: StoredAudit[];
    try {
      this.store.transaction(() => this.prune());
      rows = this.rows(filters, AUDIT_EXPORT_ROWS + 1);
    } catch {
      throw unavailable();
    }
    if (rows.length > AUDIT_EXPORT_ROWS)
      throw new HostError(
        413,
        "Export exceeds 5000 rows. Narrow the date or actor filter.",
        "audit_export_too_large",
      );
    try {
      const headers = [
        "id",
        "occurredAt",
        "actor",
        "actorKind",
        "actorRole",
        "authMethod",
        "action",
        "outcome",
        "resourceKind",
        "target",
        "operationId",
        "phase",
        "reason",
      ] as const;
      const lines = [
        headers.join(","),
        ...rows.map((row) => {
          const item = wire(row);
          return headers.map((key) => csvCell(item[key])).join(",");
        }),
      ];
      return `${lines.join("\r\n")}\r\n`;
    } catch {
      throw unavailable();
    }
  }
}
