import { expect, test } from "bun:test";
import { battleOwnerKey, resolveBattleBinding } from "../simulator-battle-binding";
import type { OwnedSimulatorClock } from "../simulator-clock-bootstrap";

const owner = {
  eventId: "大会",
  teamId: "team-é",
  jobId: "job",
  unitHash: "a".repeat(64),
  deployedAt: 1700000000123,
  stackId: "stack",
  instanceId: "i-123",
};
const origin = "http://127.0.0.1:12345";
const domain = `mono-${"a".repeat(32)}`;
const handle = "b".repeat(64);
const lease = { id: "lease-one", incarnation: "e".repeat(64) };
const wire = {
  owner: "c".repeat(64),
  deployment: "d".repeat(64),
  lease: "e".repeat(64),
  backendIncarnation: "f".repeat(64),
};
function mapping(slot: "frontend" | "api") {
  const path: "/" | "/healthz" = slot === "frontend" ? "/" : "/healthz";
  const port = slot === "frontend" ? 80 : 8080;
  return {
    wireBinding: { ...wire },
    service: { name: slot, port, path },
    binding: {
      owner: { ...owner },
      lease: { ...lease },
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
    version: 1 as const,
    handle,
    clockDomain: domain,
    binding: {
      owner: { ...owner },
      lease: { ...lease },
      endpoints: {
        frontend: `${origin}/_simulator/v1/battle-capabilities/${handle}/frontend`,
        api: `${origin}/_simulator/v1/battle-capabilities/${handle}/api`,
      },
    },
    slots: { frontend: mapping("frontend"), api: mapping("api") },
  };
}
function fixture(value = receipt(), endpoint = origin) {
  const requests: string[] = [];
  let authenticated = 0;
  let nonce = "";
  const body = new TextEncoder().encode(JSON.stringify(value));
  const clock: OwnedSimulatorClock = {
    domain,
    authenticateSample: () => {
      throw new Error("No clock sample expected");
    },
    authenticateResponse: (r) => {
      authenticated++;
      expect(r.path).toBe("/_simulator/v1/battle-capabilities/resolve");
      expect(r.nonce).toBe(nonce);
      expect(r.domain).toBe(domain);
      expect(r.status).toBe(200);
      expect(r.body).toEqual(body);
      expect(JSON.parse(new TextDecoder().decode(r.request))).toEqual({
        version: 1,
        owner,
        key: battleOwnerKey(owner),
      });
    },
  };
  const run = () =>
    resolveBattleBinding(
      { endpoint, region: "ap-northeast-1", readToken: () => "operator".repeat(8) },
      clock,
      owner,
      {
        now: () => 1,
        transport: async (url, init) => {
          requests.push(url.pathname);
          expect(init.method).toBe("POST");
          nonce = new Headers(init.headers).get("X-Simulator-Clock-Nonce") ?? "";
          expect(nonce).toMatch(/^[a-f0-9]{64}$/u);
          return new Response(body, {
            headers: {
              "X-Simulator-Clock-Domain": domain,
              "X-Simulator-Clock-MAC": "1".repeat(64),
            },
          });
        },
      },
    );
  return { run, requests, authenticated: () => authenticated };
}
test("owner correlation key uses UTF-8 byte lengths and Go field order", () => {
  expect(battleOwnerKey(owner)).toBe(
    "fbf45b28e46676b342b04126efe7d8155232a1a0ae77a76543f3e50118758706",
  );
  expect(battleOwnerKey({ ...owner, eventId: owner.teamId, teamId: owner.eventId })).not.toBe(
    battleOwnerKey(owner),
  );
});
test("valid two-slot receipt is resolved once but does not qualify scoring", async () => {
  const f = fixture();
  const result = await f.run();
  expect(result.receipt).toEqual(receipt());
  expect(result.scoringQualified).toBe(false);
  expect(result.battleAcceptancePassed).toBe(false);
  expect(f.requests).toEqual(["/_simulator/v1/battle-capabilities/resolve"]);
  expect(f.authenticated()).toBe(1);
});
const mutations: [string, (r: ReturnType<typeof receipt>) => void][] = [
  [
    "foreign owner",
    (r) => {
      r.binding.owner.teamId = "foreign";
    },
  ],
  [
    "foreign clock",
    (r) => {
      r.clockDomain = "foreign";
    },
  ],
  [
    "slot owner",
    (r) => {
      r.slots.api.binding.owner.jobId = "foreign";
    },
  ],
  [
    "lease",
    (r) => {
      r.slots.api.binding.lease.incarnation = "foreign";
    },
  ],
  [
    "slot",
    (r) => {
      r.slots.api.binding.slot = "frontend";
    },
  ],
  [
    "backend",
    (r) => {
      r.slots.api.binding.backendIncarnation = "1".repeat(64);
    },
  ],
  [
    "port",
    (r) => {
      r.slots.api.service.port = 80;
    },
  ],
  [
    "path",
    (r) => {
      r.slots.api.binding.target.path = "/";
    },
  ],
  [
    "service path",
    (r) => {
      r.slots.frontend.service.path = "/healthz";
    },
  ],
  [
    "foreign locator",
    (r) => {
      r.binding.endpoints.api = "http://example.com/api";
    },
  ],
  [
    "zero wire",
    (r) => {
      r.slots.api.wireBinding.owner = "0".repeat(64);
    },
  ],
  [
    "split wire",
    (r) => {
      r.slots.api.wireBinding.deployment = "1".repeat(64);
    },
  ],
];
for (const [label, mutate] of mutations) {
  test(`reject inconsistent ${label} after one authenticated resolve only`, async () => {
    const value = receipt();
    mutate(value);
    const f = fixture(value);
    await expect(f.run()).rejects.toThrow();
    expect(f.requests).toEqual(["/_simulator/v1/battle-capabilities/resolve"]);
    expect(f.authenticated()).toBe(1);
  });
}
test("foreign operator endpoint is rejected before transport", async () => {
  const f = fixture(receipt(), "http://example.com:12345");
  await expect(f.run()).rejects.toThrow("Owned numeric loopback");
  expect(f.requests).toHaveLength(0);
  expect(f.authenticated()).toBe(0);
});

test("owner key rejects UTF-8 oversized and invalid surrogate text", () => {
  expect(() => battleOwnerKey({ ...owner, eventId: "大".repeat(342) })).toThrow();
  expect(() => battleOwnerKey({ ...owner, eventId: "\ud800" })).toThrow();
});

test("consistent all-zero wire authority cannot pass even when both slot bindings agree", async () => {
  const value = receipt();
  const zero = "0".repeat(64);
  value.binding.lease.incarnation = zero;
  for (const slot of ["frontend", "api"] as const) {
    value.slots[slot].wireBinding = {
      owner: zero,
      deployment: zero,
      lease: zero,
      backendIncarnation: zero,
    };
    value.slots[slot].binding.lease.incarnation = zero;
    value.slots[slot].binding.backendIncarnation = zero;
  }
  const f = fixture(value);
  await expect(f.run()).rejects.toThrow();
  expect(f.requests).toEqual(["/_simulator/v1/battle-capabilities/resolve"]);
  expect(f.authenticated()).toBe(1);
});
