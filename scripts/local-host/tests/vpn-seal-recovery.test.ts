/* eslint-disable sonarjs/no-hardcoded-ip -- No network operations: fake command port captures policy writes. */
import { expect, test } from "bun:test";
import type { VpnCommand } from "../vpn/native-backend";
import { vpnPeerPlan } from "../vpn/peer-plan";
import { fixture, plan, registration } from "./vpn-kernel-fixture";

const team = { eventId: "event", teamId: "alpha" };
const failures: Record<string, (call: VpnCommand) => boolean> = {
  "IPv6 restore": (call) => call.command === "ip6tables-restore",
  "IPv6 input chain body after the chain exists": (call) =>
    call.command === "ip6tables-restore" && (call.input ?? "").includes("--dport 5175"),
};
for (const [failure, failing] of Object.entries(failures))
  for (const retry of ["controller backend", "fresh worker backend"] as const)
    test(`a transient ${failure} failure recovers on the next reconciliation (${retry})`, () => {
      const f = fixture();
      f.ingress.seal();
      f.fail(failing);
      expect(() => f.ingress.prepare([])).toThrow("Injected native failure");
      expect(f.sealed()).toBe(true);
      f.fail(() => false);
      f.ingress.seal();
      const proof = (retry === "controller backend" ? f.ingress : f.backend()).prepare([]);
      f.ingress.commit(proof);
      expect(f.sealed()).toBe(false);
      expect(() => f.ingress.authorize("10.251.0.2", team)).not.toThrow();
    });

const rotated = vpnPeerPlan({ ...registration, participantPort: 5176 });
const otherInterfaceSeal = `-A INPUT -i tcwg1 -m comment --comment tc-vpn-seal-v1:${plan.generation} -j DROP`;
function rotatedAfterShutdown() {
  const f = fixture();
  f.ingress.seal();
  f.ingress.commit(f.ingress.prepare([]));
  f.ingress.seal();
  f.tables.get("iptables")?.get("INPUT")?.unshift(otherInterfaceSeal);
  const next = f.backend(rotated);
  next.seal();
  return { f, next, proof: next.prepare([]) };
}
const sealTagged = (f: ReturnType<typeof fixture>, family: string, parent: string) =>
  (f.tables.get(family)?.get(parent) ?? []).filter((rule) => rule.includes("tc-vpn-seal-v1:"));

test("a rotated registration removes this interface's seals retained by the previous generation", () => {
  const { f, next, proof } = rotatedAfterShutdown();
  next.commit(proof);
  const spoof = (parent: string, address: string) =>
    `-A ${parent} -s ${address} ! -i tcwg0 -m comment --comment tc-vpn-seal-v1:${rotated.generation} -j DROP`;
  expect(sealTagged(f, "iptables", "INPUT")).toEqual([
    spoof("INPUT", "10.251.0.2"),
    otherInterfaceSeal,
  ]);
  expect(sealTagged(f, "iptables", "FORWARD")).toEqual([spoof("FORWARD", "10.251.0.2")]);
  expect(sealTagged(f, "ip6tables", "INPUT")).toEqual([spoof("INPUT", "fd55::2")]);
  expect(sealTagged(f, "ip6tables", "FORWARD")).toEqual([spoof("FORWARD", "fd55::2")]);
  expect(() => next.authorize("10.251.0.2", team)).not.toThrow();
});

test("a failed stale seal removal re-seals the new generation and withholds its identity proof", () => {
  const { f, next, proof } = rotatedAfterShutdown();
  f.fail(
    (call) => call.args[2] === "-D" && call.args.includes(`tc-vpn-seal-v1:${plan.generation}`),
  );
  expect(() => next.commit(proof)).toThrow("Injected native failure");
  for (const family of ["iptables", "ip6tables"])
    expect(sealTagged(f, family, "INPUT")).toContain(
      `-A INPUT -i tcwg0 -m comment --comment tc-vpn-seal-v1:${rotated.generation} -j DROP`,
    );
  expect(() => next.authorize("10.251.0.2", team)).toThrow();
});
