import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomToken } from "../auth";
import { persistentKey, prepareDatabase, privateDirectory } from "../files";
import { startLocalHost } from "../server";
import { digest, HostStore } from "../store";
import { ExerciseFixture } from "./exercise-fixture";

/**
 * Older local hosting revisions stored organizer accounts, SAML links, disruption history and
 * their sessions. Organizer-key mode must still start on such a database, keep every stored row,
 * and never let one of those sessions or credentials sign in.
 */
const root = fileURLToPath(new URL("../../../", import.meta.url));
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const LEGACY_TABLES = `
  CREATE TABLE host_saml_config(id INTEGER PRIMARY KEY CHECK(id=1), revision TEXT NOT NULL, body TEXT) STRICT;
  INSERT INTO host_saml_config VALUES (1,'legacy-revision','{"issuer":"https://idp.example.test"}');
  CREATE TABLE host_disruption_requests (
    event_id TEXT NOT NULL REFERENCES host_events(id), request_id TEXT NOT NULL,
    body TEXT NOT NULL, PRIMARY KEY(event_id, request_id)
  ) STRICT;
  CREATE TABLE host_disruption_executions (
    id TEXT PRIMARY KEY, event_id TEXT NOT NULL, request_id TEXT NOT NULL,
    terminal INTEGER NOT NULL, due_at INTEGER NOT NULL, body TEXT NOT NULL,
    FOREIGN KEY(event_id,request_id) REFERENCES host_disruption_requests(event_id,request_id)
  ) STRICT;
  INSERT INTO host_events VALUES ('legacy-event','{"eventId":"legacy-event","name":"Legacy"}');
  INSERT INTO host_disruption_requests VALUES ('legacy-event','legacy-request','{"accepted":true}');
  INSERT INTO host_disruption_executions VALUES ('legacy-execution','legacy-event','legacy-request',1,0,'{"outcome":"done"}');
  INSERT INTO host_organizer_users VALUES
    ('legacy-admin','legacy-admin','Admin','active',1,'$argon2id$v=19$legacy-hash',1),
    ('legacy-sso','legacy-sso','Operator','active',1,'',1);
  INSERT INTO host_organizer_identities VALUES
    ('local-identity','local-password','local-host','legacy-admin','legacy-admin'),
    ('saml-identity','saml','https://idp.example.test','stable-subject','legacy-sso');
  INSERT INTO host_settings VALUES ('bootstrap_completed','true'), ('flag:saml','true');
`;

/** Session rows exactly as the retired password and SAML sign-in wrote them. */
function insertLegacySessions(database: Database, now: number) {
  const tokens = { password: randomToken(), saml: randomToken() };
  const insert = database.prepare(
    "INSERT INTO host_sessions(token_hash,refresh_hash,user_id,identity_id,auth_method,auth_version,issued_at,last_seen,expires) VALUES (?,?,?,?,?,1,?,?,?)",
  );
  insert.run(
    digest(tokens.password),
    digest(randomToken()),
    "legacy-admin",
    "local-identity",
    "local-password",
    now,
    now,
    now + 8 * 3600_000,
  );
  insert.run(
    digest(tokens.saml),
    digest(randomToken()),
    "legacy-sso",
    "saml-identity",
    "saml",
    now,
    now,
    now + 8 * 3600_000,
  );
  insert.finalize();
  return tokens;
}

/** Finalize before closing: an open statement keeps the file locked against the host. */
function rows(database: Database, sql: string): unknown[] {
  const statement = database.prepare(sql);
  try {
    return statement.all();
  } finally {
    statement.finalize();
  }
}

function retainedRows(path: string) {
  const database = new Database(path, { readonly: true });
  try {
    return Object.fromEntries(
      [
        "host_organizer_users",
        "host_organizer_identities",
        "host_saml_config",
        "host_disruption_requests",
        "host_disruption_executions",
      ].map((table) => [table, rows(database, `SELECT * FROM ${table} ORDER BY rowid`)]),
    );
  } finally {
    database.close();
  }
}

function legacyDirectory() {
  const directory = privateDirectory(mkdtempSync(join(tmpdir(), "tenka-legacy-organizer-")));
  directories.push(directory);
  const path = join(directory, "hosting.sqlite");
  persistentKey(join(directory, "host-key"));
  prepareDatabase(path);
  // HostStore writes today's schema; the retired modules created their tables on first use.
  new HostStore(new Database(path)).close();
  const database = new Database(path);
  try {
    database.exec(LEGACY_TABLES);
    insertLegacySessions(database, Date.now());
  } finally {
    database.close();
  }
  return { directory, path };
}

function start(directory: string) {
  return startLocalHost(
    root,
    {
      dataDirectory: directory,
      hostname: "127.0.0.1",
      adminPort: 0,
      participantPort: 0,
      gatewayPorts: { start: 58000, end: 58039 },
    },
    () => new ExerciseFixture((path) => new Database(path)),
    () => undefined,
  );
}

async function call(origin: string, path: string, token = "", body?: unknown) {
  const response = await fetch(`${origin}/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

test("a database with organizer accounts, SAML and their sessions starts in organizer-key mode", async () => {
  const { directory, path } = legacyDirectory();
  const before = retainedRows(path);
  const host = await start(directory);
  let key: string;
  try {
    if (!host.organizerKey)
      throw new Error("The legacy database did not receive an organizer key.");
    key = host.organizerKey;
    for (const body of [
      { username: "legacy-admin", password: randomToken() },
      { username: "legacy-admin", key },
      {},
    ])
      expect((await call(host.admin.origin, "/host/login", "", body)).status).toBe(401);
    const session = await call(host.admin.origin, "/host/login", "", { key });
    expect(session.status).toBe(200);
    const token = String(session.body.idToken);
    expect((await call(host.admin.origin, "/host/me", token)).body).toEqual({
      user: null,
      role: "Admin",
      authMethod: "host-key",
    });
    expect((await call(host.admin.origin, "/feature-flags", token)).body).toEqual({
      flags: { audit: false, challengePrerequisiteGate: false },
    });
  } finally {
    await host.stop();
  }
  expect(retainedRows(path)).toEqual(before);
  const settings = new Database(path, { readonly: true });
  try {
    expect(
      rows(
        settings,
        "SELECT key,value FROM host_settings WHERE key IN ('bootstrap_completed','flag:saml') ORDER BY key",
      ),
    ).toEqual([
      { key: "bootstrap_completed", value: "true" },
      { key: "flag:saml", value: "true" },
    ]);
  } finally {
    settings.close();
  }

  // Rows that outlive the key's first rotation still cannot authenticate, and restart keeps them.
  const database = new Database(path);
  const tokens = insertLegacySessions(database, Date.now());
  database.close();
  const restarted = await start(directory);
  try {
    expect(restarted.organizerKey).toBeUndefined();
    for (const token of [tokens.password, tokens.saml]) {
      expect((await call(restarted.admin.origin, "/events", token)).status).toBe(401);
      expect((await call(restarted.admin.origin, "/host/me", token)).status).toBe(401);
    }
    expect((await call(restarted.admin.origin, "/host/login", "", { key })).status).toBe(200);
  } finally {
    await restarted.stop();
  }
  const reopened = new HostStore(new Database(path));
  try {
    expect(
      reopened
        .statement(
          "SELECT auth_method AS method FROM host_sessions WHERE token_hash IN (?,?) ORDER BY auth_method",
        )
        .all(digest(tokens.password), digest(tokens.saml)),
    ).toEqual([{ method: "local-password" }, { method: "saml" }]);
    for (const token of [tokens.password, tokens.saml])
      expect(() => reopened.authenticateAdmin(token, Date.now())).toThrow(
        "Host session expired or invalid.",
      );
  } finally {
    reopened.close();
  }
  expect(retainedRows(path)).toEqual(before);
});
