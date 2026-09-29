import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CompetitionEngine } from "../competition-engine";
import { type HttpHost, startHttpHost } from "../http";
import { HostingService } from "../service";
import { HostStore } from "../store";

const root = fileURLToPath(new URL("../../../", import.meta.url));
interface EventResult {
  eventId: string;
  teams: { teamId: string; teamLoginKey: string }[];
}
interface LedgerPair {
  kind: string;
  teamId: string;
  generation: number;
  rung: string;
  plaintext: number[];
  ciphertext: number[];
}
interface Projection {
  ready: { count: number };
  myContracts: { id: string; allowedMethods: string[] }[];
  vault: unknown;
  publicLedger: LedgerPair[];
}

test("real HTTP/SQLite crypto competition: login, scoring, event isolation, resume and lock", async () => {
  const data = mkdtempSync(join(tmpdir(), "tenka-crypto-http-"));
  const database = join(data, "host.sqlite");
  let clock = Date.parse("2026-09-27T00:00:00Z");
  let store = new HostStore(new Database(database));
  let service = new HostingService(
    store,
    new CompetitionEngine(root, data),
    "test-only-host-key",
    () => clock,
  );
  let host: HttpHost | undefined;
  let portal: HttpHost | undefined;
  let admin = "";
  async function attach() {
    host = await startHttpHost({
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
    const login = await api("admin", "/host/login", "POST", { key: "test-only-host-key" });
    admin = login.body.idToken as string;
  }
  async function api(
    role: "admin" | "participant",
    path: string,
    method = "GET",
    body?: unknown,
    key?: string,
    nonce?: string,
  ) {
    const response = await fetch(
      `${role === "admin" ? required(host).origin : required(portal).origin}/api${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${key ?? (role === "admin" ? admin : "")}`,
          "content-type": "application/json",
          ...(nonce ? { "idempotency-key": nonce } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    return {
      status: response.status,
      body: (await response.json()) as {
        idToken: string;
        projection: Projection;
        entries: { teamId: string; rank: number; score: number }[];
        problems: { score: number; stackOutputs: unknown; instructions: string }[];
        error?: string;
      },
    };
  }
  async function create(name: string): Promise<EventResult> {
    const made = await api("admin", "/events", "POST", {
      name,
      teams: [{ internalSlug: "alpha" }, { internalSlug: "beta" }],
      problems: [{ problemId: "ac26-crypto-battle" }],
    });
    expect(made.status).toBe(201);
    return made.body as unknown as EventResult;
  }
  async function deploy(event: EventResult) {
    expect((await api("admin", `/events/${event.eventId}/deploy`, "POST", {})).status).toBe(202);
    await service.drain();
    expect(store.event(event.eventId).status).toBe("READY");
  }
  async function op(key: string, value: unknown, nonce?: string) {
    return api("participant", "/portal/me/coordination/op", "POST", { op: value }, key, nonce);
  }
  try {
    await attach();
    // The only configured gateway is occupied by this test's portal listener.
    // A Battle still deploys: it has no exercise URL or gateway allocation.
    const occupiedPort = Number(new URL(required(portal).origin).port);
    service.gatewayPorts = { start: occupiedPort, end: occupiedPort };
    const event = await create("crypto local"),
      unrelated = await create("other match");
    await deploy(event);
    await deploy(unrelated);
    expect(store.jobs().every((job) => job.offset === 0)).toBe(true);
    const [a, b] = event.teams;
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    const beforeStart = await op(required(a).teamLoginKey, { kind: "ready" });
    expect(beforeStart.status).toBe(422);
    expect(beforeStart.body.error).toBe("event_ended");
    expect((await api("participant", "/portal/me/coordination/projection")).status).toBe(401);
    await api("admin", `/events/${event.eventId}/schedule`, "PATCH", { startNow: true });
    const one = await op(required(a).teamLoginKey, { kind: "ready" });
    expect((one.body.projection as Projection).ready.count).toBe(1);
    expect((one.body.projection as Projection).myContracts).toHaveLength(0);
    await op(required(b).teamLoginKey, { kind: "ready" });
    clock += 1;
    const view = await api(
      "participant",
      "/portal/me/coordination/projection",
      "GET",
      undefined,
      required(a).teamLoginKey,
    );
    const order = (view.body.projection as Projection).myContracts.find((item) =>
      item.allowedMethods.includes("leak"),
    );
    expect(order).toBeDefined();
    const [first, repeat] = await Promise.all([
      op(
        required(a).teamLoginKey,
        { kind: "leak", contractId: required(order).id },
        "same-request-123",
      ),
      op(
        required(a).teamLoginKey,
        { kind: "leak", contractId: required(order).id },
        "same-request-123",
      ),
    ]);
    expect(first.status).toBe(200);
    expect(repeat.body).toEqual(first.body);
    const points = store.team(required(a).teamId).score;
    expect(points).toBeGreaterThan(0);
    expect(store.team(required(a).teamId).scoreEvents).toHaveLength(1);
    const board = await api(
      "participant",
      "/portal/leaderboard",
      "GET",
      undefined,
      required(b).teamLoginKey,
    );
    expect(board.body.entries[0]).toMatchObject({
      teamId: required(a).teamId,
      rank: 1,
      score: points,
    });
    const me = await api("participant", "/portal/me", "GET", undefined, required(a).teamLoginKey);
    expect(required(me.body.problems[0]).score).toBe(points);
    expect(required(me.body.problems[0]).stackOutputs).toEqual({});
    expect(required(me.body.problems[0]).instructions).not.toContain("アクセス先 URL");
    expect(
      (
        await api(
          "participant",
          "/portal/me/coordination/op",
          "POST",
          { teamId: required(b).teamId, op: { kind: "ready" } },
          required(a).teamLoginKey,
        )
      ).status,
    ).toBe(400);
    const unstartedLeak = await op(required(unrelated.teams[0]).teamLoginKey, {
      kind: "leak",
      contractId: required(order).id,
    });
    expect(unstartedLeak.status).toBe(422);
    expect(unstartedLeak.body.error).toBe("event_ended");
    expect(store.team(required(unrelated.teams[0]).teamId).score).toBe(0);
    const raw = required(store.coordination(event.eventId, "ac26-crypto-battle"));
    expect(JSON.stringify(me.body)).not.toContain(JSON.parse(raw).matchSecret);
    await required(host).close();
    await required(portal).close();
    await service.drain();
    service.flush();
    store.close();
    store = new HostStore(new Database(database));
    service = new HostingService(
      store,
      new CompetitionEngine(root, data),
      "test-only-host-key",
      () => clock,
    );
    await service.recover();
    await attach();
    const restored = await api(
      "participant",
      "/portal/me/coordination/projection",
      "GET",
      undefined,
      required(a).teamLoginKey,
    );
    expect(restored.body.projection).toEqual(first.body.projection);
    expect(store.team(required(a).teamId).score).toBe(points);
    clock += 40_000;
    const betaOrders = await api(
      "participant",
      "/portal/me/coordination/projection",
      "GET",
      undefined,
      required(b).teamLoginKey,
    );
    const cipher = betaOrders.body.projection.myContracts.find(
      (item) => item.allowedMethods.includes("cipher") && item.allowedMethods.includes("leak"),
    );
    expect(cipher).toBeDefined();
    expect(
      (await op(required(b).teamLoginKey, { kind: "leak", contractId: required(cipher).id }))
        .status,
    ).toBe(200);
    const evidence = await api(
      "participant",
      "/portal/me/coordination/projection",
      "GET",
      undefined,
      required(a).teamLoginKey,
    );
    const pair = evidence.body.projection.publicLedger.find(
      (item) => item.kind === "cipher-pair" && item.teamId === required(b).teamId,
    );
    expect(pair).toBeDefined();
    const publicPair = required(pair);
    const key = (required(publicPair.ciphertext[0]) - required(publicPair.plaintext[0]) + 6) % 6;
    const hunt = await op(required(a).teamLoginKey, {
      kind: "hunt-cipher",
      targetTeamId: required(b).teamId,
      generation: required(pair).generation,
      rung: required(pair).rung,
      recoveredKey: key,
    });
    expect(hunt.status).toBe(200);
    expect(store.team(required(a).teamId).score).toBeGreaterThan(points);
    const scored = await api(
      "participant",
      "/portal/leaderboard",
      "GET",
      undefined,
      required(a).teamLoginKey,
    );
    expect(
      required(scored.body.entries.find((item) => item.teamId === required(a).teamId)).score,
    ).toBe(store.team(required(a).teamId).score);
    expect(
      (await api("admin", `/events/${event.eventId}/schedule`, "PATCH", { startNow: true })).status,
    ).toBe(409);
    const job = required(store.jobs(event.eventId, required(a).teamId)[0]);
    const betaScore = store.team(required(b).teamId).score;
    const alphaScore = store.team(required(a).teamId).score;
    const savedMatch = store.coordination(event.eventId, "ac26-crypto-battle");
    expect(
      (await api("admin", `/events/${event.eventId}/deployments/${job.jobId}/stop`, "POST", {}))
        .status,
    ).toBe(202);
    await service.drain();
    expect((await op(required(a).teamLoginKey, { kind: "ready" })).status).toBe(409);
    expect(
      (await api("admin", `/events/${event.eventId}/deployments/${job.jobId}/restart`, "POST", {}))
        .status,
    ).toBe(202);
    await service.drain();
    expect(store.coordination(event.eventId, "ac26-crypto-battle")).toBe(savedMatch);
    expect(store.team(required(a).teamId).score).toBe(alphaScore);
    expect(store.team(required(b).teamId).score).toBe(betaScore);
    await api("admin", `/events/${event.eventId}/lock-scoring`, "POST", {});
    const duringLock = await op(required(a).teamLoginKey, { kind: "ready" });
    expect(duringLock.status).toBe(422);
    expect(duringLock.body.error).toBe("scoring_locked");
    const beforeLock = store.coordination(event.eventId, "ac26-crypto-battle");
    clock += 300_000;
    // Repeated lock requests must not reset the start of the paused interval.
    await api("admin", `/events/${event.eventId}/lock-scoring`, "POST", {});
    await api("participant", "/portal/leaderboard", "GET", undefined, required(b).teamLoginKey);
    expect(store.coordination(event.eventId, "ac26-crypto-battle")).toBe(beforeLock);
    const before = JSON.parse(required(beforeLock)) as {
      state: { nowMs: number };
      scores: unknown;
    };
    await api("admin", `/events/${event.eventId}/lock-scoring`, "DELETE");
    await api("participant", "/portal/leaderboard", "GET", undefined, required(b).teamLoginKey);
    const resumed = JSON.parse(required(store.coordination(event.eventId, "ac26-crypto-battle")));
    expect(resumed.state.nowMs).toBe(before.state.nowMs);
    expect(resumed.scores).toEqual(before.scores);
    expect(store.event(event.eventId).coordinationPausedMs).toBe(300_000);
    expect(
      (
        await api("admin", `/events/${event.eventId}/schedule`, "PATCH", {
          endsAt: new Date(clock - 1000).toISOString(),
        })
      ).status,
    ).toBe(409);
    // Teardown must process the pending deadline without relying on another poll.
    clock += 300_000;
    expect((await api("admin", `/events/${event.eventId}`, "DELETE")).status).toBe(202);
    await service.drain();
    const final = JSON.parse(required(store.coordination(event.eventId, "ac26-crypto-battle")));
    expect(final.state.nowMs).toBe(before.state.nowMs + 300_000);
    expect(final.scores[required(a).teamId]).toBeLessThan(alphaScore);
    expect(store.team(required(a).teamId).score).toBe(final.scores[required(a).teamId]);
    const ended = store.coordination(event.eventId, "ac26-crypto-battle");
    clock += 300_000;
    await api("participant", "/portal/leaderboard", "GET", undefined, required(b).teamLoginKey);
    expect(store.coordination(event.eventId, "ac26-crypto-battle")).toBe(ended);
    // The simulated long match exceeded the host's 15-minute login lifetime.
    admin = (await api("admin", "/host/login", "POST", { key: "test-only-host-key" })).body.idToken;
    // An event that ends while locked must not acquire retroactive penalties on unlock.
    const peer = required(unrelated.teams[0]);
    await api("admin", `/events/${unrelated.eventId}/schedule`, "PATCH", { startNow: true });
    for (const team of unrelated.teams) await op(team.teamLoginKey, { kind: "ready" });
    clock += 1;
    await api("admin", `/events/${unrelated.eventId}/lock-scoring`, "POST", {});
    const frozen = JSON.parse(
      required(store.coordination(unrelated.eventId, "ac26-crypto-battle")),
    );
    await api("admin", `/events/${unrelated.eventId}/schedule`, "PATCH", {
      endsAt: new Date(clock + 1000).toISOString(),
    });
    clock += 300_000;
    await api("participant", "/portal/leaderboard", "GET", undefined, peer.teamLoginKey);
    expect(store.event(unrelated.eventId).status).toBe("ENDED");
    expect((await api("admin", `/events/${unrelated.eventId}/lock-scoring`, "DELETE")).status).toBe(
      200,
    );
    await api("participant", "/portal/leaderboard", "GET", undefined, peer.teamLoginKey);
    const unfreezed = JSON.parse(
      required(store.coordination(unrelated.eventId, "ac26-crypto-battle")),
    );
    expect(unfreezed.state).toEqual(frozen.state);
    expect(unfreezed.scores).toEqual(frozen.scores);
    expect(store.event(unrelated.eventId).coordinationPausedMs).toBe(1000);
    const beforeEndedOp = store.coordination(unrelated.eventId, "ac26-crypto-battle");
    const endedOp = await op(peer.teamLoginKey, { kind: "ready" });
    expect(endedOp.status).toBe(422);
    expect(endedOp.body.error).toBe("event_ended");
    expect(store.coordination(unrelated.eventId, "ac26-crypto-battle")).toBe(beforeEndedOp);
  } finally {
    await host?.close();
    await portal?.close();
    await service.drain();
    store.close();
    rmSync(data, { recursive: true, force: true });
  }
}, 30_000);

function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("Expected a present test value.");
  return value;
}
