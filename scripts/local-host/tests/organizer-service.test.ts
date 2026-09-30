import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { apiRequest } from "../bench/state-setup";
import type { RuntimeEngine } from "../model";
import { type ApiResponse, HostingService } from "../service";
import { HostStore } from "../store";

const KEY = "local-host-secret";
// eslint-disable-next-line sonarjs/no-hardcoded-passwords -- These credentials exist only in an in-memory test database.
const FIRST_PASSWORD = "correct horse battery staple";
// eslint-disable-next-line sonarjs/no-hardcoded-passwords -- This test user cannot access an external service.
const VIEWER_PASSWORD = "reader password long enough";
// eslint-disable-next-line sonarjs/no-hardcoded-passwords -- This test user cannot access an external service.
const SECOND_PASSWORD = "another secure password";
const NOW = Date.parse("2026-09-30T00:00:00.000Z");
const unavailable = async (): Promise<never> => {
  throw new Error("Exercise runtime was called during organizer authentication.");
};
const engine: RuntimeEngine = {
  catalog: () => [],
  start: unavailable,
  recover: unavailable,
  stop: unavailable,
  pause: unavailable,
  resume: unavailable,
  view: unavailable,
  submit: unavailable,
  hint: unavailable,
  surface: () => {
    throw new Error("Exercise surface was called during organizer authentication.");
  },
};

function sessionToken(response: ApiResponse): string {
  if (
    typeof response.body !== "object" ||
    response.body === null ||
    !("idToken" in response.body) ||
    typeof response.body.idToken !== "string"
  )
    throw new Error("Response did not contain an id token.");
  return response.body.idToken;
}

function fixture() {
  const store = new HostStore(new Database(":memory:"));
  const service = new HostingService(store, engine, KEY, () => NOW);
  const call = (
    method: string,
    path: string,
    token = "",
    body: unknown = {},
    query = new URLSearchParams(),
  ) => service.admin(apiRequest({ method, path, token, body, query }));
  return { store, call };
}

test("bootstrap revokes the host key, and organizer roles control API access", async () => {
  const { store, call } = fixture();
  try {
    expect((await call("GET", "/host/bootstrap-status")).body).toEqual({
      bootstrapCompleted: false,
    });
    await expect(call("POST", "/host/login", "", { key: KEY })).rejects.toMatchObject({
      status: 409,
      kind: "bootstrap_required",
    });
    store.addSession("legacy-host-key", "legacy-refresh", NOW + 60_000, NOW);
    await expect(call("GET", "/events", "legacy-host-key")).rejects.toMatchObject({
      status: 401,
    });
    await expect(
      call("POST", "/host/bootstrap", "", {
        key: "wrong",
        username: "admin",
        password: FIRST_PASSWORD,
      }),
    ).rejects.toMatchObject({ status: 401 });
    const admin = sessionToken(
      await call("POST", "/host/bootstrap", "", {
        key: KEY,
        username: "admin",
        password: FIRST_PASSWORD,
      }),
    );
    expect((await call("GET", "/host/bootstrap-status")).body).toEqual({
      bootstrapCompleted: true,
    });
    await expect(call("GET", "/events", "legacy-host-key")).rejects.toMatchObject({
      status: 401,
    });
    await expect(call("POST", "/host/login", "", { key: KEY })).rejects.toMatchObject({
      status: 401,
    });
    await expect(
      call("POST", "/host/bootstrap", "", {
        key: KEY,
        username: "second",
        password: FIRST_PASSWORD,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(store.organizers().map(({ username }) => username)).toEqual(["admin"]);

    const created = await call("POST", "/host/users", admin, {
      username: "reader",
      password: VIEWER_PASSWORD,
      role: "Viewer",
    });
    expect(created.status).toBe(201);
    expect(JSON.stringify((await call("GET", "/host/users", admin)).body)).not.toContain(
      "passwordHash",
    );
    const viewer = sessionToken(
      await call("POST", "/host/login", "", {
        username: "reader",
        password: VIEWER_PASSWORD,
      }),
    );
    expect((await call("GET", "/events", viewer)).body).toEqual({ items: [] });
    expect((await call("GET", "/feature-flags", viewer)).body).toEqual({
      flags: {
        saml: false,
        audit: false,
        challengePrerequisiteGate: false,
        registration: false,
      },
    });
    await expect(call("POST", "/events", viewer)).rejects.toMatchObject({ status: 403 });
    await expect(call("GET", "/host/users", viewer)).rejects.toMatchObject({ status: 403 });
    const eventId = "01K6F7MNN00000000000000000";
    await expect(
      call("GET", `/events/${eventId}`, viewer, {}, new URLSearchParams("withTeamLoginKeys=true")),
    ).rejects.toMatchObject({ status: 403 });

    const reader = store.organizerByUsername("reader");
    if (!reader) throw new Error("Reader was not stored.");
    expect(
      (await call("PATCH", `/host/users/${reader.id}`, admin, { role: "Operator" })).status,
    ).toBe(200);
    await expect(call("GET", "/events", viewer)).rejects.toMatchObject({ status: 401 });
    const operator = sessionToken(
      await call("POST", "/host/login", "", {
        username: "reader",
        password: VIEWER_PASSWORD,
      }),
    );
    await expect(
      call(
        "GET",
        `/events/${eventId}`,
        operator,
        {},
        new URLSearchParams("withTeamLoginKeys=true"),
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(call("POST", "/events", operator)).rejects.toMatchObject({ status: 400 });
    await expect(
      call("PUT", "/feature-flags", operator, { key: "audit", enabled: true }),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      (await call("PUT", "/feature-flags", admin, { key: "audit", enabled: true })).body,
    ).toEqual({
      flags: {
        saml: false,
        audit: true,
        challengePrerequisiteGate: false,
        registration: false,
      },
    });

    const identity = store.localIdentity(reader.id);
    if (!identity) throw new Error("Reader identity was not stored.");
    store.database.prepare("DELETE FROM host_organizer_identities WHERE id=?").run(identity.id);
    await expect(call("GET", "/events", operator)).rejects.toMatchObject({ status: 401 });
    await expect(
      call("POST", "/host/login", "", {
        username: "reader",
        password: VIEWER_PASSWORD,
      }),
    ).rejects.toMatchObject({ status: 401 });
  } finally {
    store.close();
  }
});

test("the last active local-password Admin survives disable, demotion, and deletion", async () => {
  const { store, call } = fixture();
  try {
    const admin = sessionToken(
      await call("POST", "/host/bootstrap", "", {
        key: KEY,
        username: "admin",
        password: FIRST_PASSWORD,
      }),
    );
    const first = store.organizerByUsername("admin");
    if (!first) throw new Error("Bootstrap Admin was not stored.");
    for (const change of [{ role: "Viewer" }, { status: "disabled" }]) {
      await expect(call("PATCH", `/host/users/${first.id}`, admin, change)).rejects.toMatchObject({
        status: 409,
      });
    }
    await expect(call("DELETE", `/host/users/${first.id}`, admin)).rejects.toMatchObject({
      status: 409,
    });
    expect(store.organizer(first.id)).toMatchObject({ role: "Admin", status: "active" });
    expect(store.bootstrapCompleted()).toBe(true);
    expect((await call("GET", "/host/me", admin)).body).toMatchObject({
      role: "Admin",
      authMethod: "local-password",
    });

    const second = await call("POST", "/host/users", admin, {
      username: "second",
      password: SECOND_PASSWORD,
      role: "Admin",
    });
    expect(second.status).toBe(201);
    expect((await call("PATCH", `/host/users/${first.id}`, admin, { role: "Viewer" })).status).toBe(
      200,
    );
    await expect(call("GET", "/host/users", admin)).rejects.toMatchObject({ status: 401 });
    const secondToken = sessionToken(
      await call("POST", "/host/login", "", {
        username: "second",
        password: SECOND_PASSWORD,
      }),
    );
    expect((await call("GET", "/host/users", secondToken)).body).toMatchObject({
      items: [
        { username: "admin", role: "Viewer" },
        { username: "second", role: "Admin" },
      ],
    });
  } finally {
    store.close();
  }
});
