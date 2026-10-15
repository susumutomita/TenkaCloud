/* eslint-disable sonarjs/no-hardcoded-ip -- Pure policy fixtures only; these tests never open a socket or mutate a route. */
import { describe, expect, test } from "bun:test";
import { localNetworkPlan, requiredNetworkValue, sharedNetworkPlan } from "../local-network";
import { type VpnRuntimeAdmission, vpnForwardPolicy, vpnLeaseTimeout } from "../vpn/forward-policy";
import { assertVpnTeamPeer, vpnPeerProof } from "../vpn/peer-admission";
import { assertVpnPeerInventory, vpnPeerPlan } from "../vpn/peer-plan";

const key = (byte: number) => Buffer.alloc(32, byte).toString("base64");
function registration() {
  return {
    version: 1,
    interface: "tcwg0",
    serverPublicKey: key(1),
    serverIpv4: "10.251.0.1",
    serverIpv6: "fd55::1",
    participantPort: 5175,
    peers: [
      { publicKey: key(2), eventId: "event", teamId: "alpha", ipv4: "10.251.0.2", ipv6: "fd55::2" },
      { publicKey: key(3), eventId: "event", teamId: "beta", ipv4: "10.251.0.3", ipv6: "fd55::3" },
      { publicKey: key(4), eventId: "other", teamId: "alpha", ipv4: "10.251.0.4", ipv6: "fd55::4" },
    ],
  };
}
function runtime(
  name: string,
  teamId: string,
  ipv4: string,
  verifiedAt = 1000,
): VpnRuntimeAdmission {
  const plan = localNetworkPlan(
    `tch-${name}`,
    { default: ipv4 },
    {
      composeText: "services:\n  web:\n    networks: [default]\n",
      definition: name,
      eventId: "event",
    },
  );
  return {
    jobId: name,
    eventId: "event",
    teamId,
    plan,
    unitGeneration: plan.generation,
    verifiedAt,
  };
}
const text = (rules: readonly (readonly string[])[]) =>
  rules.map((rule) => rule.join(" ")).join("\n");

describe("VPN public peer identity", () => {
  test("canonical registration is immutable and insensitive to peer order", () => {
    const raw = registration();
    const first = vpnPeerPlan(raw);
    raw.peers.reverse();
    expect(vpnPeerPlan(raw).generation).toBe(first.generation);
    expect(Object.isFrozen(first.peers)).toBe(true);
    expect(Object.isFrozen(first.peers[0])).toBe(true);
  });
  test("rejects secret fields, inherited fields, missing fields and noncanonical keys", () => {
    expect(() => vpnPeerPlan({ ...registration(), privateKey: key(9) })).toThrow();
    expect(() => vpnPeerPlan(Object.create(registration()))).toThrow();
    expect(() => vpnPeerPlan({ ...registration(), serverPublicKey: key(0) })).toThrow();
    const raw = registration();
    delete (raw.peers[0] as Partial<(typeof raw.peers)[0]>).teamId;
    expect(() => vpnPeerPlan(raw)).toThrow();
  });
  test("rejects duplicate address/key and public or scoped addresses", () => {
    for (const mutation of [
      (raw: ReturnType<typeof registration>) => {
        requiredNetworkValue(raw.peers[1]).ipv4 = requiredNetworkValue(raw.peers[0]).ipv4;
      },
      (raw: ReturnType<typeof registration>) => {
        requiredNetworkValue(raw.peers[1]).publicKey = raw.serverPublicKey;
      },
      (raw: ReturnType<typeof registration>) => {
        requiredNetworkValue(raw.peers[0]).ipv4 = "8.8.8.8";
      },
      (raw: ReturnType<typeof registration>) => {
        requiredNetworkValue(raw.peers[0]).ipv6 = "fd55::2%eth0";
      },
    ]) {
      const raw = registration();
      mutation(raw);
      expect(() => vpnPeerPlan(raw)).toThrow();
    }
  });
  test("requires exact cryptokey routes for every registered peer", () => {
    const plan = vpnPeerPlan(registration());
    const inventory = {
      interface: plan.interface,
      kind: "wireguard",
      publicKey: plan.serverPublicKey,
      peers: plan.peers.map((peer) => ({
        publicKey: peer.publicKey,
        allowedIps: [`${peer.ipv4}/32`, `${peer.ipv6}/128`],
      })),
    };
    expect(() => assertVpnPeerInventory(plan, inventory)).not.toThrow();
    for (const bad of ["10.251.0.0/24", "10.251.0.2/32/24", "10.251.0.3/32"]) {
      const changed = structuredClone(inventory);
      requiredNetworkValue(changed.peers[0]).allowedIps[0] = bad;
      expect(() => assertVpnPeerInventory(plan, changed)).toThrow();
    }
    expect(() =>
      assertVpnPeerInventory(plan, { ...inventory, peers: inventory.peers.slice(1) }),
    ).toThrow();
  });
});

describe("VPN forwarding admission compiler", () => {
  test("empty/restarted controller admits no forwarding in either family", () => {
    const policy = vpnForwardPolicy(vpnPeerPlan(registration()), [], 1000);
    expect(policy.leases).toHaveLength(0);
    for (const rules of [policy.ipv4, policy.ipv6]) {
      expect(text(rules)).not.toContain("ACCEPT");
      expect(rules.at(-1)).toEqual(["-j", "DROP"]);
    }
  });
  test("own private access binds event/team, original tuple and both bridge directions", () => {
    const own = runtime("one", "alpha", "10.240.0.0/28");
    const peer = runtime("two", "beta", "10.240.0.16/28");
    const policy = vpnForwardPolicy(vpnPeerPlan(registration()), [own, peer], 1000);
    const rules = policy.ipv4.filter((rule) => rule.includes("ACCEPT"));
    expect(rules).toHaveLength(4);
    const ownRules = rules.filter((rule) => rule.includes("10.251.0.2"));
    expect(ownRules).toHaveLength(2);
    for (const rule of ownRules) {
      expect(rule).toContain(requiredNetworkValue(own.plan.segments[0]).bridge);
      expect(rule).not.toContain(requiredNetworkValue(peer.plan.segments[0]).bridge);
      expect(rule).toContain("--ctorigsrc");
      expect(rule).toContain("--ctorigdst");
      expect(rule).toContain("--match-set");
    }
    expect(text(rules)).not.toContain("10.251.0.4");
    expect(text(rules)).not.toContain("RELATED");
    expect(policy.ipv4.at(-1)).toEqual(["-j", "DROP"]);
  });
  test("leases expire with the older proof, never produce permanent timeout zero", () => {
    const own = runtime("one", "alpha", "10.240.0.0/28");
    const config = vpnPeerPlan(registration());
    expect(
      vpnForwardPolicy(config, [own], 60_000).leases.every(
        (lease) => vpnLeaseTimeout(lease, 60_000) === 1,
      ),
    ).toBe(true);
    expect(vpnForwardPolicy(config, [own], 60_001).leases).toHaveLength(0);
    expect(vpnForwardPolicy(config, [own], 61_000).leases).toHaveLength(0);
    expect(() => vpnForwardPolicy(config, [own], 999)).toThrow();
    const stalePlan = vpnForwardPolicy(config, [own], 1000);
    const lease = requiredNetworkValue(stalePlan.leases[0]);
    expect(vpnLeaseTimeout(lease, 31_000)).toBe(30);
    expect(vpnLeaseTimeout(lease, 60_001)).toBeUndefined();
    expect(vpnLeaseTimeout(lease, 61_000)).toBeUndefined();
    expect(vpnLeaseTimeout(lease, 0)).toBeUndefined();
    expect(vpnLeaseTimeout(lease, 999)).toBeUndefined();
  });
  test("only explicit public endpoint/port permits another team; withdrawal removes it", () => {
    const own = runtime("one", "alpha", "10.240.0.0/28");
    const publisher = runtime("two", "beta", "10.240.0.16/28", 500);
    const segment = requiredNetworkValue(publisher.plan.segments[0]);
    const exposed = {
      ...own,
      plan: sharedNetworkPlan(own.plan, [
        {
          plan: publisher.plan,
          endpoints: [{ service: "web", segment, addresses: ["10.240.0.18"], port: 8080 }],
        },
      ]),
    };
    const policy = vpnForwardPolicy(vpnPeerPlan(registration()), [exposed, publisher], 1000);
    const grants = policy.ipv4.filter(
      (rule) => rule.includes("ACCEPT") && rule.includes("10.240.0.18"),
    );
    expect(grants).toHaveLength(2);
    for (const rule of grants) {
      expect(rule).toContain("tcp");
      expect(rule).toContain("--ctorigdstport");
      expect(rule).toContain("8080");
      expect(rule).toContain(segment.bridge);
    }
    expect(
      policy.leases.some(
        (lease) => lease.owners.length === 2 && vpnLeaseTimeout(lease, 1000) === 59,
      ),
    ).toBe(true);
    const withdrawn = vpnForwardPolicy(vpnPeerPlan(registration()), [own, publisher], 1000);
    expect(text(withdrawn.ipv4)).not.toContain("10.240.0.18");
    const expired = vpnForwardPolicy(vpnPeerPlan(registration()), [exposed, publisher], 60_500);
    expect(text(expired.ipv4)).not.toContain("10.240.0.18");
  });
  test("opposite public directions have distinct leases for different requesters", () => {
    const one = runtime("one", "alpha", "10.240.0.0/28");
    const two = runtime("two", "beta", "10.240.0.16/28");
    const publish = (
      source: VpnRuntimeAdmission,
      target: VpnRuntimeAdmission,
      address: string,
    ) => ({
      ...source,
      plan: sharedNetworkPlan(source.plan, [
        {
          plan: target.plan,
          endpoints: [
            {
              service: "web",
              segment: requiredNetworkValue(target.plan.segments[0]),
              addresses: [address],
              port: 8080,
            },
          ],
        },
      ]),
    });
    const policy = vpnForwardPolicy(
      vpnPeerPlan(registration()),
      [publish(one, two, "10.240.0.18"), publish(two, one, "10.240.0.2")],
      1000,
    );
    const publicLeases = policy.leases.filter((lease) => lease.owners.length === 2);
    expect(publicLeases).toHaveLength(2);
    expect(new Set(publicLeases.map((lease) => lease.name)).size).toBe(2);
  });
  test("rejects overlay overlap, changed generation and duplicate owned project", () => {
    const own = runtime("one", "alpha", "10.240.0.0/28");
    const config = vpnPeerPlan(registration());
    expect(() => vpnForwardPolicy(config, [{ ...own, unitGeneration: "changed" }], 1000)).toThrow();
    expect(() => vpnForwardPolicy(config, [own, own], 1000)).toThrow();
    const overlap = runtime("overlap", "alpha", "10.251.0.0/28");
    expect(() => vpnForwardPolicy(config, [overlap], 1000)).toThrow();
  });
});

describe("VPN peer versus authenticated participant", () => {
  const config = vpnPeerPlan(registration());
  const inventory = {
    interface: config.interface,
    kind: "wireguard",
    publicKey: config.serverPublicKey,
    peers: config.peers.map((peer) => ({
      publicKey: peer.publicKey,
      allowedIps: [`${peer.ipv4}/32`, `${peer.ipv6}/128`],
    })),
  };
  test("both native socket families map to the same team", () => {
    const proof = vpnPeerProof(config, inventory, 1000);
    for (const address of ["10.251.0.2", "::ffff:10.251.0.2", "fd55::2", "FD55:0:0:0:0:0:0:2"])
      expect(() =>
        assertVpnTeamPeer(config, proof, address, { eventId: "event", teamId: "alpha" }, 1000),
      ).not.toThrow();
  });
  test("another valid team key cannot cross a peer or event boundary", () => {
    const proof = vpnPeerProof(config, inventory, 1000);
    for (const [address, eventId, teamId] of [
      ["10.251.0.2", "event", "beta"],
      ["10.251.0.4", "event", "alpha"],
      ["127.0.0.1", "event", "alpha"],
      ["fd55::2%eth0", "event", "alpha"],
    ])
      expect(() =>
        assertVpnTeamPeer(
          config,
          proof,
          requiredNetworkValue(address),
          { eventId: requiredNetworkValue(eventId), teamId: requiredNetworkValue(teamId) },
          1000,
        ),
      ).toThrow();
  });
  test("restarted, stale, changed registration and clock rollback reject admission", () => {
    const proof = vpnPeerProof(config, inventory, 1000);
    const auth = { eventId: "event", teamId: "alpha" };
    expect(() => assertVpnTeamPeer(config, undefined, "10.251.0.2", auth, 1000)).toThrow();
    expect(() => assertVpnTeamPeer(config, proof, "10.251.0.2", auth, 61_000)).toThrow();
    expect(() => assertVpnTeamPeer(config, proof, "10.251.0.2", auth, 999)).toThrow();
    expect(() =>
      assertVpnTeamPeer({ ...config, generation: "changed" }, proof, "10.251.0.2", auth, 1000),
    ).toThrow();
    expect(() => vpnPeerProof(config, { ...inventory, peers: [] }, 1000)).toThrow();
  });
});

test("VPN native rule budget is bounded before applying any peer grant", () => {
  const raw = registration();
  raw.peers = Array.from({ length: 100 }, (_, index) => ({
    publicKey: key(index + 2),
    eventId: "event",
    teamId: "alpha",
    ipv4: `10.251.0.${index + 2}`,
    ipv6: `fd55::${(index + 2).toString(16)}`,
  }));
  const config = vpnPeerPlan(raw);
  const runtimes = Array.from({ length: 12 }, (_, index) =>
    runtime(`job-${index}`, "alpha", `10.240.0.${index * 16}/28`),
  );
  expect(() => vpnForwardPolicy(config, runtimes, 1000)).toThrow("VPN rule budget exceeded");
});
