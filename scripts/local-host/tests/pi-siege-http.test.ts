import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CompetitionEngine } from "../competition-engine";
import { assertCoordinationRoster, coordinationCatalog } from "../coordination-runtime";
import { type HttpHost, startHttpHost } from "../http";
import { HostingService } from "../service";
import { HostStore } from "../store";

interface Seat {
  teamId: string;
  teamLoginKey: string;
}
interface View {
  revision: number;
  round: number;
  turn: string;
  me: { id: string; score: number; tickets: number; previews: { id: string }[] };
  claims: { id: string; author: string }[];
}
interface Body {
  idToken: string;
  eventId: string;
  teams: Seat[];
  projection: View;
  error?: string;
  entries: { teamId: string; score: number }[];
}
const root = fileURLToPath(new URL("../../../", import.meta.url));

test("two-seat Battle admission rejects incompatible rosters and state budgets before credentials", () => {
  for (const id of ["pi-siege", "session-defense"]) {
    const problem = coordinationCatalog(root).find((p) => p.problemId === id);
    if (!problem) throw new Error("Two-seat Battle absent from reviewed native catalog");
    for (const n of [1, 3, 40])
      expect(() => assertCoordinationRoster([problem], n)).toThrow("exactly 2 teams");
    expect(() => assertCoordinationRoster([problem], 2)).not.toThrow();
    const definition = JSON.parse(problem.definition);
    definition.metadata.interTeamCoordination.stateBudget.bytesPerTeam = 2 * 1024 * 1024;
    expect(() =>
      assertCoordinationRoster([{ ...problem, definition: JSON.stringify(definition) }], 2),
    ).toThrow("state budget");
  }
});

test("native Pi Siege HTTP authenticates seats, preserves negative official scores and restarts SQLite", async () => {
  const data = mkdtempSync(join(tmpdir(), "tenka-pi-http-")),
    database = join(data, "host.sqlite");
  let store = new HostStore(new Database(database));
  const organizerKey = store.ensureLocalOrganizerKey().key;
  if (!organizerKey) throw new Error("Fresh organizer key absent");
  let service = new HostingService(
    store,
    new CompetitionEngine(root, data, false),
    "fixture-organizer-key",
  );
  let adminHost: HttpHost | undefined,
    portal: HttpHost | undefined,
    admin = "";
  async function attach() {
    adminHost = await startHttpHost({
      kind: "admin",
      hostname: "127.0.0.1",
      port: 0,
      staticRoot: data,
      service,
    });
    portal = await startHttpHost({
      kind: "participant",
      hostname: "127.0.0.1",
      port: 0,
      staticRoot: data,
      service,
    });
    const login = await api("admin", "/host/login", "POST", { key: organizerKey });
    expect(login.status).toBe(200);
    admin = login.body.idToken;
  }
  async function api(
    role: "admin" | "participant",
    path: string,
    method = "GET",
    body?: unknown,
    key?: string,
    nonce?: string,
  ) {
    const host = role === "admin" ? adminHost : portal;
    if (!host) throw new Error("Fixture host absent");
    const response = await fetch(`${host.origin}/api${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key ?? (role === "admin" ? admin : "")}`,
        ...(nonce ? { "idempotency-key": nonce } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Body };
  }
  async function view(seat: Seat) {
    const r = await api(
      "participant",
      "/portal/me/coordination/projection",
      "GET",
      undefined,
      seat.teamLoginKey,
    );
    expect(r.status).toBe(200);
    return r.body.projection;
  }
  async function move(seat: Seat, payload: Record<string, unknown>, nonce?: string) {
    const p = await view(seat),
      op = { ...payload, requestId: `pi_${p.revision}`, revision: p.revision, round: p.round };
    const r = await api(
      "participant",
      "/portal/me/coordination/op",
      "POST",
      { op },
      seat.teamLoginKey,
      nonce,
    );
    expect(r.status).toBe(200);
    return { op, response: r };
  }
  try {
    await attach();
    for (const n of [1, 3]) {
      const r = await api("admin", "/events", "POST", {
        name: "bad roster",
        teams: Array.from({ length: n }, (_, i) => ({ internalSlug: `team-${i}` })),
        problems: [{ problemId: "pi-siege" }],
      });
      expect(r.status).toBe(422);
      expect(store.events()).toHaveLength(0);
    }
    const made = await api("admin", "/events", "POST", {
      name: "Pi native",
      teams: [{ internalSlug: "alpha" }, { internalSlug: "bravo" }],
      problems: [{ problemId: "pi-siege" }],
    });
    expect(made.status).toBe(201);
    const event = made.body;
    const seat = event.teams[0];
    if (!seat) throw new Error("First seat absent");
    expect((await api("admin", `/events/${event.eventId}/deploy`, "POST", {})).status).toBe(202);
    await service.drain();
    expect(store.jobs(event.eventId).every((j) => j.status === "COMPLETE")).toBe(true);
    expect((await api("participant", "/portal/me/coordination/projection")).status).toBe(401);
    expect(
      (
        await api(
          "participant",
          "/portal/me/coordination/op",
          "POST",
          { op: { kind: "ready" } },
          seat.teamLoginKey,
        )
      ).status,
    ).toBe(422);
    expect(
      (await api("admin", `/events/${event.eventId}/schedule`, "PATCH", { startNow: true })).status,
    ).toBe(200);
    const initial = await view(seat),
      a = event.teams.find((t) => t.teamId === initial.turn),
      b = event.teams.find((t) => t.teamId !== initial.turn);
    if (!a || !b) throw new Error("Two seats absent");
    await move(a, { kind: "ready" });
    await move(b, { kind: "ready" });
    expect(store.teams(event.eventId).every((t) => t.score === 0)).toBe(true);
    await move(a, { kind: "inspect", task: { kind: "record", p: 22, q: 7 } });
    expect((await view(b)).me.previews).toHaveLength(0);
    await move(b, { kind: "inspect", task: { kind: "record", p: 3, q: 1 } });
    await move(a, {
      kind: "publish",
      sourceId: (await view(a)).me.previews[0]?.id,
      scope: "forever",
    });
    const target = (await view(b)).claims[0]?.id;
    const scored = await move(
      b,
      { kind: "audit", claimId: target, reason: "scope" },
      "pi-native-audit-retry",
    );
    expect(store.team(a.teamId).score).toBe(-3);
    expect(store.team(b.teamId).score).toBe(4);
    const board = await api("participant", "/portal/leaderboard", "GET", undefined, b.teamLoginKey);
    expect(board.body.entries.find((t) => t.teamId === a.teamId)?.score).toBe(-3);
    expect(board.body.entries.find((t) => t.teamId === b.teamId)?.score).toBe(4);
    expect(store.team(b.teamId).scoreEvents).toHaveLength(1);
    expect(
      (
        await api(
          "participant",
          "/portal/me/coordination/op",
          "POST",
          { teamId: b.teamId, op: scored.op },
          a.teamLoginKey,
        )
      ).status,
    ).toBe(400);
    const before = await view(b);
    await adminHost?.close();
    await portal?.close();
    await service.drain();
    service.flush();
    store.close();
    store = new HostStore(new Database(database));
    service = new HostingService(
      store,
      new CompetitionEngine(root, data, false),
      "fixture-organizer-key",
    );
    await service.recover();
    await attach();
    expect(await view(b)).toEqual(before);
    const retry = await api(
      "participant",
      "/portal/me/coordination/op",
      "POST",
      { op: scored.op },
      b.teamLoginKey,
      "pi-native-audit-retry",
    );
    expect(retry.status).toBe(200);
    expect(retry.body.projection).toEqual(scored.response.body.projection);
    expect(store.team(b.teamId).scoreEvents).toHaveLength(1);
    expect(store.team(a.teamId).score).toBe(-3);
    const malformed = await api(
      "participant",
      "/portal/me/coordination/op",
      "POST",
      { op: { ...scored.op, reason: "wrong" } },
      b.teamLoginKey,
      "pi-native-audit-retry",
    );
    expect(malformed.status).toBe(409);
    expect((await api("admin", `/events/${event.eventId}/lock-scoring`, "POST", {})).status).toBe(
      200,
    );
    const locked = await api(
      "participant",
      "/portal/me/coordination/op",
      "POST",
      { op: { kind: "pass", requestId: "locked", revision: before.revision, round: before.round } },
      a.teamLoginKey,
    );
    expect(locked.status).toBe(422);
    expect(locked.body.error).toBe("scoring_locked");
  } finally {
    await adminHost?.close();
    await portal?.close();
    await service.drain();
    service.flush();
    store.close();
    rmSync(data, { recursive: true, force: true });
  }
}, 30_000);
