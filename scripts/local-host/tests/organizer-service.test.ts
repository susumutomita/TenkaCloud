import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { randomToken } from "../auth";
import { apiRequest } from "../bench/state-setup";
import type { RuntimeEngine } from "../model";
import { type ApiResponse, HostingService } from "../service";
import { digest, HostStore } from "../store";

const KEY = "local-host-secret";
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

test("without an organizer key no credential signs in, and the signing key is not one", async () => {
  const { store, call } = fixture();
  try {
    for (const body of [
      { key: KEY },
      { key: randomToken() },
      { username: "admin", password: randomToken() },
    ])
      await expect(call("POST", "/host/login", "", body)).rejects.toMatchObject({ status: 401 });
    expect(() => {
      store.addSession("issued-without-key", randomToken(), NOW + 60_000, NOW, 1);
    }).toThrow("Host authentication changed. Sign in again.");
    store.database
      .prepare(
        "INSERT INTO host_sessions(token_hash,refresh_hash,auth_method,auth_version,issued_at,last_seen,expires) VALUES (?,?,'host-key',0,?,?,?)",
      )
      .run(digest("stored-host-key"), digest(randomToken()), NOW, NOW, NOW + 60_000);
    await expect(call("GET", "/events", "stored-host-key")).rejects.toMatchObject({
      status: 401,
    });
  } finally {
    store.close();
  }
});

test("an organizer-key session is Admin and the flag API accepts only retained flags", async () => {
  const { store, call } = fixture();
  try {
    const { key } = store.ensureLocalOrganizerKey();
    const admin = sessionToken(await call("POST", "/host/login", "", { key }));
    expect((await call("GET", "/host/me", admin)).body).toEqual({
      user: null,
      role: "Admin",
      authMethod: "host-key",
    });
    expect((await call("GET", "/events", admin)).body).toEqual({ items: [] });
    await expect(
      call(
        "GET",
        "/events/01K6F7MNN00000000000000000",
        admin,
        {},
        new URLSearchParams("withTeamLoginKeys=true"),
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(call("POST", "/events", admin)).rejects.toMatchObject({ status: 400 });
    for (const key of ["audit", "saml"])
      await expect(
        call("PUT", "/feature-flags", admin, { key, enabled: true }),
      ).rejects.toMatchObject({ status: 400 });
    expect(
      (
        await call("PUT", "/feature-flags", admin, {
          key: "challengePrerequisiteGate",
          enabled: true,
        })
      ).body,
    ).toEqual({ flags: { audit: false, challengePrerequisiteGate: true } });
  } finally {
    store.close();
  }
});
