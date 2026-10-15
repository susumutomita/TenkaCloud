/* eslint-disable sonarjs/no-hardcoded-ip -- No network operations: fake command port captures policy writes. */
import { expect, test } from "bun:test";
import { type VpnPeerPlan, vpnPeerPlan } from "../vpn/peer-plan";
import { type FakeKernel, fixture, mutates, plan, registration } from "./vpn-kernel-fixture";

const lanPeer = vpnPeerPlan({
  ...registration,
  peers: registration.peers.map((peer) => ({ ...peer, ipv4: "192.168.1.50" })),
});
const overlaps: {
  name: string;
  config: VpnPeerPlan;
  host: (kernel: FakeKernel) => void;
  error: string;
}[] = [
  {
    name: "a peer inside a LAN subnet",
    config: lanPeer,
    host: () => undefined,
    error: "VPN identity 192.168.1.50 overlaps host network 192.168.1.10/24 on eth0",
  },
  {
    name: "an exact host route for a peer on another device",
    config: plan,
    host: (kernel) =>
      kernel.routes[4].push({ dst: "10.251.0.2", gateway: "192.168.1.1", dev: "eth0" }),
    error: "VPN identity 10.251.0.2 overlaps host network 10.251.0.2 on eth0",
  },
  {
    name: "an IPv6 route covering the server identity",
    config: plan,
    host: (kernel) => kernel.routes[6].push({ dst: "fd55::/64", gateway: "fe80::1", dev: "eth0" }),
    error: "VPN identity fd55::1 overlaps host network fd55::/64 on eth0",
  },
  {
    name: "a deviceless blackhole route",
    config: plan,
    host: (kernel) => kernel.routes[4].push({ type: "blackhole", dst: "10.251.0.0/24" }),
    error: "VPN identity 10.251.0.1 overlaps host network 10.251.0.0/24 on no device",
  },
];
for (const overlap of overlaps)
  test(`preparation rejects ${overlap.name} before any firewall mutation`, () => {
    const f = fixture(overlap.config);
    overlap.host(f.kernel);
    f.ingress.seal();
    const before = f.calls.length;
    expect(() => f.ingress.prepare([])).toThrow(
      `${overlap.error}; register a dedicated VPN allocation.`,
    );
    expect(f.calls.slice(before).filter(mutates)).toEqual([]);
    expect(f.replies).toEqual([]);
    expect(f.sealed()).toBe(true);
  });
