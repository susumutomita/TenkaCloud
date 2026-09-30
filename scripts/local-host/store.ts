import { createHash } from "node:crypto";
import {
  type CompetitorAccount,
  HostError,
  type HostedEvent,
  type Job,
  type SqlDatabase,
  type SqlStatement,
  type Team,
} from "./model";
import type { OrganizerRole } from "./organizer-access";
export const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

interface BodyRow {
  body: string;
}

export type { OrganizerRole } from "./organizer-access";
export type OrganizerStatus = "active" | "disabled";
export type OrganizerAuthMethod = "host-key" | "local-password" | "saml";
export interface OrganizerUser {
  id: string;
  username: string;
  role: OrganizerRole;
  status: OrganizerStatus;
  authVersion: number;
  passwordHash: string;
  createdAt: number;
}
export type OrganizerView = Omit<OrganizerUser, "passwordHash">;
export interface OrganizerIdentity {
  id: string;
  provider: string;
  issuer: string;
  subject: string;
  userId: string;
}
export interface OrganizerPrincipal {
  userId: string | null;
  identityId: string | null;
  role: OrganizerRole;
  authMethod: OrganizerAuthMethod;
}
/** Exclusive connection: two host processes must not independently award one submission. */
export class HostStore {
  private readonly statements = new Map<string, SqlStatement>();
  private connectionClosed = false;
  private transactionDepth = 0;

  statement(sql: string): SqlStatement {
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
        if (versions.length !== 1 || ![1, 2, 3, 4, 5].includes(versions[0]?.version ?? 0))
          throw new Error("Unsupported local-host database schema.");
      }
      database.exec(`
        CREATE TABLE IF NOT EXISTS host_schema(version INTEGER NOT NULL) STRICT;
        INSERT INTO host_schema SELECT 5 WHERE NOT EXISTS (SELECT 1 FROM host_schema);
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
        CREATE TABLE IF NOT EXISTS host_coordination(
          event_id TEXT NOT NULL REFERENCES host_events(id), problem_id TEXT NOT NULL,
          body TEXT NOT NULL, PRIMARY KEY(event_id,problem_id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS host_requests(
          team_id TEXT NOT NULL REFERENCES host_teams(id), nonce TEXT NOT NULL,
          fingerprint TEXT NOT NULL, status INTEGER NOT NULL, body TEXT NOT NULL,
          PRIMARY KEY(team_id,nonce)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS host_notifications(
          id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES host_events(id), body TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS host_accounts(account_id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;
      `);
      const version = this.statement("SELECT version FROM host_schema").get() as {
        version: number;
      };
      const oldIdentityShape = this.legacyOrganizerIdentity(version.version, Boolean(present));
      if (version.version < 4) {
        // Revoke prior short-lived sessions while keeping all durable records. The
        // identity shape is inspected for every prior version, including a v2 database.
        database.exec("DROP TABLE IF EXISTS host_sessions;");
        if (oldIdentityShape)
          database.exec(
            "ALTER TABLE host_organizer_identities RENAME TO host_organizer_identities_legacy;",
          );
      }
      if (version.version === 4)
        database.exec("ALTER TABLE host_sessions RENAME TO host_sessions_v4;");
      database.exec(`
        CREATE TABLE IF NOT EXISTS host_organizer_users(
          id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
          status TEXT NOT NULL, auth_version INTEGER NOT NULL,
          password_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
          CHECK(role IN ('Admin','Operator','Viewer')),
          CHECK(status IN ('active','disabled'))
        ) STRICT;
        CREATE TABLE IF NOT EXISTS host_organizer_identities(
          id TEXT PRIMARY KEY, provider TEXT NOT NULL,
          issuer TEXT NOT NULL, subject TEXT NOT NULL,
          user_id TEXT NOT NULL REFERENCES host_organizer_users(id) ON DELETE CASCADE,
          UNIQUE(provider,issuer,subject), UNIQUE(provider,issuer,user_id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS host_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS host_sessions(
          token_hash TEXT PRIMARY KEY, refresh_hash TEXT NOT NULL UNIQUE,
          user_id TEXT REFERENCES host_organizer_users(id) ON DELETE CASCADE,
          identity_id TEXT REFERENCES host_organizer_identities(id) ON DELETE CASCADE,
          auth_method TEXT NOT NULL, auth_version INTEGER NOT NULL,
          issued_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, expires INTEGER NOT NULL,
          CHECK(auth_method IN ('host-key','local-password','saml'))
        ) STRICT;
      `);
      if (oldIdentityShape) {
        this.statement(`
          INSERT INTO host_organizer_identities(id,provider,issuer,subject,user_id)
          SELECT lower(hex(randomblob(16))), 'local-password',
                 CASE WHEN issuer='local' THEN 'local-host' ELSE issuer END,
                 subject, user_id FROM host_organizer_identities_legacy
        `).run();
        const oldCount = this.statement(
          "SELECT count(*) AS count FROM host_organizer_identities_legacy",
        ).get() as { count: number };
        const newCount = this.statement(
          "SELECT count(*) AS count FROM host_organizer_identities",
        ).get() as { count: number };
        if (newCount.count !== oldCount.count)
          throw new Error("Organizer identity migration lost records.");
        database.exec("DROP TABLE host_organizer_identities_legacy;");
      }
      if (version.version === 4) this.migrateOrganizerSessions();
      if (version.version < 5) database.exec("UPDATE host_schema SET version=5;");
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
  private migrateOrganizerSessions(): void {
    this.statement("INSERT INTO host_sessions SELECT * FROM host_sessions_v4").run();
    const old = this.statement("SELECT count(*) AS count FROM host_sessions_v4").get() as {
      count: number;
    };
    const current = this.statement("SELECT count(*) AS count FROM host_sessions").get() as {
      count: number;
    };
    if (old.count !== current.count) throw new Error("Organizer session migration lost records.");
    this.database.exec("DROP TABLE host_sessions_v4");
  }
  private legacyOrganizerIdentity(version: number, existingSchema: boolean): boolean {
    const identityTable = this.statement(
      "SELECT name FROM sqlite_master WHERE name='host_organizer_identities'",
    ).get();
    if (!identityTable) {
      if (version === 3 || (existingSchema && version >= 4))
        throw new Error("Unsupported organizer identity schema.");
      return false;
    }
    const columns = (
      this.statement("PRAGMA table_info(host_organizer_identities)").all() as { name: string }[]
    ).map((column) => column.name);
    const required = columns.includes("provider")
      ? ["id", "provider", "issuer", "subject", "user_id"]
      : ["issuer", "subject", "user_id"];
    if (
      !required.every((name) => columns.includes(name)) ||
      (version >= 4 && !columns.includes("provider"))
    )
      throw new Error("Unsupported organizer identity schema.");
    return !columns.includes("provider");
  }
  transaction<T>(operation: () => T): T {
    const depth = this.transactionDepth;
    const savepoint = `host_tx_${depth}`;
    this.database.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
    this.transactionDepth += 1;
    try {
      const result = operation();
      this.database.exec(depth === 0 ? "COMMIT" : `RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      this.database.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO SAVEPOINT ${savepoint}`);
      if (depth !== 0) this.database.exec(`RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }
  coordination(eventId: string, problemId: string): string | undefined {
    const row = this.statement(
      "SELECT body FROM host_coordination WHERE event_id=? AND problem_id=?",
    ).get(eventId, problemId) as BodyRow | undefined;
    return row?.body;
  }
  putCoordination(eventId: string, problemId: string, body: string): void {
    this.statement(
      "INSERT INTO host_coordination(event_id,problem_id,body) VALUES (?,?,?) ON CONFLICT(event_id,problem_id) DO UPDATE SET body=excluded.body",
    ).run(eventId, problemId, body);
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
  accounts(): CompetitorAccount[] {
    return (
      this.statement("SELECT body FROM host_accounts ORDER BY rowid DESC").all() as BodyRow[]
    ).map((row) => JSON.parse(row.body) as CompetitorAccount);
  }
  account(accountId: string): CompetitorAccount {
    const row = this.statement("SELECT body FROM host_accounts WHERE account_id=?").get(
      accountId,
    ) as BodyRow | undefined;
    if (!row) throw new HostError(404, "Competitor account not found.");
    return JSON.parse(row.body) as CompetitorAccount;
  }
  putAccount(account: CompetitorAccount): void {
    this.statement(
      "INSERT INTO host_accounts(account_id,body) VALUES (?,?) ON CONFLICT(account_id) DO UPDATE SET body=excluded.body",
    ).run(account.awsAccountId, JSON.stringify(account));
  }
  deleteAccount(accountId: string): void {
    this.statement("DELETE FROM host_accounts WHERE account_id=?").run(accountId);
  }
  /** An event assignment remains authoritative until archival and physical cleanup. */
  accountReferenced(accountId: string): boolean {
    for (const event of this.events()) {
      for (const team of this.teams(event.eventId)) {
        if (team.aws?.accountId !== accountId) continue;
        if (event.status !== "ARCHIVED") return true;
        if (
          this.jobs(event.eventId, team.teamId).some(
            (job) => job.unit !== null || job.status !== "DELETED",
          )
        )
          return true;
      }
    }
    return false;
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
  /** Id only: a Battle job body carries the whole plugin bundle, too large to parse per poll. */
  jobId(eventId: string, teamId: string, problemId: string): string | undefined {
    const row = this.statement(
      "SELECT id FROM host_jobs WHERE event_id=? AND team_id=? AND problem_id=?",
    ).get(eventId, teamId, problemId) as { id: string } | undefined;
    return row?.id;
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
  bootstrapCompleted(): boolean {
    return this.setting("bootstrap_completed") === "true";
  }
  private setting(key: string): string | undefined {
    const row = this.statement("SELECT value FROM host_settings WHERE key=?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }
  featureFlags(): Record<string, boolean> {
    return {
      saml: this.setting("flag:saml") === "true",
      audit: this.setting("flag:audit") === "true",
    };
  }
  setFeatureFlag(key: "saml" | "audit", enabled: boolean): void {
    this.statement(
      "INSERT INTO host_settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(`flag:${key}`, String(enabled));
  }
  bootstrap(user: OrganizerUser): OrganizerIdentity {
    return this.transaction(() => {
      if (this.bootstrapCompleted()) throw new HostError(409, "Host bootstrap is complete.");
      this.insertOrganizer(user);
      this.statement(
        "INSERT INTO host_settings(key,value) VALUES ('bootstrap_completed','true')",
      ).run();
      this.statement("DELETE FROM host_sessions").run();
      const identity = this.localIdentity(user.id);
      if (!identity) throw new Error("Bootstrap identity was not stored.");
      return identity;
    });
  }
  insertOrganizer(user: OrganizerUser): void {
    this.statement(
      "INSERT INTO host_organizer_users(id,username,role,status,auth_version,password_hash,created_at) VALUES (?,?,?,?,?,?,?)",
    ).run(
      user.id,
      user.username,
      user.role,
      user.status,
      user.authVersion,
      user.passwordHash,
      user.createdAt,
    );
    this.statement(
      "INSERT INTO host_organizer_identities(id,provider,issuer,subject,user_id) VALUES (lower(hex(randomblob(16))),'local-password','local-host',?,?)",
    ).run(user.username, user.id);
  }
  identity(provider: string, issuer: string, subject: string): OrganizerIdentity | undefined {
    return this.statement(
      "SELECT id,provider,issuer,subject,user_id AS userId FROM host_organizer_identities WHERE provider=? AND issuer=? AND subject=?",
    ).get(provider, issuer, subject) as OrganizerIdentity | undefined;
  }
  localIdentity(userId: string): OrganizerIdentity | undefined {
    return this.statement(
      "SELECT id,provider,issuer,subject,user_id AS userId FROM host_organizer_identities WHERE provider='local-password' AND issuer='local-host' AND user_id=?",
    ).get(userId) as OrganizerIdentity | undefined;
  }
  organizer(id: string): OrganizerUser | undefined {
    return this.statement(
      "SELECT id,username,role,status,auth_version AS authVersion,password_hash AS passwordHash,created_at AS createdAt FROM host_organizer_users WHERE id=?",
    ).get(id) as OrganizerUser | undefined;
  }
  organizerByUsername(username: string): OrganizerUser | undefined {
    return this.statement(
      "SELECT u.id,u.username,u.role,u.status,u.auth_version AS authVersion,u.password_hash AS passwordHash,u.created_at AS createdAt FROM host_organizer_users u JOIN host_organizer_identities i ON i.user_id=u.id WHERE i.provider='local-password' AND i.issuer='local-host' AND i.subject=?",
    ).get(username) as OrganizerUser | undefined;
  }
  organizers(): OrganizerView[] {
    return this.statement(
      "SELECT id,username,role,status,auth_version AS authVersion,created_at AS createdAt FROM host_organizer_users ORDER BY username",
    ).all() as OrganizerView[];
  }
  updateOrganizer(user: OrganizerUser): void {
    this.transaction(() => {
      const current = this.organizer(user.id);
      if (!current) throw new HostError(404, "Organizer not found.");
      if (current.authVersion !== user.authVersion)
        throw new HostError(409, "Organizer changed during this request.");
      if (
        current.role === "Admin" &&
        current.status === "active" &&
        this.localIdentity(user.id) &&
        (user.role !== "Admin" || user.status !== "active") &&
        this.activeAdminCount() <= 1
      )
        throw new HostError(409, "At least one active local-password Admin is required.");
      this.statement(
        "UPDATE host_organizer_users SET role=?,status=?,password_hash=?,auth_version=auth_version+1 WHERE id=?",
      ).run(user.role, user.status, user.passwordHash, user.id);
      this.statement("DELETE FROM host_sessions WHERE user_id=?").run(user.id);
    });
  }
  deleteOrganizer(id: string): void {
    this.transaction(() => {
      const current = this.organizer(id);
      if (!current) throw new HostError(404, "Organizer not found.");
      if (
        current.role === "Admin" &&
        current.status === "active" &&
        this.localIdentity(id) &&
        this.activeAdminCount() <= 1
      )
        throw new HostError(409, "At least one active local-password Admin is required.");
      this.statement("DELETE FROM host_organizer_users WHERE id=?").run(id);
    });
  }
  private activeAdminCount(): number {
    const row = this.statement(
      "SELECT count(*) AS count FROM host_organizer_users u JOIN host_organizer_identities i ON i.user_id=u.id WHERE u.role='Admin' AND u.status='active' AND i.provider='local-password' AND i.issuer='local-host' AND u.password_hash<>''",
    ).get() as { count: number };
    return row.count;
  }
  private identityById(id: string): OrganizerIdentity | undefined {
    return this.statement(
      "SELECT id,provider,issuer,subject,user_id AS userId FROM host_organizer_identities WHERE id=?",
    ).get(id) as OrganizerIdentity | undefined;
  }
  private validIdentity(user: OrganizerUser, identity: OrganizerIdentity): boolean {
    if (identity.userId !== user.id || this.identityById(identity.id)?.userId !== user.id)
      return false;
    if (identity.provider === "saml") return this.featureFlags().saml === true;
    return (
      identity.provider === "local-password" &&
      identity.issuer === "local-host" &&
      identity.subject === user.username
    );
  }
  addSession(
    token: string,
    refresh: string,
    expires: number,
    now: number,
    user?: OrganizerUser,
    identity?: OrganizerIdentity,
  ): void {
    if (
      (user === undefined) !== (identity === undefined) ||
      (user && identity && !this.validIdentity(user, identity))
    )
      throw new HostError(401, "Organizer identity is invalid.");
    this.statement("DELETE FROM host_sessions WHERE expires<=?").run(now);
    let method: OrganizerAuthMethod = "host-key";
    if (identity?.provider === "saml") method = "saml";
    else if (user) method = "local-password";
    this.statement(
      "INSERT INTO host_sessions(token_hash,refresh_hash,user_id,identity_id,auth_method,auth_version,issued_at,last_seen,expires) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(
      digest(token),
      digest(refresh),
      user?.id ?? null,
      identity?.id ?? null,
      method,
      user?.authVersion ?? 0,
      now,
      now,
      expires,
    );
  }
  authenticateAdmin(token: string, now: number): OrganizerPrincipal {
    const row = this.statement(
      "SELECT user_id AS userId,identity_id AS identityId,auth_method AS authMethod,auth_version AS authVersion,last_seen AS lastSeen,expires FROM host_sessions WHERE token_hash=?",
    ).get(digest(token)) as
      | {
          userId: string | null;
          identityId: string | null;
          authMethod: OrganizerAuthMethod;
          authVersion: number;
          lastSeen: number;
          expires: number;
        }
      | undefined;
    if (!row || row.expires <= now || row.lastSeen + 15 * 60 * 1000 <= now)
      throw new HostError(401, "Host session expired or invalid.");
    if (row.authMethod === "host-key") {
      throw new HostError(401, "Host session expired or invalid.");
    }
    const user = row.userId ? this.organizer(row.userId) : undefined;
    const identity = row.identityId ? this.identityById(row.identityId) : undefined;
    if (
      user?.status !== "active" ||
      user.authVersion !== row.authVersion ||
      !identity ||
      identity.provider !== row.authMethod ||
      !this.validIdentity(user, identity)
    )
      throw new HostError(401, "Host session expired or invalid.");
    this.statement("UPDATE host_sessions SET last_seen=? WHERE token_hash=?").run(
      now,
      digest(token),
    );
    return {
      userId: user.id,
      identityId: identity.id,
      role: user.role,
      authMethod: row.authMethod,
    };
  }
  revokeSession(refresh: string): OrganizerPrincipal | undefined {
    return this.transaction(() => {
      const hash = digest(refresh);
      const principal = this.statement(`SELECT s.user_id AS userId,s.identity_id AS identityId,
        s.auth_method AS authMethod,u.role FROM host_sessions s JOIN host_organizer_users u ON u.id=s.user_id
        WHERE s.refresh_hash=?`).get(hash) as OrganizerPrincipal | null;
      this.statement("DELETE FROM host_sessions WHERE refresh_hash=?").run(hash);
      return principal ?? undefined;
    });
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
