import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { issueLocalOrganizerSession, issueOrganizerSession, randomToken } from "../auth";
import { apiRequest } from "../bench/state-setup";
import { HostError } from "../model";
import { startLocalHost } from "../server";
import { HostingService } from "../service";
import { digest, HostStore } from "../store";
import { ExerciseFixture } from "./exercise-fixture";
import { bootstrapOrganizer, TEST_ORGANIZER_PASSWORD } from "./organizer-fixture";

const sessionSchema = z.object({
  idToken: z.string(),
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number(),
});
const root = fileURLToPath(new URL("../../../", import.meta.url));

// Report only a status, even if a regression unexpectedly returns a credential-bearing response.
function rejectedStatus(result: Promise<unknown>): Promise<number> {
  return result.then(
    () => 200,
    (error: unknown) => (error instanceof HostError ? error.status : 500),
  );
}

function fixture(path = ":memory:") {
  const store = new HostStore(new Database(path));
  const signingKey = randomToken();
  let now = Date.now();
  const engine = new ExerciseFixture((database) => new Database(database));
  const service = new HostingService(store, engine, signingKey, () => now);
  const call = (method: string, path: string, body: unknown = {}, token = "") =>
    service.admin(apiRequest({ method, path, body, token }));
  const login = async (key: string) =>
    sessionSchema.parse((await call("POST", "/host/login", { key })).body);
  return {
    store,
    service,
    signingKey,
    engine,
    call,
    login,
    advance(milliseconds: number) {
      now += milliseconds;
    },
  };
}

function enable(store: HostStore): string {
  const { key } = store.ensureLocalOrganizerKey();
  if (!key) throw new Error("Fixture key was already enabled.");
  return key;
}

test("key-only login uses a separate hashed key and disables account and SAML routes", async () => {
  const f = fixture();
  try {
    const key = enable(f.store);
    expect(key === f.signingKey).toBe(false);
    expect(/^[A-Za-z0-9_-]{43}$/u.test(key)).toBe(true);
    expect((await f.call("GET", "/host/bootstrap-status")).body).toEqual({
      bootstrapCompleted: true,
      authMode: "host-key",
    });
    expect(f.store.organizers()).toEqual([]);
    const session = await f.login(key);
    expect(session.idToken === session.accessToken).toBe(true);
    expect((await f.call("GET", "/host/me", {}, session.idToken)).body).toEqual({
      user: null,
      role: "Admin",
      authMethod: "host-key",
    });
    const claims = JSON.parse(
      Buffer.from(session.idToken.split(".")[1] ?? "", "base64url").toString(),
    );
    expect(claims["custom:organizerRole"]).toBe("Admin");
    expect("email" in claims).toBe(false);
    for (const body of [
      { key: f.signingKey },
      { key: randomToken() },
      { username: "admin", password: TEST_ORGANIZER_PASSWORD },
      { key, username: "admin" },
    ])
      expect(await rejectedStatus(f.call("POST", "/host/login", body))).toBe(401);
    for (const [method, path] of [
      ["POST", "/host/bootstrap"],
      ["GET", "/host/users"],
      ["POST", "/host/users"],
      ["PATCH", "/host/users/01K6F7MNN00000000000000000"],
      ["POST", "/host/saml/start"],
      ["POST", "/host/saml/complete"],
      ["GET", "/host/saml/provider"],
      ["PUT", "/host/saml/provider"],
    ] as const)
      expect(await rejectedStatus(f.call(method, path, {}, session.idToken))).toBe(404);
    expect((await f.call("GET", "/host/saml")).body).toEqual({ enabled: false });
    expect(
      await rejectedStatus(
        f.call("PUT", "/feature-flags", { key: "saml", enabled: true }, session.idToken),
      ),
    ).toBe(404);
    expect(
      (await f.call("PUT", "/feature-flags", { key: "audit", enabled: true }, session.idToken))
        .status,
    ).toBe(200);
    const second = await f.login(key);
    const audit = f.service.audit.list(new URLSearchParams({ principal: "host-key" }));
    expect(audit.items.some((record) => record.action === "organizer.login")).toBe(true);
    expect(audit.items.every((record) => record.authMethod === "host-key")).toBe(true);
    const rows = JSON.stringify(f.store.statement("SELECT * FROM host_settings").all());
    expect(rows.includes(key)).toBe(false);
    expect(rows.includes(digest(key))).toBe(true);
    expect(JSON.stringify(audit).includes(key)).toBe(false);
    await f.call("POST", "/host/logout", { refreshToken: second.refreshToken });
    expect(await rejectedStatus(f.call("GET", "/events", {}, second.idToken))).toBe(401);
    expect((await f.call("GET", "/events", {}, session.idToken)).status).toBe(200);
  } finally {
    f.store.close();
  }
});

test("migration and rotation retain participants, event progress and historical organizer records", async () => {
  const f = fixture();
  try {
    const oldToken = await bootstrapOrganizer(f.service, f.signingKey);
    const created = await f.call(
      "POST",
      "/events",
      {
        name: "Key migration retention",
        teams: [{ internalSlug: "alpha" }],
        problems: [{ problemId: "sqli-demo" }],
      },
      oldToken,
    );
    const eventId = z.object({ eventId: z.string() }).parse(created.body).eventId;
    const team = f.store.teams(eventId)[0];
    if (!team) throw new Error("Fixture event had no team.");
    team.score = 70;
    team.completedProblems = 1;
    team.snapshot = JSON.stringify({ solved: true });
    f.store.putTeam(team);
    f.store.putCoordination(eventId, "sqli-demo", JSON.stringify({ turn: 4 }));
    f.store.putUptimeState(eventId, team.teamId, "sqli-demo", { revision: 7 });
    f.store.putReceipt(team.teamId, "nonce", "fingerprint", 200, { accepted: true });
    f.store.setFeatureFlag("saml", true);
    const historical = f.store.organizers();
    const before = {
      event: f.store.event(eventId),
      team: f.store.team(team.teamId),
      coordination: f.store.coordination(eventId, "sqli-demo"),
      uptime: f.store.uptimeState(eventId, team.teamId, "sqli-demo"),
      receipt: f.store.receipt(team.teamId, "nonce", "fingerprint"),
    };
    const key = enable(f.store);
    expect(await rejectedStatus(f.call("GET", "/events", {}, oldToken))).toBe(401);
    const oldSession = await f.login(key);
    const oldVersion = f.store.verifyLocalOrganizerKey(key);
    const oldSessionRow = f.store
      .statement("SELECT * FROM host_sessions WHERE token_hash=?")
      .get(digest(oldSession.idToken)) as Record<string, string | number | null>;
    const nextKey = f.store.rotateLocalOrganizerKey();
    expect(nextKey === key).toBe(false);
    expect(() => f.store.verifyLocalOrganizerKey(key)).toThrow();
    expect(await rejectedStatus(f.call("GET", "/events", {}, oldSession.idToken))).toBe(401);
    expect(() => {
      issueLocalOrganizerSession(f.store, f.signingKey, Date.now(), oldVersion);
    }).toThrow();
    f.store
      .statement("INSERT INTO host_sessions VALUES (?,?,?,?,?,?,?,?,?)")
      .run(
        oldSessionRow.token_hash ?? null,
        oldSessionRow.refresh_hash ?? null,
        oldSessionRow.user_id ?? null,
        oldSessionRow.identity_id ?? null,
        oldSessionRow.auth_method ?? null,
        oldSessionRow.auth_version ?? null,
        oldSessionRow.issued_at ?? null,
        oldSessionRow.last_seen ?? null,
        oldSessionRow.expires ?? null,
      );
    expect(await rejectedStatus(f.call("GET", "/events", {}, oldSession.idToken))).toBe(401);
    const user = f.store.organizerByUsername("fixture-admin");
    const identity = user ? f.store.localIdentity(user.id) : undefined;
    if (!user || !identity) throw new Error("Historical organizer was lost.");
    expect(() => {
      issueOrganizerSession(f.store, f.signingKey, user, Date.now(), identity);
    }).toThrow();
    expect(f.store.organizers()).toEqual(historical);
    expect(f.store.featureFlags().saml).toBe(false);
    const retained = {
      event: f.store.event(eventId),
      team: f.store.authenticateTeam(team.loginKey),
      coordination: f.store.coordination(eventId, "sqli-demo"),
      uptime: f.store.uptimeState(eventId, team.teamId, "sqli-demo"),
      receipt: f.store.receipt(team.teamId, "nonce", "fingerprint"),
    };
    expect(JSON.stringify(retained) === JSON.stringify(before)).toBe(true);
    const current = await f.login(nextKey);
    expect((await f.call("GET", "/events", {}, current.idToken)).status).toBe(200);
  } finally {
    f.store.close();
  }
});

test("key state and sessions survive restart without retaining the login key", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tenka-organizer-key-"));
  const path = join(directory, "host.sqlite");
  const first = fixture(path);
  let reopened: HostStore | undefined;
  try {
    const key = enable(first.store);
    const session = await first.login(key);
    first.store.close();
    expect(readFileSync(path).includes(Buffer.from(key))).toBe(false);
    reopened = new HostStore(new Database(path));
    expect(Object.keys(reopened.ensureLocalOrganizerKey()).length).toBe(0);
    expect(reopened.verifyLocalOrganizerKey(key)).toBe(1);
    expect(reopened.authenticateAdmin(session.idToken, Date.now()).authMethod).toBe("host-key");
    reopened.rotateLocalOrganizerKey();
    expect(() => reopened?.authenticateAdmin(session.idToken, Date.now())).toThrow();
  } finally {
    first.store.close();
    reopened?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rotation rolls back the key and sessions together on a storage failure", async () => {
  const f = fixture();
  try {
    const key = enable(f.store);
    const session = await f.login(key);
    f.store.database.exec(
      "CREATE TRIGGER refuse_revoke BEFORE DELETE ON host_sessions BEGIN SELECT RAISE(ABORT, 'fixture refusal'); END",
    );
    expect(() => {
      f.store.rotateLocalOrganizerKey();
    }).toThrow("fixture refusal");
    expect(f.store.verifyLocalOrganizerKey(key)).toBe(1);
    expect(f.store.authenticateAdmin(session.idToken, Date.now()).authMethod).toBe("host-key");
  } finally {
    f.store.close();
  }
});

test.each(["invalid-json", JSON.stringify({ hash: "invalid", version: 1 })])(
  "malformed persisted organizer key state fails closed without replacing it: %s",
  (value) => {
    const f = fixture();
    try {
      f.store.statement("INSERT INTO host_settings VALUES ('local_organizer_key',?)").run(value);
      expect(() => {
        f.store.ensureLocalOrganizerKey();
      }).toThrow("Invalid local organizer key state.");
      expect(() => {
        f.store.rotateLocalOrganizerKey();
      }).toThrow("Invalid local organizer key state.");
      expect(
        f.store.statement("SELECT value FROM host_settings WHERE key='local_organizer_key'").get(),
      ).toEqual({ value });
    } finally {
      f.store.close();
    }
  },
);

test("password verification already in flight cannot mint a session after migration", async () => {
  const f = fixture();
  await bootstrapOrganizer(f.service, f.signingKey);
  const original = Bun.password.verify;
  const reached = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const verifier = spyOn(Bun.password, "verify").mockImplementation(async (...args) => {
    const valid = await original(...args);
    reached.resolve(undefined);
    await release.promise;
    return valid;
  });
  try {
    const pending = f.call("POST", "/host/login", {
      username: "fixture-admin",
      password: TEST_ORGANIZER_PASSWORD,
    });
    await reached.promise;
    enable(f.store);
    f.store.rotateLocalOrganizerKey();
    release.resolve(undefined);
    expect(await rejectedStatus(pending)).toBe(401);
    expect(f.store.statement("SELECT count(*) AS count FROM host_sessions").get()).toEqual({
      count: 0,
    });
  } finally {
    release.resolve(undefined);
    verifier.mockRestore();
    f.store.close();
  }
});

test("host-key sessions enforce idle and absolute expiry", async () => {
  const f = fixture();
  try {
    const key = enable(f.store);
    const idle = await f.login(key);
    f.advance(15 * 60_000);
    expect(await rejectedStatus(f.call("GET", "/events", {}, idle.idToken))).toBe(401);
    const absolute = await f.login(key);
    for (let minute = 10; minute < 8 * 60; minute += 10) {
      f.advance(10 * 60_000);
      expect((await f.call("GET", "/events", {}, absolute.idToken)).status).toBe(200);
    }
    f.advance(10 * 60_000);
    expect(await rejectedStatus(f.call("GET", "/events", {}, absolute.idToken))).toBe(401);
  } finally {
    f.store.close();
  }
});

test("legacy bootstrap already hashing a password cannot create an organizer after migration", async () => {
  const f = fixture();
  try {
    const pending = f.call("POST", "/host/bootstrap", {
      key: f.signingKey,
      username: "late-admin",
      password: TEST_ORGANIZER_PASSWORD,
    });
    enable(f.store);
    expect(await rejectedStatus(pending)).toBe(409);
    expect(f.store.organizers()).toEqual([]);
    expect(f.store.statement("SELECT count(*) AS count FROM host_sessions").get()).toEqual({
      count: 0,
    });
  } finally {
    f.store.close();
  }
});

test("production startup always enables key-only HTTP login and live rotation leaves listeners up", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tenka-key-http-"));
  const messages: string[] = [];
  const engine = new ExerciseFixture((path) => new Database(path));
  const host = await startLocalHost(
    root,
    {
      dataDirectory: directory,
      hostname: "127.0.0.1",
      adminPort: 0,
      participantPort: 0,
      gatewayPorts: { start: 58000, end: 58039 },
    },
    () => engine,
    (message) => messages.push(message),
  );
  try {
    const key = host.organizerKey;
    if (!key) throw new Error("New local host did not issue an organizer key.");
    const api = async (path: string, method = "GET", body?: unknown, token = "") => {
      const response = await fetch(`${host.admin.origin}/api${path}`, {
        method,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    expect((await api("/host/bootstrap-status")).body).toMatchObject({ authMode: "host-key" });
    const session = sessionSchema.parse((await api("/host/login", "POST", { key })).body);
    for (const [method, path] of [
      ["GET", "/host/saml/metadata"],
      ["POST", "/host/saml/acs"],
    ] as const)
      expect((await api(path, method)).status).toBe(404);
    const next = host.rotateOrganizerKey();
    expect((await api("/events", "GET", undefined, session.idToken)).status).toBe(401);
    expect((await api("/host/login", "POST", { key })).status).toBe(401);
    expect((await api("/host/login", "POST", { key: next })).status).toBe(200);
    expect((await fetch(`${host.participant.origin}/healthz`)).status).toBe(200);
    expect(engine.stops).toEqual([]);
    expect(messages.join("\n").includes(key)).toBe(false);
    expect(messages.join("\n").includes(next)).toBe(false);
  } finally {
    await host.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
