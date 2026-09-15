import { createHash } from "node:crypto";
import {
  HostError,
  type HostedEvent,
  type Job,
  type SqlDatabase,
  type SqlStatement,
  type Team,
} from "./model";
export const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

interface BodyRow {
  body: string;
}
/** Exclusive connection: two host processes must not independently award one submission. */
export class HostStore {
  private readonly statements = new Map<string, SqlStatement>();
  private connectionClosed = false;

  private statement(sql: string): SqlStatement {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.database.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  get closed(): boolean {
    return this.connectionClosed;
  }

  constructor(readonly database: SqlDatabase) {
    database.exec(
      "PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON; PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;",
    );
    database.exec("BEGIN EXCLUSIVE");
    try {
      const present = this.statement(
        "SELECT name FROM sqlite_master WHERE name='host_schema'",
      ).get();
      if (present) {
        const versions = this.statement("SELECT version FROM host_schema").all() as {
          version: number;
        }[];
        if (versions.length !== 1 || versions[0]?.version !== 1)
          throw new Error("Unsupported local-host database schema.");
      }
      database.exec(`
        CREATE TABLE IF NOT EXISTS host_schema(version INTEGER NOT NULL) STRICT;
        INSERT INTO host_schema SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM host_schema);
        CREATE TABLE IF NOT EXISTS host_events(id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS host_teams(
          id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES host_events(id),
          login_hash TEXT NOT NULL UNIQUE, body TEXT NOT NULL, UNIQUE(id,event_id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS host_jobs(
          id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES host_events(id),
          team_id TEXT NOT NULL, problem_id TEXT NOT NULL, body TEXT NOT NULL,
          FOREIGN KEY(team_id,event_id) REFERENCES host_teams(id,event_id),
          UNIQUE(event_id,team_id,problem_id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS host_sessions(
          token_hash TEXT PRIMARY KEY, refresh_hash TEXT NOT NULL UNIQUE, expires INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS host_requests(
          team_id TEXT NOT NULL REFERENCES host_teams(id), nonce TEXT NOT NULL,
          fingerprint TEXT NOT NULL, status INTEGER NOT NULL, body TEXT NOT NULL,
          PRIMARY KEY(team_id,nonce)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS host_notifications(
          id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES host_events(id), body TEXT NOT NULL
        ) STRICT;
      `);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
  transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  events(): HostedEvent[] {
    return (
      this.statement("SELECT body FROM host_events ORDER BY rowid DESC").all() as BodyRow[]
    ).map((row) => JSON.parse(row.body) as HostedEvent);
  }
  event(id: string): HostedEvent {
    const row = this.statement("SELECT body FROM host_events WHERE id=?").get(id) as
      | BodyRow
      | undefined;
    if (!row) throw new HostError(404, "Event not found.");
    return JSON.parse(row.body) as HostedEvent;
  }
  putEvent(event: HostedEvent): void {
    this.statement(
      "INSERT INTO host_events(id,body) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
    ).run(event.eventId, JSON.stringify(event));
  }
  teams(eventId: string): Team[] {
    return (
      this.statement("SELECT body FROM host_teams WHERE event_id=? ORDER BY rowid").all(
        eventId,
      ) as BodyRow[]
    ).map((row) => JSON.parse(row.body) as Team);
  }
  team(id: string): Team {
    const row = this.statement("SELECT body FROM host_teams WHERE id=?").get(id) as
      | BodyRow
      | undefined;
    if (!row) throw new HostError(404, "Team not found.");
    return JSON.parse(row.body) as Team;
  }
  authenticateTeam(key: string): Team {
    const row = this.statement("SELECT body FROM host_teams WHERE login_hash=?").get(digest(key)) as
      | BodyRow
      | undefined;
    if (!row) throw new HostError(401, "Invalid team login key.");
    return JSON.parse(row.body) as Team;
  }
  putTeam(team: Team): void {
    this.statement(
      "INSERT INTO host_teams(id,event_id,login_hash,body) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET login_hash=excluded.login_hash,body=excluded.body",
    ).run(team.teamId, team.eventId, digest(team.loginKey), JSON.stringify(team));
  }
  jobs(eventId?: string, teamId?: string): Job[] {
    let rows: unknown[];
    if (eventId === undefined) {
      rows = this.statement("SELECT body FROM host_jobs ORDER BY rowid").all();
    } else if (teamId === undefined) {
      rows = this.statement("SELECT body FROM host_jobs WHERE event_id=? ORDER BY rowid").all(
        eventId,
      );
    } else {
      rows = this.statement(
        "SELECT body FROM host_jobs WHERE event_id=? AND team_id=? ORDER BY rowid",
      ).all(eventId, teamId);
    }
    return (rows as BodyRow[]).map((row) => JSON.parse(row.body) as Job);
  }
  job(id: string): Job {
    const row = this.statement("SELECT body FROM host_jobs WHERE id=?").get(id) as
      | BodyRow
      | undefined;
    if (!row) throw new HostError(404, "Deployment not found.");
    return JSON.parse(row.body) as Job;
  }
  putJob(job: Job): void {
    this.statement(
      "INSERT INTO host_jobs(id,event_id,team_id,problem_id,body) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
    ).run(job.jobId, job.eventId, job.teamId, job.problemId, JSON.stringify(job));
  }
  addSession(token: string, refresh: string, expires: number, now: number): void {
    this.statement("DELETE FROM host_sessions WHERE expires<=?").run(now);
    this.statement("INSERT INTO host_sessions(token_hash,refresh_hash,expires) VALUES (?,?,?)").run(
      digest(token),
      digest(refresh),
      expires,
    );
  }
  authenticateAdmin(token: string, now: number): void {
    const row = this.statement("SELECT expires FROM host_sessions WHERE token_hash=?").get(
      digest(token),
    ) as { expires: number } | undefined;
    if (!row || row.expires <= now) throw new HostError(401, "Host session expired or invalid.");
  }
  revokeSession(refresh: string): void {
    this.statement("DELETE FROM host_sessions WHERE refresh_hash=?").run(digest(refresh));
  }
  receipt(
    teamId: string,
    nonce: string,
    fingerprint: string,
  ):
    | {
        status: number;
        body: Record<string, unknown>;
      }
    | undefined {
    const row = this.statement(
      "SELECT fingerprint,status,body FROM host_requests WHERE team_id=? AND nonce=?",
    ).get(teamId, nonce) as
      | {
          fingerprint: string;
          status: number;
          body: string;
        }
      | undefined;
    if (!row) return undefined;
    if (row.fingerprint !== fingerprint)
      throw new HostError(409, "Idempotency key was used for a different request.");
    return { status: row.status, body: JSON.parse(row.body) as Record<string, unknown> };
  }
  putReceipt(
    teamId: string,
    nonce: string,
    fingerprint: string,
    status: number,
    body: unknown,
  ): void {
    this.statement(
      "INSERT INTO host_requests(team_id,nonce,fingerprint,status,body) VALUES (?,?,?,?,?)",
    ).run(teamId, nonce, fingerprint, status, JSON.stringify(body));
  }
  notifications(eventId: string): unknown[] {
    return (
      this.statement(
        "SELECT body FROM host_notifications WHERE event_id=? ORDER BY rowid DESC LIMIT 100",
      ).all(eventId) as BodyRow[]
    ).map((row) => JSON.parse(row.body) as unknown);
  }
  notify(eventId: string, notificationId: string, body: unknown): void {
    this.statement("INSERT INTO host_notifications(id,event_id,body) VALUES (?,?,?)").run(
      notificationId,
      eventId,
      JSON.stringify(body),
    );
  }
  close(): void {
    if (this.connectionClosed) return;
    for (const statement of this.statements.values()) statement.finalize?.();
    this.statements.clear();
    this.database.close();
    this.connectionClosed = true;
  }
}
