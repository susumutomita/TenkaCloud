import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { issueOrganizerSession, randomToken } from "../auth";
import { SamlSignIn } from "../saml-sign-in";
import { HostStore, type OrganizerUser } from "../store";
import { TestSamlIdP } from "./saml-idp-fixture";

const origin = "http://127.0.0.1:24680";
const key = "test-only-master-key-for-organizer-signing";
let idp: TestSamlIdP;
beforeAll(() => {
  idp = new TestSamlIdP();
});
afterAll(() => idp?.close());
function user(username: string, role: OrganizerUser["role"]): OrganizerUser {
  return {
    id: randomUUID(),
    username,
    role,
    status: "active",
    authVersion: 1,
    passwordHash: Bun.password.hashSync(randomToken(), { algorithm: "argon2id" }),
    createdAt: Date.now(),
  };
}
function setup(path = ":memory:") {
  const store = new HostStore(new Database(path));
  const admin = user("local-admin", "Admin");
  const viewer = user("viewer", "Viewer");
  const identity = store.bootstrap(admin);
  const localSession = issueOrganizerSession(store, key, admin, Date.now(), identity);
  store.insertOrganizer(viewer);
  let now = Date.now();
  const saml = new SamlSignIn(store, key, () => now);
  saml.bindOrigin(origin);
  saml.configure({
    issuer: idp.issuer,
    entryPoint: "https://idp.example.test/login",
    certificate: idp.certificate,
  });
  const enable = () => store.setFeatureFlag("saml", true);
  const link = () => saml.link({ userId: viewer.id, subject: "stable-subject-123" });
  const off = () =>
    store.transaction(() => {
      store.setFeatureFlag("saml", false);
      saml.invalidate();
    });
  return {
    store,
    admin,
    viewer,
    saml,
    localSession,
    enable,
    link,
    off,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
async function response(saml: SamlSignIn, browserProof = randomToken()) {
  const start = await saml.start({ browserProof });
  const request = idp.request(start.url);
  const encoded = idp.response({ ...request, assertionId: `_${randomUUID()}` });
  return { browserProof, encoded, relay: request.relay };
}
async function receipt(saml: SamlSignIn) {
  const assertion = await response(saml);
  return {
    browserProof: assertion.browserProof,
    ticket: await saml.consume(assertion.encoded, assertion.relay),
  };
}

test("SAML defaults off and a configured provider cannot bypass the flag", async () => {
  const f = setup();
  try {
    expect(f.saml.available()).toBe(false);
    expect(() => f.saml.metadata()).toThrow();
    await expect(f.saml.start({ browserProof: randomToken() })).rejects.toMatchObject({
      status: 404,
    });
    f.enable();
    expect(f.saml.available()).toBe(true);
    expect(f.saml.metadata()).toContain(`${origin}/api/host/saml/acs`);
  } finally {
    f.store.close();
  }
});

test("only explicit persistent identity links can sign in", async () => {
  const f = setup();
  try {
    f.enable();
    const unlinked = await response(f.saml);
    await expect(f.saml.consume(unlinked.encoded, unlinked.relay)).rejects.toMatchObject({
      status: 401,
    });
    expect(f.store.organizers()).toHaveLength(2);
    f.link();
    const tokens = f.saml.complete(await receipt(f.saml));
    expect(f.store.authenticateAdmin(tokens.idToken, Date.now())).toMatchObject({
      userId: f.viewer.id,
      role: "Viewer",
      authMethod: "saml",
    });
    expect(f.store.featureFlags().audit).toBe(false);
  } finally {
    f.store.close();
  }
});

test("a browser proof is required and both response and receipt are one use", async () => {
  const f = setup();
  try {
    f.enable();
    f.link();
    const assertion = await response(f.saml);
    const ticket = await f.saml.consume(assertion.encoded, assertion.relay);
    expect(() => f.saml.complete({ ticket, browserProof: randomToken() })).toThrow();
    const tokens = f.saml.complete({ ticket, browserProof: assertion.browserProof });
    expect(f.store.authenticateAdmin(tokens.idToken, Date.now()).userId).toBe(f.viewer.id);
    expect(() => f.saml.complete({ ticket, browserProof: assertion.browserProof })).toThrow();
    await expect(f.saml.consume(assertion.encoded, assertion.relay)).rejects.toMatchObject({
      status: 401,
    });
  } finally {
    f.store.close();
  }
});

test("concurrent ACS requests accept an assertion once", async () => {
  const f = setup();
  try {
    f.enable();
    f.link();
    const assertion = await response(f.saml);
    const attempts = await Promise.allSettled([
      f.saml.consume(assertion.encoded, assertion.relay),
      f.saml.consume(assertion.encoded, assertion.relay),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
  } finally {
    f.store.close();
  }
});

test("pending response and receipt survive restart with durable replay protection", async () => {
  const path = join(idp.directory, `${randomUUID()}.sqlite`);
  const f = setup(path);
  f.enable();
  f.link();
  const assertion = await response(f.saml);
  f.store.close();
  const second = new HostStore(new Database(path));
  const resumed = new SamlSignIn(second, key, Date.now);
  resumed.bindOrigin(origin);
  const ticket = await resumed.consume(assertion.encoded, assertion.relay);
  second.close();
  const third = new HostStore(new Database(path));
  try {
    const final = new SamlSignIn(third, key, Date.now);
    final.bindOrigin(origin);
    const tokens = final.complete({ ticket, browserProof: assertion.browserProof });
    expect(third.authenticateAdmin(tokens.idToken, Date.now()).userId).toBe(f.viewer.id);
    await expect(final.consume(assertion.encoded, assertion.relay)).rejects.toMatchObject({
      status: 401,
    });
    expect(() => final.complete({ ticket, browserProof: assertion.browserProof })).toThrow();
  } finally {
    third.close();
  }
});

test("turning SAML off revokes sessions, pending responses and receipts without revoking local login", async () => {
  const f = setup();
  try {
    f.enable();
    f.link();
    const tokens = f.saml.complete(await receipt(f.saml));
    const pending = await response(f.saml);
    const ready = await receipt(f.saml);
    f.off();
    expect(() => f.store.authenticateAdmin(tokens.idToken, Date.now())).toThrow();
    expect(f.store.authenticateAdmin(f.localSession.idToken, Date.now()).authMethod).toBe(
      "local-password",
    );
    f.enable();
    expect(() => f.store.authenticateAdmin(tokens.idToken, Date.now())).toThrow();
    expect(() => f.saml.complete(ready)).toThrow();
    await expect(f.saml.consume(pending.encoded, pending.relay)).rejects.toMatchObject({
      status: 401,
    });
  } finally {
    f.store.close();
  }
});

test("provider changes and identity unlinking invalidate already verified receipts", async () => {
  const f = setup();
  try {
    f.enable();
    f.link();
    const first = await receipt(f.saml);
    f.saml.configure({
      issuer: idp.issuer,
      entryPoint: "https://idp.example.test/new-login",
      certificate: idp.certificate,
    });
    expect(() => f.saml.complete(first)).toThrow();
    const second = await receipt(f.saml);
    const identity = f.saml.identities()[0];
    if (!identity) throw new Error("Missing test identity");
    f.saml.unlink(identity.id);
    f.link();
    expect(() => f.saml.complete(second)).toThrow();
  } finally {
    f.store.close();
  }
});

for (const update of ["role", "status", "password"] as const) {
  test(`a ${update} change between verification and session issue invalidates the receipt`, async () => {
    const f = setup();
    try {
      f.enable();
      f.link();
      const ready = await receipt(f.saml);
      const updated = { ...f.viewer };
      if (update === "role") updated.role = "Operator";
      if (update === "status") updated.status = "disabled";
      if (update === "password")
        updated.passwordHash = Bun.password.hashSync(randomToken(), { algorithm: "argon2id" });
      f.store.updateOrganizer(updated);
      expect(() => f.saml.complete(ready)).toThrow();
    } finally {
      f.store.close();
    }
  });
}

test("expired browser receipts never issue sessions", async () => {
  const f = setup();
  try {
    f.enable();
    f.link();
    const ready = await receipt(f.saml);
    f.advance(60_001);
    expect(() => f.saml.complete(ready)).toThrow();
  } finally {
    f.store.close();
  }
});

test("schema v4 migration preserves local organizer sessions and identities", () => {
  const path = join(idp.directory, `${randomUUID()}.sqlite`);
  const f = setup(path);
  const identity = f.store.localIdentity(f.admin.id);
  f.store.database.exec(`CREATE TABLE host_sessions_v4 (
    token_hash TEXT PRIMARY KEY, refresh_hash TEXT NOT NULL UNIQUE,
    user_id TEXT REFERENCES host_organizer_users(id) ON DELETE CASCADE,
    identity_id TEXT REFERENCES host_organizer_identities(id) ON DELETE CASCADE,
    auth_method TEXT NOT NULL, auth_version INTEGER NOT NULL,
    issued_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, expires INTEGER NOT NULL,
    CHECK(auth_method IN ('host-key','local-password'))
  ) STRICT`);
  f.store.statement("INSERT INTO host_sessions_v4 SELECT * FROM host_sessions").run();
  f.store.database.exec(
    "DROP TABLE host_sessions; ALTER TABLE host_sessions_v4 RENAME TO host_sessions; UPDATE host_schema SET version=4;",
  );
  expect(() =>
    f.store
      .statement(
        "INSERT INTO host_sessions VALUES ('forbidden','forbidden',NULL,NULL,'saml',0,0,0,1)",
      )
      .run(),
  ).toThrow();
  f.store.close();
  const reopened = new HostStore(new Database(path));
  try {
    expect(reopened.authenticateAdmin(f.localSession.idToken, Date.now()).userId).toBe(f.admin.id);
    expect(reopened.localIdentity(f.admin.id)).toEqual(identity);
    expect(reopened.bootstrapCompleted()).toBe(true);
    expect(reopened.statement("SELECT version FROM host_schema").get()).toEqual({
      version: 5,
    });
  } finally {
    reopened.close();
  }
});
