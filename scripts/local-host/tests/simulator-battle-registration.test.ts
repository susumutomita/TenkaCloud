import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { PassThrough } from "node:stream";
import type { Job } from "../model";
import {
  type BattleRegistrationGate,
  registerBattleEndpoint,
} from "../simulator-battle-registration";
import { createBattleRegistrationCommit } from "../simulator-battle-registration-commit";
import { SimulatorBattleRegistrationStore } from "../simulator-battle-registration-store";
import { battleRegistrationLocator, battleUptimeTarget } from "../simulator-battle-uptime-target";
import { receiveOwnedSimulatorClock } from "../simulator-clock-bootstrap";
import { HostStore } from "../store";

const domain = `mono-${"a".repeat(32)}`;
const secret = "b".repeat(64);
const handle = "c".repeat(64);
const origin = "http://127.0.0.1:12345";
const settings = {
  endpoint: origin,
  region: "ap-northeast-1",
  readToken: () => "operator".repeat(8),
};
const wire = {
  owner: "1".repeat(64),
  deployment: "2".repeat(64),
  lease: "3".repeat(64),
  backendIncarnation: "4".repeat(64),
};
const lease = { id: "lease", incarnation: wire.lease };
const now = 1794441600000;
function job(): Job {
  return {
    jobId: "job",
    eventId: "event",
    teamId: "team",
    problemId: "hello-world-battle",
    definition: JSON.stringify({
      kind: "cloudformation",
      problemId: "hello-world-battle",
      scoring: { kind: "uptime-flat" },
    }),
    offset: 0,
    status: "COMPLETE",
    deployedAt: 1700000000000,
    unit: JSON.stringify({
      kind: "cloudformation",
      stackId: "stack",
      outputs: { InstanceId: "i-one" },
    }),
  };
}
const target = battleUptimeTarget(job());
function mapping(slot: "frontend" | "api") {
  const path: "/" | "/healthz" = slot === "frontend" ? "/" : "/healthz";
  const port = slot === "frontend" ? 80 : 8080;
  return {
    wireBinding: wire,
    service: { name: slot, port, path },
    binding: {
      owner: target.owner,
      lease,
      slot,
      backendIncarnation: wire.backendIncarnation,
      target: {
        localIP: "192.0.2.1",
        peerIP: "192.0.2.2",
        localMAC: "02:00:00:00:00:01",
        peerMAC: "02:00:00:00:00:02",
        peerPort: port,
        path,
      },
    },
  };
}
function receipt() {
  return {
    version: 1,
    handle,
    clockDomain: domain,
    binding: {
      owner: target.owner,
      lease,
      endpoints: {
        frontend: `${origin}/_simulator/v1/battle-capabilities/${handle}/frontend`,
        api: `${origin}/_simulator/v1/battle-capabilities/${handle}/api`,
      },
    },
    slots: { frontend: mapping("frontend"), api: mapping("api") },
  };
}
async function fixture() {
  const database = new Database(":memory:");
  const host = new HostStore(database);
  host.putEvent({
    eventId: "event",
    name: "Synthetic",
    status: "READY",
    createdAt: "now",
    updatedAt: "now",
    expiresAt: 1,
    scoringLocked: false,
    scoreboardFreezeMinutes: 0,
    problems: [],
  });
  for (const id of ["team", "other"])
    host.putTeam({
      teamId: id,
      eventId: "event",
      internalSlug: id,
      displayName: id,
      loginKey: `key-${id}`,
      snapshot: null,
      score: 0,
      completedProblems: 0,
      scoreEvents: [],
    });
  host.putJob(job());
  host.putUptimeState("event", "team", "hello-world-battle", { revision: 1 });
  const registrations = new SimulatorBattleRegistrationStore(host, {
    kind: "owned-battle-registration-scope",
    providerDomain: domain,
  });
  const pipe = new PassThrough();
  const pending = receiveOwnedSimulatorClock(pipe);
  pipe.end(
    `{"version":2,"domain":"${domain}","key":"${secret}","clock":"linux-clock-monotonic"}\n`,
  );
  const clock = await pending;
  const control = new AbortController();
  let current: () => BattleRegistrationGate = () => ({
    target: battleUptimeTarget(host.job("job")),
    revision: 1,
  });
  let calls = 0;
  let duringResolve: () => void = () => undefined;
  let tamper = false;
  let value: unknown = receipt();
  let trustedNow = () => now;
  const run = (
    input: unknown = { slot: "frontend", locator: battleRegistrationLocator(target, "frontend") },
  ) =>
    registerBattleEndpoint(
      {
        settings,
        clock,
        registrations,
        commit: createBattleRegistrationCommit(host, domain),
        signal: control.signal,
        current: () => current(),
        now: () => trustedNow(),
      },
      input,
      {
        now: () => 1,
        transport: async (url, init) => {
          calls++;
          expect(url.pathname).toBe("/_simulator/v1/battle-capabilities/resolve");
          if (!(init.body instanceof ArrayBuffer)) throw new Error("byte request expected");
          const request = new Uint8Array(init.body);
          expect(JSON.parse(new TextDecoder().decode(request))).toEqual({
            version: 1,
            owner: target.owner,
            key: target.ownerKey,
          });
          duringResolve();
          const response = new TextEncoder().encode(JSON.stringify(value));
          const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
          const nonce = new Headers(init.headers).get("X-Simulator-Clock-Nonce") ?? "";
          const mac = createHmac("sha256", Buffer.from(secret, "hex"))
            .update(
              `TCS-RESPONSE-3\n${domain}\n${nonce}\nPOST\n${url.pathname}\n${hash(request)}\n200\n${response.length}\n`,
            )
            .update(response)
            .digest("hex");
          return new Response(response, {
            headers: {
              "X-Simulator-Clock-Domain": domain,
              "X-Simulator-Clock-MAC": tamper ? "0".repeat(64) : mac,
            },
          });
        },
      },
    );
  return {
    host,
    control,
    registrations,
    run,
    calls: () => calls,
    count: () =>
      database.query("SELECT COUNT(*) AS count FROM host_simulator_battle_registrations").get(),
    setCurrent: (callback: () => BattleRegistrationGate) => {
      current = callback;
    },
    during: (callback: () => void) => {
      duringResolve = callback;
    },
    tamper: () => {
      tamper = true;
    },
    response: (next: unknown) => {
      value = next;
    },
    time: (callback: () => number) => {
      trustedNow = callback;
    },
  };
}
test("signed owned resolve and stable gate save correlation only using trusted timestamp", async () => {
  const f = await fixture();
  try {
    const result = await f.run();
    expect(result).toEqual({
      slot: "frontend",
      locator: battleRegistrationLocator(target, "frontend"),
      registeredAt: new Date(now).toISOString(),
      status: "correlation-registration-only",
      scoringQualified: false,
      battleAcceptancePassed: false,
    });
    expect(f.registrations.get(target, "frontend")?.providerDomain).toBe(domain);
    expect(f.count()).toEqual({ count: 1 });
    expect(f.calls()).toBe(1);
  } finally {
    f.host.close();
  }
});
for (const input of [
  {
    slot: "frontend",
    locator: battleRegistrationLocator(
      battleUptimeTarget({ ...job(), teamId: "other" }),
      "frontend",
    ),
  },
  { slot: "api", locator: battleRegistrationLocator(target, "frontend") },
  { slot: "frontend", locator: `${battleRegistrationLocator(target, "frontend")}/healthz` },
  {
    slot: "frontend",
    locator: battleRegistrationLocator(target, "frontend"),
    registeredAt: "2020-01-01T00:00:00Z",
  },
  { slot: "frontend", locator: battleRegistrationLocator(target, "frontend"), owner: target.owner },
])
  test("foreign or expanded participant input cannot resolve or save", async () => {
    const f = await fixture();
    try {
      await expect(f.run(input)).rejects.toThrow();
      expect(f.calls()).toBe(0);
      expect(f.count()).toEqual({ count: 0 });
    } finally {
      f.host.close();
    }
  });
for (const revision of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])
  test(`invalid trusted revision ${revision} fails closed`, async () => {
    const f = await fixture();
    try {
      f.setCurrent(() => ({ target, revision }));
      await expect(f.run()).rejects.toThrow();
      expect(f.calls()).toBe(0);
      expect(f.count()).toEqual({ count: 0 });
    } finally {
      f.host.close();
    }
  });
for (const [label, alter] of [
  ["team", () => battleUptimeTarget({ ...job(), teamId: "other" })],
  ["generation", () => battleUptimeTarget({ ...job(), deployedAt: 1700000000001 })],
  ["invalid target key", () => ({ ...target, ownerKey: "0".repeat(64) })],
  ["invalid target generation", () => ({ ...target, generation: "forged" })],
] as const)
  test(`${label} changing during resolution cannot save`, async () => {
    const f = await fixture();
    try {
      f.during(() => {
        f.setCurrent(() => ({ target: alter(), revision: 1 }));
      });
      await expect(f.run()).rejects.toThrow();
      expect(f.calls()).toBe(1);
      expect(f.count()).toEqual({ count: 0 });
    } finally {
      f.host.close();
    }
  });
test("revision change and gate revocation after signed resolve both prevent save", async () => {
  for (const gate of [
    () => ({ target, revision: 2 }),
    () => {
      throw new Error("gate revoked");
    },
  ]) {
    const f = await fixture();
    try {
      f.during(() => f.setCurrent(gate));
      await expect(f.run()).rejects.toThrow();
      expect(f.count()).toEqual({ count: 0 });
    } finally {
      f.host.close();
    }
  }
});
test("mutable returned target cannot rewrite the before snapshot across await", async () => {
  const f = await fixture();
  try {
    const mutable = structuredClone(target);
    f.setCurrent(() => ({ target: mutable, revision: 1 }));
    f.during(() => {
      Object.assign(mutable, battleUptimeTarget({ ...job(), deployedAt: 1700000000001 }));
    });
    await expect(f.run()).rejects.toThrow();
    expect(f.count()).toEqual({ count: 0 });
  } finally {
    f.host.close();
  }
});
for (const stage of ["before", "current", "resolve", "timestamp"] as const)
  test(`abort at ${stage} prevents registration`, async () => {
    const f = await fixture();
    try {
      const abort = () => f.control.abort(new Error("cancelled"));
      if (stage === "before") abort();
      if (stage === "current")
        f.setCurrent(() => {
          abort();
          return { target, revision: 1 };
        });
      if (stage === "resolve") f.during(abort);
      if (stage === "timestamp")
        f.time(() => {
          abort();
          return now;
        });
      await expect(f.run()).rejects.toThrow("cancelled");
      expect(f.count()).toEqual({ count: 0 });
      expect(f.calls()).toBe(stage === "before" || stage === "current" ? 0 : 1);
    } finally {
      f.host.close();
    }
  });
test("invalid signature and signed unknown receipt do not save", async () => {
  for (const invalid of ["signature", "unknown"] as const) {
    const f = await fixture();
    try {
      if (invalid === "signature") f.tamper();
      else f.response(null);
      await expect(f.run()).rejects.toThrow();
      expect(f.count()).toEqual({ count: 0 });
    } finally {
      f.host.close();
    }
  }
});
test("invalid trusted timestamp cannot save", async () => {
  const f = await fixture();
  try {
    f.time(() => Number.NaN);
    await expect(f.run()).rejects.toThrow();
    expect(f.count()).toEqual({ count: 0 });
  } finally {
    f.host.close();
  }
});

test("gate denial before resolve sends nothing and saves nothing", async () => {
  const f = await fixture();
  try {
    f.setCurrent(() => {
      throw new Error("event gate closed");
    });
    await expect(f.run()).rejects.toThrow("event gate closed");
    expect(f.calls()).toBe(0);
    expect(f.count()).toEqual({ count: 0 });
  } finally {
    f.host.close();
  }
});
test("database redeploy cannot be hidden by a stale caller gate snapshot", async () => {
  const f = await fixture();
  try {
    f.setCurrent(() => ({ target, revision: 1 }));
    f.during(() => {
      f.host.putJob({ ...job(), deployedAt: 1700000000001 });
    });
    await expect(f.run()).rejects.toThrow("stale or foreign");
    expect(f.calls()).toBe(1);
    expect(f.count()).toEqual({ count: 0 });
  } finally {
    f.host.close();
  }
});
test("signed foreign receipt does not authorize registration", async () => {
  const f = await fixture();
  try {
    const foreign = receipt();
    foreign.binding.owner = { ...target.owner, teamId: "other" };
    f.response(foreign);
    await expect(f.run()).rejects.toThrow("Foreign Battle receipt");
    expect(f.calls()).toBe(1);
    expect(f.count()).toEqual({ count: 0 });
  } finally {
    f.host.close();
  }
});
