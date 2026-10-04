import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CompetitionEngine } from "../competition-engine";
import { type HttpHost, startHttpHost } from "../http";
import { HostingService } from "../service";
import { HostStore } from "../store";
import { createTemporaryDirectory, removeTemporaryDirectory } from "../temporary-directory";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const ACCESS_ORGANIZER = {
  username: "access-admin",
  // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- Test-only account in a fresh local host data directory.
  password: "Access-admin-test-only-2026!",
} as const;
interface AccessEvent {
  eventId: string;
  teams: { teamId: string; teamLoginKey: string }[];
}
/** Real Battle runtime, real HTTP listeners and a durable SQLite file; no external services. */
export async function participantAccessFixture() {
  const directory = createTemporaryDirectory(root, "tenka-participant-access-");
  const database = join(directory, "host.sqlite");
  const masterKey = "test-only-access-signing-key";
  const clock = Date.now();
  let store = new HostStore(new Database(database));
  let service = new HostingService(
    store,
    new CompetitionEngine(root, directory),
    masterKey,
    () => clock,
  );
  let admin: HttpHost;
  let participant: HttpHost;
  let adminToken = "";
  const errors: unknown[] = [];
  async function api<T = Record<string, unknown>>(
    role: "admin" | "participant",
    path: string,
    method = "GET",
    body?: unknown,
    token?: string,
  ) {
    const origin = role === "admin" ? admin.origin : participant.origin;
    const response = await fetch(`${origin}/api${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token ?? (role === "admin" ? adminToken : "")}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as T };
  }
  async function attach() {
    participant = await startHttpHost({
      kind: "participant",
      hostname: "127.0.0.1",
      port: 0,
      staticRoot: directory,
      service,
      log: (error) => errors.push(error),
    });
    admin = await startHttpHost({
      kind: "admin",
      hostname: "127.0.0.1",
      port: 0,
      staticRoot: directory,
      service,
      log: (error) => errors.push(error),
      participantOrigin: participant.origin,
    });
    const state = await api<{ bootstrapCompleted: boolean }>("admin", "/host/bootstrap-status");
    assert.equal(state.status, 200);
    const firstVisit = !state.body.bootstrapCompleted;
    const login = await api<{ idToken: string }>(
      "admin",
      firstVisit ? "/host/bootstrap" : "/host/login",
      "POST",
      { ...ACCESS_ORGANIZER, ...(firstVisit ? { key: masterKey } : {}) },
    );
    assert.equal(login.status, firstVisit ? 201 : 200);
    adminToken = login.body.idToken;
  }
  async function detach() {
    await admin.close();
    await participant.close();
    await service.drain();
    service.flush();
    store.close();
  }
  await attach();
  return {
    get store() {
      return store;
    },
    get service() {
      return service;
    },
    get admin() {
      return admin.origin;
    },
    get participant() {
      return participant.origin;
    },
    get now() {
      return clock;
    },
    errors,
    api,
    async create(count = 2) {
      const made = await api<AccessEvent>("admin", "/events", "POST", {
        name: "Participant access battle",
        teams: Array.from({ length: count }, (_, i) => ({ internalSlug: `team-${i + 1}` })),
        problems: [{ problemId: "ac26-crypto-battle" }],
      });
      assert.equal(made.status, 201);
      const deployed = await api("admin", `/events/${made.body.eventId}/deploy`, "POST", {});
      assert.equal(deployed.status, 202);
      await service.drain();
      assert.equal(store.event(made.body.eventId).status, "READY");
      return made.body;
    },
    async restart() {
      await detach();
      store = new HostStore(new Database(database));
      service = new HostingService(
        store,
        new CompetitionEngine(root, directory),
        masterKey,
        () => clock,
      );
      await service.recover();
      await attach();
    },
    async close() {
      await detach();
      removeTemporaryDirectory(root, directory);
    },
  };
}
