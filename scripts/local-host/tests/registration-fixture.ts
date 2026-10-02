import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostBuildDirectory } from "../build";
import { CompetitionEngine } from "../competition-engine";
import { type HttpHost, startHttpHost } from "../http";
import { HostingService } from "../service";
import { HostStore } from "../store";
import { createTemporaryDirectory, removeTemporaryDirectory } from "../temporary-directory";

const root = fileURLToPath(new URL("../../../", import.meta.url));
export const REGISTRATION_ORGANIZER = {
  username: "registration-admin",
  // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- Test-only account in a fresh local host data directory.
  password: "Registration-admin-test-only-2026!",
} as const;
export interface RegistrationEvent {
  eventId: string;
  teams: { teamId: string; teamLoginKey: string }[];
}
export interface RegistrationSummary {
  tenantId: string;
  enabled: boolean;
  featureEnabled: boolean;
  canConfigure: boolean;
  teamIds: string[];
  claimed: number;
  invitation?: string;
}
/** Real Battle runtime, real HTTP listeners and a durable SQLite file; no external services. */
export async function registrationFixture(options: { browser?: boolean } = {}) {
  const directory = createTemporaryDirectory(root, "tenka-registration-");
  const database = join(directory, "host.sqlite");
  const masterKey = "test-only-registration-signing-key";
  let clock = Date.now();
  let store = new HostStore(new Database(database));
  // Browser journeys use key auth; legacy unit role cases keep account auth.
  const organizerKey = options.browser ? store.ensureLocalOrganizerKey().key : undefined;
  const hostKey = organizerKey ?? masterKey;
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
      staticRoot: options.browser
        ? (process.env.HOST_E2E_PARTICIPANT_BUILD ?? hostBuildDirectory(root, "participant-portal"))
        : directory,
      service,
      log: (error) => errors.push(error),
    });
    admin = await startHttpHost({
      kind: "admin",
      hostname: "127.0.0.1",
      port: 0,
      staticRoot: options.browser
        ? (process.env.HOST_E2E_ADMIN_BUILD ??
          hostBuildDirectory(root, "application-admin-console"))
        : directory,
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
      organizerKey
        ? { key: organizerKey }
        : { ...REGISTRATION_ORGANIZER, ...(firstVisit ? { key: masterKey } : {}) },
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
    hostKey,
    errors,
    api,
    advance(ms: number) {
      clock += ms;
    },
    async create(count = 2) {
      const made = await api<RegistrationEvent>("admin", "/events", "POST", {
        name: "Registration battle",
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
    flag(enabled: boolean) {
      return api("admin", "/feature-flags", "PUT", { key: "registration", enabled });
    },
    open(event: RegistrationEvent, teamIds = event.teams.map((t) => t.teamId)) {
      return api<RegistrationSummary>("admin", `/events/${event.eventId}/registration`, "PUT", {
        enabled: true,
        teamIds,
        closesAt: new Date(clock + 60_000).toISOString(),
      });
    },
    public<T = Record<string, unknown>>(
      eventId: string,
      action: "info" | "claim" | "status",
      token: string,
      receipt?: string,
    ) {
      return api<T>(
        "participant",
        `/portal/registration/local-host/${eventId}/${action}`,
        "POST",
        receipt ? { receipt } : {},
        token,
      );
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
