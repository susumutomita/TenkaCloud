import { expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { PassThrough } from "node:stream";
import { requestBattleCapability } from "../simulator-battle-capability";
import {
  prepareBattleProbe,
  prepareBattleProbeDescriptor,
  resumeBattleProbeReadOnly,
} from "../simulator-battle-probe";
import { receiveOwnedSimulatorClock } from "../simulator-clock-bootstrap";

const domain = `mono-${"a".repeat(32)}`;
const secret = "b".repeat(64);
const handle = "c".repeat(64);
const origin = "http://127.0.0.1:12345";
const settings = {
  endpoint: origin,
  region: "ap-northeast-1",
  readToken: () => "operator".repeat(8),
};
const owner = {
  eventId: "event",
  teamId: "team",
  jobId: "job",
  unitHash: "a".repeat(64),
  deployedAt: 1700000000000,
  stackId: "stack",
  instanceId: "i-one",
};
const wire = {
  owner: "1".repeat(64),
  deployment: "2".repeat(64),
  lease: "3".repeat(64),
  backendIncarnation: "4".repeat(64),
};
const lease = { id: "lease", incarnation: wire.lease };
const target = {
  localIP: "192.0.2.1",
  peerIP: "192.0.2.2",
  localMAC: "02:00:00:00:00:01",
  peerMAC: "02:00:00:00:00:02",
};
const route = { ...target, localPort: 40000, peerPort: 80, anyPeerPort: false as const };
function mapping(slot: "frontend" | "api") {
  const path: "/" | "/healthz" = slot === "frontend" ? "/" : "/healthz";
  const port = slot === "frontend" ? 80 : 8080;
  return {
    wireBinding: wire,
    service: { name: slot, port, path },
    binding: {
      owner,
      lease,
      slot,
      backendIncarnation: wire.backendIncarnation,
      target: { ...target, peerPort: port, path },
    },
  };
}
function receipt() {
  return {
    version: 1,
    handle,
    clockDomain: domain,
    binding: {
      owner,
      lease,
      endpoints: {
        frontend: `${origin}/_simulator/v1/battle-capabilities/${handle}/frontend`,
        api: `${origin}/_simulator/v1/battle-capabilities/${handle}/api`,
      },
    },
    slots: { frontend: mapping("frontend"), api: mapping("api") },
  };
}
interface Command {
  version: number;
  command: string;
  binding: typeof wire;
  service: string;
  key: string;
  deadline?: { domain: string; ticksMs: number };
}
function pending(command: Command) {
  return {
    version: 2,
    clockDomain: domain,
    binding: wire,
    service: mapping(command.service === "api" ? "api" : "frontend").service,
    key: command.key,
    startedAtMs: 100_010,
    deadlineMs: 108_000,
    resultReady: false,
    settled: false,
  };
}
function observed(command: Command, settled = false) {
  return {
    ...pending(command),
    resultReady: true,
    settled,
    route,
    result: {
      observation: { route, path: "/", status: 200, startedAtMs: 100_011, receivedAtMs: 100_012 },
    },
  };
}
type Reply = (command: Command) => unknown;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const hmac = (text: string, body: Uint8Array = new Uint8Array()) =>
  createHmac("sha256", Buffer.from(secret, "hex")).update(text).update(body).digest("hex");
async function fixture(
  replies: Reply[] = [pending, observed, (c) => observed(c, true)],
  resolveReceipt = receipt,
) {
  const pipe = new PassThrough();
  const promise = receiveOwnedSimulatorClock(pipe);
  pipe.end(
    `{"version":2,"domain":"${domain}","key":"${secret}","clock":"linux-clock-monotonic"}\n`,
  );
  const clock = await promise;
  const calls: { path: string; body: unknown }[] = [];
  let operation = 0;
  const dependencies: Parameters<typeof prepareBattleProbe>[5] = {
    now: () => 1,
    transport: async (url, init) => {
      if (!(init.body instanceof ArrayBuffer)) throw new Error("byte request expected");
      const bytes = new Uint8Array(init.body);
      const input: unknown = JSON.parse(new TextDecoder().decode(bytes));
      const path = url.pathname;
      calls.push({ path, body: input });
      let value: unknown;
      if (path.endsWith("/resolve")) value = resolveReceipt();
      else if (path.endsWith("/clock")) {
        const sampleNonce = (input as { nonce: string }).nonce;
        value = {
          version: 2,
          domain,
          nonce: sampleNonce,
          ticksMs: 100_000,
          validUntilMs: 130_000,
          mac: hmac(`TCS-CLOCK-2\n${domain}\n${sampleNonce}\n100000\n130000\n`),
        };
      } else {
        const reply = replies[operation++];
        if (!reply) throw new Error("unexpected extra operation");
        value = reply(input as Command);
      }
      const response = new TextEncoder().encode(JSON.stringify(value));
      const nonce = new Headers(init.headers).get("X-Simulator-Clock-Nonce") ?? "";
      const mac = hmac(
        `TCS-RESPONSE-3\n${domain}\n${nonce}\nPOST\n${path}\n${hash(bytes)}\n200\n${response.length}\n`,
        response,
      );
      return new Response(response, {
        headers: { "X-Simulator-Clock-Domain": domain, "X-Simulator-Clock-MAC": mac },
      });
    },
  };
  const prepare = (slot: "frontend" | "api" = "frontend") =>
    prepareBattleProbe(settings, clock, owner, slot, 8000, dependencies);
  const descriptor = () =>
    prepareBattleProbeDescriptor(settings, clock, owner, "frontend", 8000, dependencies);
  return { prepare, descriptor, calls, clock, dependencies };
}
test("signed resolve, clock and v2 start/read preserve operation identity and readiness/settlement", async () => {
  const f = await fixture();
  const operation = await f.prepare();
  expect(operation.key).toMatch(/^[a-f0-9]{32}$/u);
  const started = await operation.start();
  expect(started.snapshot.resultReady).toBe(false);
  const result = await operation.read();
  expect(result.snapshot.resultReady).toBe(true);
  expect(result.snapshot.settled).toBe(false);
  expect(result.scoringQualified).toBe(false);
  // Returned objects cannot mutate retained validation state.
  result.snapshot.startedAtMs = 1;
  expect((await operation.read()).snapshot.settled).toBe(true);
  const commands = f.calls.slice(2).map((c) => c.body as Command);
  expect(commands.map((c) => c.key)).toEqual([operation.key, operation.key, operation.key]);
  expect(commands[0]).toEqual({
    version: 2,
    command: "start",
    binding: wire,
    service: "frontend",
    key: operation.key,
    deadline: operation.deadline,
  });
  expect(commands[1]).toEqual({
    version: 2,
    command: "read",
    binding: wire,
    service: "frontend",
    key: operation.key,
  });
  expect(f.calls[2]?.path).toBe(`/_simulator/v1/battle-capabilities/${handle}/frontend/start`);
});
test("lost start response cannot trigger resubmission, clock refresh or a new key", async () => {
  const f = await fixture([
    () => {
      throw new Error("lost reply");
    },
    pending,
  ]);
  const operation = await f.prepare();
  await expect(operation.start()).rejects.toThrow("lost reply");
  await expect(operation.start()).rejects.toThrow("exactly once");
  expect((await operation.read()).snapshot.key).toBe(operation.key);
  expect(f.calls).toHaveLength(4);
});
test("read before start is refused without transport", async () => {
  const f = await fixture();
  await expect((await f.prepare()).read()).rejects.toThrow("exactly once");
  expect(f.calls).toHaveLength(2);
});
test("unknown is not success, settlement or permission to restart", async () => {
  const f = await fixture([() => null, pending]);
  const operation = await f.prepare();
  await expect(operation.start()).rejects.toThrow();
  await expect(operation.start()).rejects.toThrow();
  expect((await operation.read()).snapshot.settled).toBe(false);
});
const invalid: [string, Reply][] = [
  ["foreign key", (c) => ({ ...pending(c), key: "9".repeat(32) })],
  ["zero key", (c) => ({ ...pending(c), key: "0".repeat(32) })],
  ["version one", (c) => ({ ...pending(c), version: 1 })],
  ["clock domain", (c) => ({ ...pending(c), clockDomain: "foreign" })],
  ["owner", (c) => ({ ...pending(c), binding: { ...wire, owner: "9".repeat(64) } })],
  ["service", (c) => ({ ...pending(c), service: mapping("api").service })],
  ["extended deadline", (c) => ({ ...pending(c), deadlineMs: 108_001 })],
  ["overlong duration", (c) => ({ ...pending(c), startedAtMs: 99_999 })],
  ["settled without result", (c) => ({ ...pending(c), settled: true })],
  ["ready without result", (c) => ({ ...pending(c), resultReady: true })],
  ["result before ready", (c) => ({ ...pending(c), result: { error: "canceled" } })],
  ["empty result", (c) => ({ ...pending(c), resultReady: true, result: {} })],
  [
    "mixed result",
    (c) => ({ ...observed(c), result: { ...observed(c).result, error: "canceled" } }),
  ],
  ["foreign route", (c) => ({ ...observed(c), route: { ...route, peerIP: "192.0.2.3" } })],
  ["wildcard route", (c) => ({ ...observed(c), route: { ...route, anyPeerPort: true } })],
  ["invalid source port", (c) => ({ ...observed(c), route: { ...route, localPort: 41024 } })],
  ["missing route", (c) => ({ ...pending(c), resultReady: true, result: observed(c).result })],
  [
    "foreign observation route",
    (c) => ({
      ...observed(c),
      result: {
        observation: { ...observed(c).result.observation, route: { ...route, localPort: 40001 } },
      },
    }),
  ],
  [
    "foreign observation path",
    (c) => ({
      ...observed(c),
      result: { observation: { ...observed(c).result.observation, path: "/healthz" } },
    }),
  ],
  [
    "late observation",
    (c) => ({
      ...observed(c),
      result: { observation: { ...observed(c).result.observation, receivedAtMs: 108_000 } },
    }),
  ],
  [
    "negative observation duration",
    (c) => ({
      ...observed(c),
      result: { observation: { ...observed(c).result.observation, receivedAtMs: 100_010 } },
    }),
  ],
  [
    "observation predates operation",
    (c) => ({
      ...observed(c),
      result: { observation: { ...observed(c).result.observation, startedAtMs: 100_009 } },
    }),
  ],
];
for (const [label, reply] of invalid) {
  test(`reject ${label} without retry or synthetic success`, async () => {
    const f = await fixture([reply]);
    await expect((await f.prepare()).start()).rejects.toThrow();
    expect(f.calls).toHaveLength(3);
  });
}
test("provider error is retained separately from settlement and never made healthy", async () => {
  const f = await fixture([
    (c) => ({ ...pending(c), resultReady: true, settled: true, result: { error: "probe_failed" } }),
  ]);
  const result = await (await f.prepare()).start();
  expect(result.snapshot.result).toEqual({ error: "probe_failed" });
  expect(result.snapshot.settled).toBe(true);
  expect(result.scoringQualified).toBe(false);
});
for (const [label, reply] of [
  ["started timestamp", (c: Command) => ({ ...observed(c, true), startedAtMs: 100_009 })],
  ["deadline", (c: Command) => ({ ...observed(c, true), deadlineMs: 107_999 })],
  ["settlement", (c: Command) => observed(c, false)],
  ["result", (c: Command) => ({ ...observed(c, true), result: { error: "canceled" } })],
  ["readiness", pending],
] as const) {
  test(`retained ${label} cannot change or regress`, async () => {
    const f = await fixture([(c) => observed(c, true), reply]);
    const operation = await f.prepare();
    await operation.start();
    await expect(operation.read()).rejects.toThrow();
  });
}
test("capability helper refuses arbitrary paths before sending credentials", async () => {
  const f = await fixture();
  await expect(
    requestBattleCapability(
      settings,
      f.clock,
      `../foreign/frontend/start`,
      {},
      {
        transport: async () => {
          throw new Error("must not send");
        },
      },
    ),
  ).rejects.toThrow("Invalid Battle capability operation");
});

test("api uses its pinned service and endpoint, not frontend", async () => {
  const f = await fixture([pending]);
  const operation = await f.prepare("api");
  expect((await operation.start()).snapshot.service).toEqual(mapping("api").service);
  expect(f.calls[2]?.path).toBe(`/_simulator/v1/battle-capabilities/${handle}/api/start`);
});
test("overlapping reads cannot overtake a pending start", async () => {
  const f = await fixture();
  const operation = await f.prepare();
  const started = operation.start();
  await expect(operation.read()).rejects.toThrow("in flight");
  await started;
  expect(f.calls).toHaveLength(3);
});
test("timeout result may precede first route publication until worker settlement", async () => {
  const failed = (c: Command) => ({
    ...pending(c),
    resultReady: true,
    result: { error: "probe_failed" },
  });
  const f = await fixture([failed, (c) => ({ ...failed(c), route })]);
  const operation = await f.prepare();
  await operation.start();
  expect((await operation.read()).snapshot.route).toEqual(route);
});
test("route cannot first appear after worker settlement", async () => {
  const failed = (c: Command) => ({
    ...pending(c),
    resultReady: true,
    settled: true,
    result: { error: "probe_failed" },
  });
  const f = await fixture([failed, (c) => ({ ...failed(c), route })]);
  const operation = await f.prepare();
  await operation.start();
  await expect(operation.read()).rejects.toThrow("regressed");
});

test("descriptor is deeply immutable and read-only recovery retains canonical receipt/key/deadline", async () => {
  const f = await fixture([pending, (c) => observed(c, true)]);
  const descriptor = await f.descriptor();
  expect(Object.isFrozen(descriptor.receipt.slots.frontend.binding.target)).toBe(true);
  expect(Object.isFrozen(descriptor.owner)).toBe(true);
  const stored = JSON.parse(JSON.stringify(descriptor));
  // Journal JSON property order does not change receipt identity.
  stored.receipt = Object.fromEntries(Object.entries(stored.receipt).reverse());
  const resumed = await resumeBattleProbeReadOnly(
    settings,
    f.clock,
    stored,
    undefined,
    f.dependencies,
  );
  expect("start" in resumed).toBe(false);
  expect(resumed.key).toBe(descriptor.key);
  expect(resumed.deadline).toEqual(descriptor.deadline);
  const first = await resumed.read();
  const again = await resumeBattleProbeReadOnly(
    settings,
    f.clock,
    descriptor,
    first.snapshot,
    f.dependencies,
  );
  expect((await again.read()).snapshot.settled).toBe(true);
  expect(f.calls.filter((call) => call.path.endsWith("/clock"))).toHaveLength(1);
  const reads = f.calls.filter((call) => call.path.endsWith("/read"));
  expect(reads.map((call) => (call.body as Command).key)).toEqual([descriptor.key, descriptor.key]);
  expect(f.calls.some((call) => call.path.endsWith("/start"))).toBe(false);
});

test("read-only recovery rejects invalid descriptor and snapshot before transport", async () => {
  const f = await fixture();
  const descriptor = await f.descriptor();
  for (const invalid of [
    { ...descriptor, key: "0".repeat(32) },
    { ...descriptor, generation: "foreign" },
    { ...descriptor, deadline: { ...descriptor.deadline, domain: `mono-${"f".repeat(32)}` } },
    { ...descriptor, unexpected: true },
  ])
    await expect(
      resumeBattleProbeReadOnly(settings, f.clock, invalid, undefined, f.dependencies),
    ).rejects.toThrow();
  await expect(
    resumeBattleProbeReadOnly(settings, f.clock, descriptor, null, f.dependencies),
  ).rejects.toThrow();
  expect(f.calls).toHaveLength(2);
});

test("recovery rejects authenticated changed receipt without issuing reads", async () => {
  let changed = false;
  const f = await fixture([], () => {
    const result = receipt();
    if (changed) result.slots.frontend.binding.target.localIP = "192.0.2.99";
    return result;
  });
  const descriptor = await f.descriptor();
  changed = true;
  await expect(
    resumeBattleProbeReadOnly(settings, f.clock, descriptor, undefined, f.dependencies),
  ).rejects.toThrow("receipt changed");
  expect(f.calls).toHaveLength(3);
});

test("recovered saved result cannot regress on a signed read", async () => {
  const f = await fixture([pending]);
  const descriptor = await f.descriptor();
  const prior = observed(
    { version: 2, command: "read", binding: wire, service: "frontend", key: descriptor.key },
    true,
  );
  const resumed = await resumeBattleProbeReadOnly(
    settings,
    f.clock,
    descriptor,
    prior,
    f.dependencies,
  );
  await expect(resumed.read()).rejects.toThrow("regressed");
});

test("trusted journal recovery still rejects an unauthenticated resolve response", async () => {
  const f = await fixture();
  const descriptor = await f.descriptor();
  const transport = f.dependencies.transport;
  if (!transport) throw new Error("fixture transport required");
  await expect(
    resumeBattleProbeReadOnly(settings, f.clock, descriptor, undefined, {
      ...f.dependencies,
      transport: async (url, init) => {
        const response = await transport(url, init);
        response.headers.set("X-Simulator-Clock-MAC", "0".repeat(64));
        return response;
      },
    }),
  ).rejects.toThrow();
  expect(f.calls).toHaveLength(3);
});
