import { DisruptionFireRequestSchema } from "@tenkacloud/problem-sdk/internal";
import { z } from "zod";
import {
  type DisruptionExecution,
  type DisruptionRequest,
  disruptionExecutionSchema,
  terminalExecution,
} from "./disruption-model";
import type { SqlStatement } from "./model";
import type { HostStore } from "./store";

const rowSchema = z.object({ body: z.string() });
const requestSchema = z.object({
  eventId: z.string(),
  requestId: z.string(),
  fingerprint: z.string(),
  input: DisruptionFireRequestSchema,
  auditId: z.string(),
  firedBy: z.string(),
  firedAt: z.string(),
  targetTeamIds: z.array(z.string()),
  parameters: z.record(z.unknown()),
  dueAt: z.number(),
  endsAt: z.number(),
  cancelled: z.boolean(),
  // Preserve retired metadata on existing request rows without using it for runtime work.
  acceptedAudit: z.unknown().optional(),
});

export class DisruptionStore {
  constructor(private readonly host: HostStore) {
    host.database.exec(`
      CREATE TABLE IF NOT EXISTS host_disruption_requests (
        event_id TEXT NOT NULL REFERENCES host_events(id), request_id TEXT NOT NULL,
        body TEXT NOT NULL, PRIMARY KEY(event_id, request_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS host_disruption_executions (
        id TEXT PRIMARY KEY, event_id TEXT NOT NULL, request_id TEXT NOT NULL,
        terminal INTEGER NOT NULL, due_at INTEGER NOT NULL, body TEXT NOT NULL,
        FOREIGN KEY(event_id,request_id) REFERENCES host_disruption_requests(event_id,request_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS host_disruption_due ON host_disruption_executions(terminal,due_at);
    `);
  }
  private statement(sql: string): SqlStatement {
    const statement = this.host.database.prepare(sql);
    return {
      get: (...values) => {
        try {
          return statement.get(...values);
        } finally {
          statement.finalize?.();
        }
      },
      all: (...values) => {
        try {
          return statement.all(...values);
        } finally {
          statement.finalize?.();
        }
      },
      run: (...values) => {
        try {
          return statement.run(...values);
        } finally {
          statement.finalize?.();
        }
      },
    };
  }
  request(eventId: string, requestId: string): DisruptionRequest | undefined {
    const row = this.statement(
      "SELECT body FROM host_disruption_requests WHERE event_id=? AND request_id=?",
    ).get(eventId, requestId);
    return row ? requestSchema.parse(JSON.parse(rowSchema.parse(row).body)) : undefined;
  }
  requests(eventId: string): DisruptionRequest[] {
    return this.statement(
      "SELECT body FROM host_disruption_requests WHERE event_id=? ORDER BY rowid DESC",
    )
      .all(eventId)
      .map((row) => requestSchema.parse(JSON.parse(rowSchema.parse(row).body)));
  }
  putRequest(request: DisruptionRequest): void {
    this.statement(
      "INSERT INTO host_disruption_requests(event_id,request_id,body) VALUES(?,?,?) ON CONFLICT(event_id,request_id) DO UPDATE SET body=excluded.body",
    ).run(request.eventId, request.requestId, JSON.stringify(request));
  }
  putExecution(execution: DisruptionExecution): void {
    this.statement(
      "INSERT INTO host_disruption_executions(id,event_id,request_id,terminal,due_at,body) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET terminal=excluded.terminal,due_at=excluded.due_at,body=excluded.body",
    ).run(
      execution.id,
      execution.eventId,
      execution.requestId,
      Number(terminalExecution(execution.status)),
      execution.dueAt,
      JSON.stringify(execution),
    );
  }
  executions(eventId: string): DisruptionExecution[] {
    return this.parse(
      this.statement(
        "SELECT body FROM host_disruption_executions WHERE event_id=? ORDER BY due_at, rowid",
      ).all(eventId),
    );
  }
  active(): DisruptionExecution[] {
    return this.parse(
      this.statement(
        "SELECT body FROM host_disruption_executions WHERE terminal=0 ORDER BY due_at,rowid",
      ).all(),
    );
  }
  private parse(rows: unknown[]): DisruptionExecution[] {
    return rows.map((row) =>
      disruptionExecutionSchema.parse(JSON.parse(rowSchema.parse(row).body)),
    );
  }
}
