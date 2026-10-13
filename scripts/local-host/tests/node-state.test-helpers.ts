import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseGatewayPorts } from "../gateway-ports";
import { localDatabaseOpener } from "../local-database";
import { startLocalHost } from "../server";
import { HostStore } from "../store";
import { ExerciseFixture } from "./exercise-fixture";

const directory = process.argv[2];
assert.ok(directory);
const input: unknown = JSON.parse(readFileSync(0, "utf8"));
assert.ok(input && typeof input === "object" && "key" in input && typeof input.key === "string");
const key = input.key;
const openDatabase = await localDatabaseOpener();
const fixture = new ExerciseFixture(openDatabase);
const settings = {
  dataDirectory: directory,
  hostname: "127.0.0.1",
  adminPort: 0,
  participantPort: 0,
  gatewayPorts: parseGatewayPorts("6100-6139"),
};
let host = await startLocalHost(
  process.cwd(),
  settings,
  () => fixture,
  () => undefined,
);
async function api(path: string, method: string, token = "", body?: unknown) {
  const response = await fetch(`${host.admin.origin}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}
let eventId: string;
let token: string;
try {
  assert.equal(host.organizerKey, undefined, "Existing organizer key must not be replaced.");
  const login = await api("/host/login", "POST", "", { key });
  assert.equal(login.status, 200);
  assert.equal(typeof login.body.idToken, "string");
  token = String(login.body.idToken);
  const created = await api("/events", "POST", token, {
    name: "Node persistent event",
    teams: [{ internalSlug: "node-team-a" }, { internalSlug: "node-team-b" }],
    problems: [{ problemId: "sqli-demo", defaultRegion: "local" }],
  });
  assert.equal(created.status, 201);
  eventId = String(created.body.eventId);
  assert.equal((await api(`/events/${eventId}`, "GET", "invalid")).status, 401);
  assert.equal(
    (
      await fetch(`${host.admin.origin}/api/portal/me`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).status,
    404,
  );
} finally {
  await host.stop();
}
host = await startLocalHost(
  process.cwd(),
  settings,
  () => fixture,
  () => undefined,
);
try {
  const result = await api(`/events/${eventId}`, "GET", token);
  assert.equal(
    result.status,
    200,
    "Existing session and event must survive the same Node host restart.",
  );
  assert.equal(result.body.name, "Node persistent event");
} finally {
  await host.stop();
  await fixture.close();
}
const state = new HostStore(openDatabase(join(directory, "hosting.sqlite")));
try {
  assert.equal(state.teams(eventId).length, 2);
  assert.ok(state.organizerByUsername("preserved-admin")?.passwordHash.startsWith("$argon2id$"));
} finally {
  state.close();
}
console.log(
  "Node local host: existing key, real SQLite, API/auth/role denial and durable restart PASS",
);
