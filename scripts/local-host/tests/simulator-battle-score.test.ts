import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { PassThrough } from "node:stream";
import type { directWebTransport } from "../direct-web-transport";
import { ownedBattleEndpoints } from "../simulator-battle-endpoints";
import { SimulatorBattleProbeJournal } from "../simulator-battle-probe-journal";
import { SimulatorBattleProbeStore } from "../simulator-battle-probe-store";
import { createBattleRegistrationCommit } from "../simulator-battle-registration-commit";
import { SimulatorBattleRegistrationStore } from "../simulator-battle-registration-store";
import { runBattleUptimeMinute } from "../simulator-battle-uptime";
import { simulatorBattleUptimeTarget } from "../simulator-battle-uptime-target";
import { receiveOwnedSimulatorClock } from "../simulator-clock-bootstrap";
import { HostStore } from "../store";
import { descriptor, scope, seed, snapshot } from "./simulator-battle-journal-fixture";

async function fixture(path = ":memory:", endpoint = "http://127.0.0.1:1234") {
  const host = new HostStore(new Database(path));
  const job = seed(host);
  const d = descriptor(job, undefined, undefined, endpoint);
  const descriptors = [d];
  const secret = "f".repeat(64);
  const domain = d.deadline.domain;
  const pipe = new PassThrough();
  const receiving = receiveOwnedSimulatorClock(pipe);
  pipe.end(
    `${JSON.stringify({ version: 2, domain, key: secret, clock: "linux-clock-monotonic" })}\n`,
  );
  const clock = await receiving;
  const store = new SimulatorBattleProbeStore(host, scope);
  const controller = new AbortController();
  const state = {
    revision: 0,
    now: 1,
    badSignature: false,
    unknown: false,
    settled: false,
    healthy: false,
    loseStart: false,
    strictRead: false,
    tamperSnapshot: (value: ReturnType<typeof providerSnapshot>) => value,
    after: (_path: string): void => undefined,
  };
  const calls: { path: string; key?: string }[] = [];
  const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const hmac = (prefix: string, bytes: Uint8Array = new Uint8Array()) =>
    createHmac("sha256", Buffer.from(secret, "hex")).update(prefix).update(bytes).digest("hex");
  const responseMac = (prefix: string, body: Uint8Array) =>
    state.badSignature ? "0".repeat(64) : hmac(prefix, body);
  const deadlines = new Map<string, number>();
  const probeReply = (
    input: { service: "frontend" | "api"; key: string; deadline?: { ticksMs: number } },
    path: string,
    selected: typeof d,
  ) => {
    if (path.endsWith("/start") && state.loseStart) throw new Error("start reply lost");
    const identity = `${selected.receipt.handle}/${input.service}/${input.key}`;
    if (path.endsWith("/start") && input.deadline) deadlines.set(identity, input.deadline.ticksMs);
    if (state.unknown || (state.strictRead && !deadlines.has(identity))) return null;
    return {
      ...state.tamperSnapshot(
        providerSnapshot(selected, input.service, input.key, state.settled, state.healthy),
      ),
      deadlineMs: deadlines.get(identity) ?? 8000,
    };
  };
  const transport: typeof directWebTransport = async (url, init) => {
    if (!(init.body instanceof ArrayBuffer)) throw new Error("request bytes required");
    const request = new Uint8Array(init.body);
    const input = JSON.parse(new TextDecoder().decode(request));
    const path = url.pathname;
    calls.push({ path, key: input.key });
    const selected =
      descriptors.find(
        (candidate) =>
          path.includes(candidate.receipt.handle) || input.owner?.teamId === candidate.owner.teamId,
      ) ?? d;
    let value: unknown = selected.receipt;
    if (path.endsWith("/clock"))
      value = {
        version: 2,
        domain,
        nonce: input.nonce,
        ticksMs: 100,
        validUntilMs: 30100,
        mac: hmac(`TCS-CLOCK-2\n${domain}\n${input.nonce}\n100\n30100\n`),
      };
    if (path.endsWith("/start") || path.endsWith("/read"))
      value = probeReply(input, path, selected);
    if (path.endsWith("/seal")) value = { sealed: true, joined: true };
    state.after(path);
    const body = new TextEncoder().encode(JSON.stringify(value));
    const nonce = new Headers(init.headers).get("X-Simulator-Clock-Nonce");
    return new Response(body, {
      headers: {
        "X-Simulator-Clock-Domain": domain,
        "X-Simulator-Clock-MAC": responseMac(
          `TCS-RESPONSE-3\n${domain}\n${nonce}\nPOST\n${path}\n${hash(request)}\n200\n${body.length}\n`,
          body,
        ),
      },
    });
  };
  const context = {
    settings: {
      endpoint,
      region: "ap-northeast-1",
      readToken: () => "operator".repeat(8),
    },
    clock,
    store,
    signal: controller.signal,
    current: () => ({
      target: simulatorBattleUptimeTarget(host.job(job.jobId)),
      revision: state.revision,
    }),
  };
  const journal = () =>
    new SimulatorBattleProbeJournal(context, { transport, now: () => 1, wallNow: () => state.now });
  return {
    host,
    job,
    d,
    store,
    controller,
    state,
    calls,
    journal,
    context,
    transport,
    descriptors,
  };
}

import { scoreSettledBattleMinute } from "../simulator-battle-score";

async function scoringFixture(healthy = true, wallNow?: () => number, endpoint?: string) {
  const f = await fixture(":memory:", endpoint);
  f.state.now = 120001;
  f.job.definition = JSON.stringify({
    kind: "cloudformation",
    problemId: "hello-world-battle",
    scoring: {
      kind: "uptime-flat",
      pointsPerSuccess: 10,
      endpoints: [
        { slot: "frontend", path: "/", expectStatus: [200] },
        { slot: "api", path: "/healthz", expectStatus: [200] },
      ],
    },
  });
  f.host.putJob(f.job);
  const event = f.host.event("event");
  f.host.putEvent({
    ...event,
    startsAt: new Date(1).toISOString(),
    problems: [{ problemId: f.job.problemId, definition: f.job.definition, name: "Battle" }],
  });
  const commit = createBattleRegistrationCommit(f.host, f.d.deadline.domain);
  for (const slot of ["frontend", "api"] as const)
    commit({
      target: simulatorBattleUptimeTarget(f.job),
      expectedRevision: f.state.revision++,
      slot,
      providerDomain: f.d.deadline.domain,
      registeredAt: new Date(1).toISOString(),
    });
  const api = { ...f.d, slot: "api" as const, key: "d".repeat(32) };
  f.store.prepareMinute([f.d, api], { authorizationRevision: 2, minute: 2 });
  for (const d of [f.d, api]) {
    f.store.claimStart(d.key, 0);
    const service = d.receipt.slots[d.slot].service;
    const route = {
      ...d.receipt.slots[d.slot].binding.target,
      localPort: 40000,
      anyPeerPort: false,
    };
    const wireRoute = {
      localIP: route.localIP,
      peerIP: route.peerIP,
      localMAC: route.localMAC,
      peerMAC: route.peerMAC,
      localPort: route.localPort,
      peerPort: route.peerPort,
      anyPeerPort: route.anyPeerPort,
    };
    f.store.saveSnapshot(d.key, 1, {
      ...snapshot(d, true),
      service,
      ...(healthy
        ? {
            route: wireRoute,
            result: {
              observation: {
                route: wireRoute,
                path: service.path,
                status: 200,
                startedAtMs: 101,
                receivedAtMs: 200,
              },
            },
          }
        : {}),
    });
  }
  const score = () =>
    scoreSettledBattleMinute(
      {
        ...f.context,
        host: f.host,
        wallNow: wallNow ?? (() => f.state.now),
        afterCommit: () => undefined,
      },
      2,
      { transport: f.transport, now: () => 1 },
    );
  const tick = () =>
    runBattleUptimeMinute(
      { ...f.context, host: f.host, wallNow: () => f.state.now, afterCommit: () => undefined },
      2,
      { transport: f.transport, now: () => 1 },
    );
  return { ...f, score, tick };
}

test("settled pair scores atomically once without dispatching probes", async () => {
  const f = await scoringFixture();
  try {
    expect((await f.score())?.scoreDelta).toBe(10);
    expect(f.host.team("team").score).toBe(10);
    expect(f.host.team("team").scoreEvents).toHaveLength(1);
    expect(f.host.uptimeObserved("event", "team", "hello-world-battle", 2)).toBe(true);
    await expect(f.score()).rejects.toThrow();
    expect(f.host.team("team").scoreEvents).toHaveLength(1);
    expect(f.calls.some((c) => /\/(start|read)$/.test(c.path))).toBe(false);
  } finally {
    f.host.close();
  }
});

test.each(["revision", "minute", "signature", "registration", "paused"])(
  "rejects %s without score",
  async (kind) => {
    const f = await scoringFixture();
    try {
      if (kind === "revision")
        f.state.after = () => {
          f.state.revision++;
        };
      if (kind === "minute")
        f.state.after = () => {
          f.state.now += 60000;
        };
      if (kind === "signature") f.state.badSignature = true;
      if (kind === "registration")
        f.host.database.exec("DELETE FROM host_simulator_battle_registrations WHERE slot='api'");
      if (kind === "paused") f.host.putEvent({ ...f.host.event("event"), scoringLocked: true });
      await expect(f.score()).rejects.toThrow();
      expect(f.host.team("team").scoreEvents).toHaveLength(0);
      expect(f.host.uptimeObserved("event", "team", "hello-world-battle", 2)).toBe(false);
    } finally {
      f.host.close();
    }
  },
);

test.each(["RAISE(ABORT,'failed')", "RAISE(IGNORE)"])(
  "observation failure rolls back score and state %s",
  async (failure) => {
    const f = await scoringFixture();
    try {
      f.host.database.exec(
        `CREATE TRIGGER fail_score BEFORE INSERT ON host_uptime_observations BEGIN SELECT ${failure}; END;`,
      );
      await expect(f.score()).rejects.toThrow();
      expect(f.host.team("team").scoreEvents).toHaveLength(0);
      expect(f.host.uptimeState("event", "team", "hello-world-battle").generation).toBeUndefined();
    } finally {
      f.host.close();
    }
  },
);

test.each([false, true])(
  "initial failed pair does not score; stale readiness=%s",
  async (stale) => {
    const f = await scoringFixture(false);
    try {
      if (stale)
        f.host.putUptimeState("event", "team", "hello-world-battle", {
          revision: 2,
          generation: "old-generation",
          readyAt: 100,
        });
      expect(await f.score()).toBeUndefined();
      expect(f.host.team("team").scoreEvents).toHaveLength(0);
      expect(f.host.uptimeObserved("event", "team", "hello-world-battle", 2)).toBe(false);
      expect(f.host.uptimeState("event", "team", "hello-world-battle").readyAt).toBeUndefined();
    } finally {
      f.host.close();
    }
  },
);

test("commit uses exactly one checked wall timestamp", async () => {
  let calls = 0;
  const f = await scoringFixture(true, () => (++calls <= 2 ? 179999 : 180000));
  try {
    const result = await f.score();
    expect(calls).toBe(2);
    expect(result?.minute).toBe(2);
    expect(result?.checkedAt).toBe(new Date(179999).toISOString());
  } finally {
    f.host.close();
  }
});
test("commit rejects boundary before its pinned wall timestamp", async () => {
  let calls = 0;
  const f = await scoringFixture(true, () => (++calls === 1 ? 179999 : 180000));
  try {
    await expect(f.score()).rejects.toThrow();
    expect(f.host.team("team").scoreEvents).toHaveLength(0);
  } finally {
    f.host.close();
  }
});

test("owned scheduler consumes settled journal once without new dispatch", async () => {
  const f = await scoringFixture();
  try {
    await f.tick();
    await f.tick();
    expect(f.host.team("team").score).toBe(10);
    expect(f.host.team("team").scoreEvents).toHaveLength(1);
    expect(f.calls.some((c) => /\/(start|read)$/.test(c.path))).toBe(false);
  } finally {
    f.host.close();
  }
});
test("owned scheduler refuses partial registration without provider calls", async () => {
  const f = await scoringFixture();
  try {
    f.host.database.exec("DELETE FROM host_simulator_battle_registrations WHERE slot='api'");
    await f.tick();
    expect(f.host.team("team").scoreEvents).toHaveLength(0);
    expect(f.calls).toHaveLength(0);
  } finally {
    f.host.close();
  }
});

test("fresh scheduler prepares both slots, starts once, then reads same keys", async () => {
  const f = await scoringFixture();
  try {
    f.host.database.exec("DELETE FROM host_simulator_battle_probes");
    await f.tick();
    const starts = f.calls.filter((c) => c.path.endsWith("/start"));
    expect(starts).toHaveLength(2);
    f.state.settled = true;
    await f.tick();
    expect(f.calls.filter((c) => c.path.endsWith("/start"))).toHaveLength(2);
    const reads = f.calls.filter((c) => c.path.endsWith("/read"));
    expect(reads.map((c) => c.key)).toEqual(starts.map((c) => c.key));
    expect(f.host.team("team").scoreEvents).toHaveLength(0);
  } finally {
    f.host.close();
  }
});
test.each(["binding", "key", "service"])(
  "signed wrong %s observation cannot score or settle",
  async (kind) => {
    const f = await scoringFixture();
    try {
      f.host.database.exec("DELETE FROM host_simulator_battle_probes");
      await f.tick();
      f.state.settled = true;
      f.state.healthy = true;
      f.state.tamperSnapshot = (value) => ({
        ...value,
        ...(kind === "binding" ? { binding: { ...value.binding, owner: "9".repeat(64) } } : {}),
        ...(kind === "key" ? { key: "9".repeat(32) } : {}),
        ...(kind === "service"
          ? { service: { ...value.service, path: value.service.path === "/" ? "/healthz" : "/" } }
          : {}),
      });
      await expect(f.tick()).rejects.toThrow();
      expect(f.host.team("team").scoreEvents).toHaveLength(0);
      expect(f.host.uptimeObserved("event", "team", "hello-world-battle", 2)).toBe(false);
      expect(f.store.forMinute("event", "team", "frontend", 2)?.state).toBe("start-uncertain");
      expect(f.calls.filter((c) => c.path.endsWith("/start"))).toHaveLength(2);
    } finally {
      f.host.close();
    }
  },
);

test("expired unclaimed pair is retained as terminal and next minute advances", async () => {
  const f = await scoringFixture();
  try {
    f.host.database.exec("DELETE FROM host_simulator_battle_probes");
    const api = { ...f.d, slot: "api" as const, key: "d".repeat(32) };
    f.store.prepareMinute([f.d, api], { authorizationRevision: 2, minute: 1 });
    await f.tick();
    expect(f.store.get(f.d.key).state).toBe("expired-unstarted");
    const starts = f.calls.filter((c) => c.path.endsWith("/start"));
    expect(starts).toHaveLength(2);
    expect(starts.some((c) => c.key === f.d.key || c.key === api.key)).toBe(false);
    expect(f.store.forMinute("event", "team", "frontend", 1)?.descriptor.key).toBe(f.d.key);
  } finally {
    f.host.close();
  }
});

test("owned endpoint adapter lists safe locators and signed registration updates revision", async () => {
  const f = await scoringFixture();
  try {
    f.host.database.exec("DELETE FROM host_simulator_battle_registrations");
    const context = {
      ...f.context,
      registrations: new SimulatorBattleRegistrationStore(f.host, {
        kind: "owned-battle-registration-scope" as const,
        providerDomain: f.context.clock.domain,
      }),
      commit: createBattleRegistrationCommit(f.host, f.context.clock.domain),
      now: () => f.state.now,
      current: () => ({
        target: simulatorBattleUptimeTarget(f.host.job(f.job.jobId)),
        revision: f.host.uptimeState("event", "team", "hello-world-battle").revision,
      }),
    };
    const view = await ownedBattleEndpoints(context, "GET");
    const registration = view.endpoints[0]?.ownedBattleRegistration;
    expect(registration?.registered).toBe(false);
    expect(JSON.stringify(view)).not.toContain("127.0.0.1");
    await expect(
      ownedBattleEndpoints(context, "POST", "frontend", "http://127.0.0.1"),
    ).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
    const saved = await ownedBattleEndpoints(context, "POST", "frontend", registration?.locator, {
      transport: f.transport,
      now: () => 1,
    });
    expect(saved.endpoints[0]?.ownedBattleRegistration?.registered).toBe(true);
    expect(f.host.uptimeState("event", "team", "hello-world-battle").revision).toBe(3);
    await expect(ownedBattleEndpoints(context, "DELETE", "frontend")).rejects.toThrow(
      "not supported",
    );
  } finally {
    f.host.close();
  }
});

// HTTP boundary integration with a signed fake provider. Native provider launch/VM is not exercised.
test("authenticated HTTP registration isolates teams and feeds the durable scorer", async () => {
  const { HostingService } = await import("../service");
  const { startHttpHost } = await import("../http");
  const { ExerciseFixture } = await import("./exercise-fixture");
  const f = await scoringFixture();
  const other = {
    ...f.host.team("team"),
    teamId: "other",
    internalSlug: "other",
    loginKey: "other",
  };
  f.host.putTeam(other);
  const saved = [f.store.get(f.d.key), f.store.get("d".repeat(32))];
  f.host.database.exec(
    "DELETE FROM host_simulator_battle_registrations; DELETE FROM host_simulator_battle_probes;",
  );
  const service = new HostingService(
    f.host,
    new ExerciseFixture((path) => new Database(path)),
    "fixture-master",
    () => f.state.now,
  );
  service.ownedBattleEndpoints = async (team, _problem, method, slot, value, authenticate) => {
    const current = () => {
      const authorized = authenticate();
      if (authorized.teamId !== "team" || team.teamId !== "team")
        throw new Error("Fixture team has no Battle deployment");
      return {
        target: simulatorBattleUptimeTarget(f.host.job(f.job.jobId)),
        revision: f.host.uptimeState("event", "team", "hello-world-battle").revision,
      };
    };
    return ownedBattleEndpoints(
      {
        ...f.context,
        current,
        registrations: new SimulatorBattleRegistrationStore(f.host, {
          kind: "owned-battle-registration-scope",
          providerDomain: f.context.clock.domain,
        }),
        commit: createBattleRegistrationCommit(f.host, f.context.clock.domain, true),
        now: () => f.state.now,
      },
      method,
      slot,
      value,
      { transport: f.transport, now: () => 1 },
    );
  };
  const listener = await startHttpHost({
    kind: "participant",
    hostname: "127.0.0.1",
    port: 0,
    staticRoot: "/tmp",
    service,
    log: () => undefined,
  });
  const base = `${listener.origin}/api/portal/me/problems/hello-world-battle/endpoints`;
  const request = (token: string, method: string, suffix = "", url?: string) =>
    fetch(base + suffix, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(url ? { body: JSON.stringify({ url }) } : {}),
    });
  try {
    expect((await request("invalid", "GET")).status).toBe(401);
    const response = await request("team", "GET");
    expect(response.status).toBe(200);
    const view = (await response.json()) as {
      endpoints: { slot: string; ownedBattleRegistration: { locator: string } }[];
    };
    for (const ep of view.endpoints)
      expect(
        (await request("team", "POST", `/${ep.slot}`, ep.ownedBattleRegistration.locator)).status,
      ).toBe(200);
    const revision = f.host.uptimeState("event", "team", "hello-world-battle").revision;
    expect(
      (
        await request(
          "other",
          "POST",
          "/frontend",
          view.endpoints[0]?.ownedBattleRegistration.locator,
        )
      ).status,
    ).not.toBe(200);
    expect(f.host.uptimeState("event", "other", "hello-world-battle").revision).toBe(0);
    f.state.revision = revision;
    f.store.prepareMinute([saved[0]?.descriptor, saved[1]?.descriptor], {
      minute: 2,
      authorizationRevision: revision,
    });
    expect(
      (
        await request(
          "team",
          "POST",
          "/frontend",
          view.endpoints[0]?.ownedBattleRegistration.locator,
        )
      ).status,
    ).toBe(409);
    for (const record of saved) {
      f.store.claimStart(record.descriptor.key, 0);
      f.store.saveSnapshot(record.descriptor.key, 1, record.snapshot);
    }
    await f.tick();
    expect(f.host.team("team").score).toBe(10);
    expect(f.host.team("other").score).toBe(0);
    expect(f.host.team("team").scoreEvents).toHaveLength(1);
  } finally {
    await listener.close();
    f.host.close();
  }
});

function providerSnapshot(
  d: ReturnType<typeof descriptor>,
  slot: "frontend" | "api",
  key: string,
  settled: boolean,
  healthy: boolean,
) {
  const service = d.receipt.slots[slot].service;
  const target = d.receipt.slots[slot].binding.target;
  const route = {
    localIP: target.localIP,
    peerIP: target.peerIP,
    localMAC: target.localMAC,
    peerMAC: target.peerMAC,
    peerPort: target.peerPort,
    localPort: 40000,
    anyPeerPort: false,
  };
  return {
    ...snapshot(d, settled),
    key,
    service,
    ...(healthy
      ? {
          route,
          result: {
            observation: {
              route,
              path: service.path,
              status: 200,
              startedAtMs: 101,
              receivedAtMs: 200,
            },
          },
        }
      : {}),
  };
}

test("native Host HTTP registration and scheduler use a signed provider through real transport", async () => {
  const { HostingService, cleanupOwnedBattle } = await import("../service");
  const { startHttpHost } = await import("../http");
  const { ownedBattleSessionBundle } = await import("../simulator-battle-session-bundle");
  const { ExerciseFixture } = await import("./exercise-fixture");
  const providerState: { transport?: typeof directWebTransport } = {};
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (!providerState.transport) throw new Error("provider fixture is not initialized");
      return providerState.transport(new URL(request.url), {
        method: request.method,
        headers: request.headers,
        body: await request.arrayBuffer(),
      });
    },
  });
  const f = await scoringFixture(true, undefined, provider.url.origin);
  providerState.transport = f.transport;
  f.host.putTeam({
    ...f.host.team("team"),
    teamId: "other",
    internalSlug: "other",
    loginKey: "other",
  });
  const eventBeforeOther = f.host.event("event");
  const otherJob = seed(f.host, "other");
  otherJob.definition = f.job.definition;
  f.host.putJob(otherJob);
  f.host.putEvent(eventBeforeOther);
  f.descriptors.push(
    descriptor(otherJob, undefined, undefined, provider.url.origin, "e".repeat(64)),
  );
  f.state.strictRead = true;
  f.host.database.exec(
    "DELETE FROM host_simulator_battle_registrations; DELETE FROM host_simulator_battle_probes;",
  );
  f.state.healthy = true;
  const service = new HostingService(
    f.host,
    new ExerciseFixture((path) => new Database(path)),
    "fixture-master",
    () => f.state.now,
    () => undefined,
    undefined,
    undefined,
    ownedBattleSessionBundle(f.context.settings, f.controller.signal, f.context.clock),
  );
  const listener = await startHttpHost({
    kind: "participant",
    hostname: "127.0.0.1",
    port: 0,
    staticRoot: "/tmp",
    service,
    log: () => undefined,
  });
  const base = `${listener.origin}/api/portal/me/problems/hello-world-battle/endpoints`;
  const request = (token: string, method: string, suffix = "", url?: string) =>
    fetch(base + suffix, {
      method,
      signal: AbortSignal.timeout(5000),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(url ? { body: JSON.stringify({ url }) } : {}),
    });
  try {
    expect((await request("invalid", "GET")).status).toBe(401);
    const view = (await (await request("team", "GET")).json()) as {
      endpoints: { slot: string; ownedBattleRegistration: { locator: string } }[];
    };
    for (const ep of view.endpoints)
      expect(
        (await request("team", "POST", `/${ep.slot}`, ep.ownedBattleRegistration.locator)).status,
      ).toBe(200);
    expect(
      (
        await request(
          "other",
          "POST",
          "/frontend",
          view.endpoints[0]?.ownedBattleRegistration.locator,
        )
      ).status,
    ).not.toBe(200);
    expect(f.host.uptimeState("event", "other", "hello-world-battle").revision).toBe(0);
    const otherView = (await (await request("other", "GET")).json()) as typeof view;
    expect(otherView.endpoints[0]?.ownedBattleRegistration.locator).not.toBe(
      view.endpoints[0]?.ownedBattleRegistration.locator,
    );
    for (const ep of otherView.endpoints)
      expect(
        (await request("other", "POST", `/${ep.slot}`, ep.ownedBattleRegistration.locator)).status,
      ).toBe(200);
    await service.uptime.tick();
    expect((await request("team", "DELETE", "/frontend")).status).toBe(409);
    const starts = f.calls.filter((c) => c.path.endsWith("/start"));
    expect(starts).toHaveLength(4);
    expect(new Set(starts.map((c) => c.key)).size).toBe(4);
    expect(f.host.team("team").score).toBe(0);
    f.state.settled = true;
    await service.uptime.tick();
    const reads = f.calls.filter((c) => c.path.endsWith("/read"));
    expect(reads.map((c) => [c.path.replace(/\/read$/, "/start"), c.key]).sort()).toEqual(
      starts.map((c) => [c.path, c.key]).sort(),
    );
    const first = starts[0];
    if (!first?.key) throw new Error("missing native start key");
    const wrongHandle = first.path.includes("c".repeat(64)) ? "e".repeat(64) : "c".repeat(64);
    const wrongPath = first.path.replace(/[ce]{64}/, wrongHandle).replace(/\/start$/, "/read");
    const serviceSlot = first.path.includes("/frontend/") ? "frontend" : "api";
    const rejected = await fetch(new URL(wrongPath, provider.url), {
      method: "POST",
      body: JSON.stringify({ service: serviceSlot, key: first.key }),
      signal: AbortSignal.timeout(5000),
    });
    expect(await rejected.json()).toBeNull();
    expect(f.descriptors[0]?.receipt.slots.frontend.wireBinding).not.toEqual(
      f.descriptors[1]?.receipt.slots.frontend.wireBinding,
    );
    expect(f.host.team("team").score).toBe(10);
    expect(f.host.team("other").score).toBe(10);
    await service.uptime.tick();
    expect(f.host.team("team").scoreEvents).toHaveLength(1);
    expect((await request("invalid", "DELETE", "/frontend")).status).toBe(401);
    const activeEvent = f.host.event("event");
    const beforeRejectedRemoval = f.host.uptimeState(
      "event",
      "team",
      "hello-world-battle",
    ).revision;
    f.host.putEvent({ ...activeEvent, scoringLocked: true });
    expect((await request("team", "DELETE", "/frontend")).status).toBe(409);
    expect(f.host.uptimeState("event", "team", "hello-world-battle").revision).toBe(
      beforeRejectedRemoval,
    );
    f.host.putEvent(activeEvent);
    const cleared = await request("team", "DELETE", "/frontend");
    expect(cleared.status).toBe(200);
    const clearedView = (await cleared.json()) as {
      endpoints: { slot: string; ownedBattleRegistration: { registered: boolean } }[];
    };
    expect(
      clearedView.endpoints.find((ep) => ep.slot === "frontend")?.ownedBattleRegistration
        .registered,
    ).toBe(false);
    expect(f.host.uptimeState("event", "other", "hello-world-battle").revision).toBe(2);
    const beforeNextMinute = f.calls.length;
    f.state.now += 60000;
    await service.uptime.tick();
    expect(
      f.calls
        .slice(beforeNextMinute)
        .filter((c) => c.path.includes("c".repeat(64)) && c.path.endsWith("/start")),
    ).toHaveLength(0);
    expect(f.host.team("team").scoreEvents).toHaveLength(1);
    await cleanupOwnedBattle(service);
    expect(f.calls.filter((c) => c.path.endsWith("/seal"))).toHaveLength(2);
    expect(f.host.job(otherJob.jobId).unit).toBe(otherJob.unit);
    expect(f.host.team("other").scoreEvents).toHaveLength(2);
    expect(f.host.job(f.job.jobId).unit).toBe(f.job.unit);
  } finally {
    await listener.close();
    await provider.stop(true);
    f.host.close();
  }
});
