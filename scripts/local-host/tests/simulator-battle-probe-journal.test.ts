import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { directWebTransport } from "../direct-web-transport";
import { SimulatorBattleProbeJournal } from "../simulator-battle-probe-journal";
import { SimulatorBattleProbeStore } from "../simulator-battle-probe-store";
import { createBattleRegistrationCommit } from "../simulator-battle-registration-commit";
import { simulatorBattleUptimeTarget } from "../simulator-battle-uptime-target";
import { receiveOwnedSimulatorClock } from "../simulator-clock-bootstrap";
import { HostStore } from "../store";
import { descriptor, scope, seed, snapshot } from "./simulator-battle-journal-fixture";

async function fixture(path = ":memory:") {
  const host = new HostStore(new Database(path));
  const job = seed(host);
  const d = descriptor(job);
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
    loseStart: false,
    after: (_path: string): void => undefined,
  };
  const calls: { path: string; key?: string }[] = [];
  const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const hmac = (prefix: string, bytes: Uint8Array = new Uint8Array()) =>
    createHmac("sha256", Buffer.from(secret, "hex")).update(prefix).update(bytes).digest("hex");
  const responseMac = (prefix: string, body: Uint8Array) =>
    state.badSignature ? "0".repeat(64) : hmac(prefix, body);
  const transport: typeof directWebTransport = async (url, init) => {
    if (!(init.body instanceof ArrayBuffer)) throw new Error("request bytes required");
    const request = new Uint8Array(init.body);
    const input = JSON.parse(new TextDecoder().decode(request));
    const path = url.pathname;
    calls.push({ path, key: input.key });
    let value: unknown = d.receipt;
    if (path.endsWith("/clock"))
      value = {
        version: 2,
        domain,
        nonce: input.nonce,
        ticksMs: 100,
        validUntilMs: 30100,
        mac: hmac(`TCS-CLOCK-2\n${domain}\n${input.nonce}\n100\n30100\n`),
      };
    if (path.endsWith("/start") || path.endsWith("/read")) {
      if (path.endsWith("/start") && state.loseStart) throw new Error("start reply lost");
      value = state.unknown ? null : { ...snapshot(d, state.settled), key: input.key };
    }
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
      endpoint: "http://127.0.0.1:1234",
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
  return { host, job, d, store, controller, state, calls, journal, context };
}

test("journal prepare/start/recreated read keeps one key and distinguishes ready from settled", async () => {
  const f = await fixture();
  try {
    const prepared = await f.journal().prepare("frontend", 7900);
    const id = prepared.descriptor.key;
    const ready = await f.journal().start(id);
    expect(ready.state).toBe("start-uncertain");
    expect(ready.snapshot?.resultReady).toBe(true);
    expect(ready.snapshot?.settled).toBe(false);
    await expect(f.journal().start(id)).rejects.toThrow("already claimed");
    f.state.settled = true;
    expect((await f.journal().recover(id)).state).toBe("settled");
    expect(f.calls.filter((c) => c.path.endsWith("/start"))).toHaveLength(1);
    expect(f.calls.filter((c) => c.path.endsWith("/read")).map((c) => c.key)).toEqual([id]);
    expect(f.store.get(id).descriptor.deadline).toEqual(prepared.descriptor.deadline);
  } finally {
    f.host.close();
  }
});

test("lost start and unknown reads stay active without resubmit or new deadline", async () => {
  const f = await fixture();
  try {
    f.store.prepare(f.d, { authorizationRevision: 0 });
    f.state.loseStart = true;
    await expect(f.journal().start(f.d.key)).rejects.toThrow("lost");
    expect(f.store.get(f.d.key).state).toBe("start-uncertain");
    f.state.unknown = true;
    await expect(f.journal().recover(f.d.key)).rejects.toThrow();
    expect(f.store.get(f.d.key).unknown).toBeDefined();
    f.state.unknown = false;
    f.state.settled = true;
    expect((await f.journal().recover(f.d.key)).state).toBe("settled");
    expect(f.calls.filter((c) => c.path.endsWith("/start"))).toHaveLength(1);
    expect(f.calls.some((c) => c.path.endsWith("/clock"))).toBe(false);
  } finally {
    f.host.close();
  }
});

test.each(["signature", "gate", "abort", "ignore"])(
  "start %s failure before claim sends no operation",
  async (failure) => {
    const f = await fixture();
    try {
      const before = f.store.prepare(f.d, { authorizationRevision: 0 });
      if (failure === "signature") f.state.badSignature = true;
      if (failure === "gate")
        f.state.after = () => {
          f.state.revision++;
        };
      if (failure === "abort")
        f.state.after = () => {
          f.controller.abort();
        };
      if (failure === "ignore")
        f.host.database.exec(
          "CREATE TRIGGER ignore_claim BEFORE UPDATE ON host_simulator_battle_probes BEGIN SELECT RAISE(IGNORE); END;",
        );
      await expect(f.journal().start(f.d.key)).rejects.toThrow();
      expect(f.store.get(f.d.key)).toEqual(before);
      expect(f.calls.every((c) => c.path.endsWith("/resolve"))).toBe(true);
    } finally {
      f.host.close();
    }
  },
);

test("snapshot save failure after dispatch retains uncertain intent and never retries", async () => {
  const f = await fixture();
  try {
    f.store.prepare(f.d, { authorizationRevision: 0 });
    f.state.after = (path) => {
      if (path.endsWith("/start"))
        f.host.database.exec(
          "CREATE TRIGGER ignore_save BEFORE UPDATE ON host_simulator_battle_probes BEGIN SELECT RAISE(IGNORE); END;",
        );
    };
    await expect(f.journal().start(f.d.key)).rejects.toThrow();
    expect(f.store.get(f.d.key).state).toBe("start-uncertain");
    expect(f.store.get(f.d.key).revision).toBe(1);
    await expect(f.journal().start(f.d.key)).rejects.toThrow();
    expect(f.calls.filter((c) => c.path.endsWith("/start"))).toHaveLength(1);
  } finally {
    f.host.close();
  }
});

test("two simultaneous start callers send only the CAS winner", async () => {
  const f = await fixture();
  try {
    f.store.prepare(f.d, { authorizationRevision: 0 });
    const results = await Promise.allSettled([
      f.journal().start(f.d.key),
      f.journal().start(f.d.key),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(f.calls.filter((c) => c.path.endsWith("/start"))).toHaveLength(1);
  } finally {
    f.host.close();
  }
});

test("old generation recovery stays retained and performs no provider request", async () => {
  const f = await fixture();
  try {
    f.store.prepare(f.d, { authorizationRevision: 0 });
    const before = f.store.claimStart(f.d.key, 0);
    f.host.putJob({ ...f.job, deployedAt: 2000 });
    await expect(f.journal().recover(f.d.key)).rejects.toThrow("Stale");
    expect(f.store.get(f.d.key)).toEqual(before);
    expect(f.calls).toEqual([]);
  } finally {
    f.host.close();
  }
});

test("crash boundary after durable claim aborts without dispatch and keeps read-only recovery", async () => {
  const f = await fixture();
  try {
    f.store.prepare(f.d, { authorizationRevision: 0 });
    const claim = f.store.claimStart.bind(f.store);
    f.store.claimStart = (id, revision) => {
      const record = claim(id, revision);
      f.controller.abort();
      return record;
    };
    await expect(f.journal().start(f.d.key)).rejects.toThrow();
    expect(f.store.get(f.d.key).state).toBe("start-uncertain");
    expect(f.calls.some((c) => c.path.endsWith("/start"))).toBe(false);
  } finally {
    f.host.close();
  }
});

test("prepared recovery uses only read and makes future start impossible", async () => {
  const f = await fixture();
  try {
    f.store.prepare(f.d, { authorizationRevision: 0 });
    f.state.unknown = true;
    await expect(f.journal().recover(f.d.key)).rejects.toThrow();
    expect(f.store.get(f.d.key).state).toBe("start-uncertain");
    await expect(f.journal().start(f.d.key)).rejects.toThrow("already claimed");
    expect(f.calls.some((c) => c.path.endsWith("/start"))).toBe(false);
  } finally {
    f.host.close();
  }
});

test("another team's valid current target cannot read or claim a foreign intent", async () => {
  const f = await fixture();
  try {
    f.store.prepare(f.d, { authorizationRevision: 0 });
    const second = seed(f.host, "second");
    f.context.current = () => ({ target: simulatorBattleUptimeTarget(second), revision: 0 });
    await expect(f.journal().start(f.d.key)).rejects.toThrow("foreign");
    await expect(f.journal().recover(f.d.key)).rejects.toThrow("foreign");
    expect(f.store.get(f.d.key).state).toBe("prepared");
    expect(f.calls).toEqual([]);
  } finally {
    f.host.close();
  }
});

test("prepare pins authorization revision; registration changes cannot rebase start or recover", async () => {
  const f = await fixture();
  try {
    f.state.revision = 7;
    const before = await f.journal().prepare("frontend", 7900);
    expect(before.authorizationRevision).toBe(7);
    const count = f.calls.length;
    f.state.revision = 8;
    await expect(f.journal().start(before.descriptor.key)).rejects.toThrow(
      "authorization revision changed",
    );
    await expect(f.journal().recover(before.descriptor.key)).rejects.toThrow(
      "authorization revision changed",
    );
    expect(f.store.get(before.descriptor.key)).toEqual(before);
    expect(f.calls).toHaveLength(count);
  } finally {
    f.host.close();
  }
});

test("reopened journal refuses a new registration revision without modifying the old intent", async () => {
  const directory = mkdtempSync(join(tmpdir(), "battle-auth-revision-"));
  const path = join(directory, "host.sqlite");
  const f = await fixture(path);
  let host = f.host;
  try {
    const before = f.store.prepare(f.d, { authorizationRevision: 4 });
    host.close();
    host = new HostStore(new Database(path));
    const store = new SimulatorBattleProbeStore(host, scope);
    f.context.store = store;
    f.context.current = () => ({
      target: simulatorBattleUptimeTarget(host.job(f.job.jobId)),
      revision: 5,
    });
    await expect(f.journal().start(f.d.key)).rejects.toThrow("authorization revision changed");
    await expect(f.journal().recover(f.d.key)).rejects.toThrow("authorization revision changed");
    expect(store.get(f.d.key)).toEqual(before);
    expect(store.active("event", "team", "frontend")?.authorizationRevision).toBe(4);
    expect(f.calls).toEqual([]);
  } finally {
    host.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("atomic re-registration invalidates an already prepared journal authorization", async () => {
  const f = await fixture();
  try {
    f.context.current = () => ({
      target: simulatorBattleUptimeTarget(f.host.job(f.job.jobId)),
      revision: f.host.uptimeState("event", "team", "hello-world-battle").revision,
    });
    const commit = createBattleRegistrationCommit(f.host, f.d.deadline.domain);
    const intent = {
      target: simulatorBattleUptimeTarget(f.job),
      expectedRevision: 0,
      slot: "frontend" as const,
      providerDomain: f.d.deadline.domain,
      registeredAt: "2026-11-12T00:00:00.000Z",
    };
    commit(intent);
    const prepared = await f.journal().prepare("frontend", 7900);
    expect(prepared.authorizationRevision).toBe(1);
    const count = f.calls.length;
    commit({ ...intent, expectedRevision: 1 });
    await expect(f.journal().start(prepared.descriptor.key)).rejects.toThrow(
      "authorization revision changed",
    );
    await expect(f.journal().recover(prepared.descriptor.key)).rejects.toThrow(
      "authorization revision changed",
    );
    expect(f.store.get(prepared.descriptor.key)).toEqual(prepared);
    expect(f.calls).toHaveLength(count);
  } finally {
    f.host.close();
  }
});

test("minute prepare fixes both slots without dispatch and rejects repeated tick", async () => {
  const f = await fixture();
  try {
    const [front, api] = await f.journal().prepareMinute(0, 7900);
    expect(front.minute).toBe(0);
    expect(api.minute).toBe(0);
    expect(front.descriptor.key).not.toBe(api.descriptor.key);
    expect(f.store.forMinute("event", "team", "frontend", 0)?.descriptor.key).toBe(
      front.descriptor.key,
    );
    expect(f.calls.some((c) => c.path.endsWith("/start"))).toBe(false);
    await expect(f.journal().prepareMinute(0, 7900)).rejects.toThrow();
    f.state.now = 60_000;
    await expect(f.journal().start(front.descriptor.key)).rejects.toThrow(
      "minute is no longer current",
    );
    expect(f.store.get(front.descriptor.key).state).toBe("prepared");
    expect(f.calls.some((c) => c.path.endsWith("/start"))).toBe(false);
  } finally {
    f.host.close();
  }
});

for (const change of ["minute", "registration"] as const) {
  test(`minute preparation rejects ${change} change during provider await`, async () => {
    const f = await fixture();
    try {
      f.state.after = () => {
        if (change === "minute") f.state.now = 60_000;
        else f.state.revision += 1;
      };
      await expect(f.journal().prepareMinute(0, 7900)).rejects.toThrow();
      expect(f.store.forMinute("event", "team", "frontend", 0)).toBeUndefined();
      expect(f.store.forMinute("event", "team", "api", 0)).toBeUndefined();
      expect(f.calls.some((c) => c.path.endsWith("/start"))).toBe(false);
    } finally {
      f.host.close();
    }
  });
}

test("start refuses wall-minute change during authentication without claiming or dispatching", async () => {
  const f = await fixture();
  try {
    f.state.now = 1_800_000_000_001;
    const minute = Math.floor(f.state.now / 60_000);
    const [front] = await f.journal().prepareMinute(minute, 7900);
    f.state.after = () => {
      f.state.now += 60_000;
    };
    await expect(f.journal().start(front.descriptor.key)).rejects.toThrow(
      "minute is no longer current",
    );
    expect(f.store.get(front.descriptor.key).state).toBe("prepared");
    expect(f.calls.some((c) => c.path.endsWith("/start"))).toBe(false);
  } finally {
    f.host.close();
  }
});

test("old wall-minute recovery reads the same key without a fresh start", async () => {
  const f = await fixture();
  try {
    f.state.now = 1_800_000_000_001;
    const minute = Math.floor(f.state.now / 60_000);
    const [front] = await f.journal().prepareMinute(minute, 7900);
    await f.journal().start(front.descriptor.key);
    f.state.now += 60_000;
    f.state.settled = true;
    expect((await f.journal().recover(front.descriptor.key)).state).toBe("settled");
    expect(f.calls.filter((c) => c.path.endsWith("/start"))).toHaveLength(1);
    expect(f.calls.filter((c) => c.path.endsWith("/read")).map((c) => c.key)).toEqual([
      front.descriptor.key,
    ]);
    expect(f.store.forMinute("event", "team", "frontend", minute)?.descriptor.key).toBe(
      front.descriptor.key,
    );
  } finally {
    f.host.close();
  }
});

test("expired never-started intent cannot make a provider recovery call", async () => {
  const f = await fixture();
  try {
    const pair = await f.journal().prepareMinute(0, 7900);
    f.store.expireUnstarted(pair[0].descriptor.key, 0, 1);
    const count = f.calls.length;
    await expect(f.journal().recover(pair[0].descriptor.key)).rejects.toThrow("terminal");
    expect(f.calls).toHaveLength(count);
  } finally {
    f.host.close();
  }
});
