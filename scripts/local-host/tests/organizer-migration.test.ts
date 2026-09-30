import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { HostStore } from "../store";

test("fresh SQLite creates organizer tables with bootstrap and flags off", () => {
  const db = new Database(":memory:");
  const store = new HostStore(db);
  expect(db.query("SELECT version FROM host_schema").get()).toEqual({ version: 5 });
  expect(store.bootstrapCompleted()).toBe(false);
  expect(store.featureFlags()).toEqual({ saml: false, audit: false });
  expect(store.organizers()).toEqual([]);
  store.close();
});

for (const version of [1, 2] as const) {
  test(`v${version} migration keeps events and accounts while revoking old sessions`, () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE host_schema(version INTEGER NOT NULL) STRICT;
      CREATE TABLE host_events(id TEXT PRIMARY KEY,body TEXT NOT NULL) STRICT;
      INSERT INTO host_events VALUES ('event-1','{"eventId":"event-1","name":"preserved"}');
      CREATE TABLE host_sessions(token_hash TEXT PRIMARY KEY,refresh_hash TEXT NOT NULL,expires INTEGER NOT NULL) STRICT;
      INSERT INTO host_sessions VALUES ('old-token','old-refresh',100);
    `);
    db.prepare("INSERT INTO host_schema VALUES (?)").run(version);
    if (version === 2)
      db.exec(`
      CREATE TABLE host_accounts(account_id TEXT PRIMARY KEY,body TEXT NOT NULL) STRICT;
      INSERT INTO host_accounts VALUES ('account-1','{"accountId":"account-1"}');
    `);
    const store = new HostStore(db);
    expect(db.query("SELECT version FROM host_schema").get()).toEqual({ version: 5 });
    expect(db.query("SELECT body FROM host_events WHERE id='event-1'").get()).toEqual({
      body: '{"eventId":"event-1","name":"preserved"}',
    });
    if (version === 2)
      expect(db.query("SELECT body FROM host_accounts WHERE account_id='account-1'").get()).toEqual(
        { body: '{"accountId":"account-1"}' },
      );
    expect(db.query("SELECT count(*) AS count FROM host_sessions").get()).toEqual({ count: 0 });
    expect(store.bootstrapCompleted()).toBe(false);
    expect(store.organizers()).toEqual([]);
    store.close();
  });
}

function v3Database(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE host_schema(version INTEGER NOT NULL) STRICT;
    INSERT INTO host_schema VALUES (3);
    CREATE TABLE host_organizer_users(
      id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, role TEXT NOT NULL,
      status TEXT NOT NULL, auth_version INTEGER NOT NULL,
      password_hash TEXT NOT NULL, created_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE host_organizer_identities(
      issuer TEXT NOT NULL, subject TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES host_organizer_users(id),
      PRIMARY KEY(issuer,subject), UNIQUE(issuer,user_id)
    ) STRICT;
    CREATE TABLE host_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
    INSERT INTO host_settings VALUES ('bootstrap_completed','true');
    CREATE TABLE host_sessions(token_hash TEXT PRIMARY KEY,refresh_hash TEXT NOT NULL,
      user_id TEXT,auth_method TEXT NOT NULL,auth_version INTEGER NOT NULL,
      issued_at INTEGER NOT NULL,last_seen INTEGER NOT NULL,expires INTEGER NOT NULL) STRICT;
    INSERT INTO host_sessions VALUES ('old-token','old-refresh','user-1','local-password',1,1,1,100);
    CREATE TABLE host_events(id TEXT PRIMARY KEY,body TEXT NOT NULL) STRICT;
    INSERT INTO host_events VALUES ('event-1','{"eventId":"event-1","name":"preserved"}');
    CREATE TABLE host_accounts(account_id TEXT PRIMARY KEY,body TEXT NOT NULL) STRICT;
    INSERT INTO host_accounts VALUES ('account-1','{"accountId":"account-1"}');
  `);
  return db;
}

test("v3 identities migrate to stable provider IDs while credentials and records survive", async () => {
  const db = v3Database();
  const hash = await Bun.password.hash("correct horse battery staple", { algorithm: "argon2id" });
  db.prepare(
    "INSERT INTO host_organizer_users VALUES ('user-1','admin','Admin','active',1,?,1)",
  ).run(hash);
  db.exec("INSERT INTO host_organizer_identities VALUES ('local','admin','user-1')");
  const store = new HostStore(db);
  expect(db.query("SELECT version FROM host_schema").get()).toEqual({ version: 5 });
  expect(store.bootstrapCompleted()).toBe(true);
  expect(store.localIdentity("user-1")).toMatchObject({
    provider: "local-password",
    issuer: "local-host",
    subject: "admin",
    userId: "user-1",
  });
  expect(
    await Bun.password.verify(
      "correct horse battery staple",
      store.organizerByUsername("admin")?.passwordHash ?? "",
    ),
  ).toBe(true);
  expect(db.query("SELECT count(*) AS count FROM host_sessions").get()).toEqual({ count: 0 });
  expect(db.query("SELECT body FROM host_events WHERE id='event-1'").get()).toEqual({
    body: '{"eventId":"event-1","name":"preserved"}',
  });
  expect(db.query("SELECT body FROM host_accounts WHERE account_id='account-1'").get()).toEqual({
    body: '{"accountId":"account-1"}',
  });
  store.close();
});

test("a failed identity migration rolls back version, identities, and sessions", () => {
  const db = v3Database();
  db.exec(`
    INSERT INTO host_organizer_users VALUES ('user-1','admin','Admin','active',1,'hash',1);
    INSERT INTO host_organizer_users VALUES ('user-2','other','Admin','active',1,'hash',1);
    INSERT INTO host_organizer_identities VALUES ('local','admin','user-1');
    INSERT INTO host_organizer_identities VALUES ('local-host','admin','user-2');
  `);
  expect(() => new HostStore(db)).toThrow();
  expect(db.query("SELECT version FROM host_schema").get()).toEqual({ version: 3 });
  expect(db.query("SELECT count(*) AS count FROM host_sessions").get()).toEqual({ count: 1 });
  expect(db.query("SELECT count(*) AS count FROM host_organizer_identities").get()).toEqual({
    count: 2,
  });
  db.close();
});
