/* eslint-disable sonarjs/no-hardcoded-ip -- No network operations: fake command port captures policy writes. */
import { expect, test } from "bun:test";
import { NativeVpnBackend } from "../vpn/native-backend";
import { fixture, plan } from "./vpn-kernel-fixture";

test("native ingress has no side effects on construction and boot seal is idempotent", () => {
  const f = fixture();
  expect(f.calls).toHaveLength(0);
  f.ingress.seal();
  f.ingress.seal();
  expect(f.sealed()).toBe(true);
  for (const table of f.tables.values())
    expect(table.get("FORWARD")?.filter((line) => line.includes("tc-vpn-seal-v1:"))).toHaveLength(
      2,
    );
  expect(() => f.ingress.authorize("10.251.0.2", { eventId: "event", teamId: "alpha" })).toThrow();
});
test("empty runtime recovery admits only registered portal traffic with finite kernel leases", () => {
  const f = fixture();
  f.ingress.seal();
  f.ingress.commit(f.ingress.prepare([]));
  expect(f.sealed()).toBe(false);
  expect(() =>
    f.ingress.authorize("10.251.0.2", { eventId: "event", teamId: "alpha" }),
  ).not.toThrow();
  expect(() => f.ingress.authorize("10.251.0.2", { eventId: "event", teamId: "beta" })).toThrow();
  const adds = f.calls.filter((call) => call.command === "ipset" && call.args[0] === "add");
  expect(adds).toHaveLength(2);
  for (const add of adds) expect(add.args.slice(-3)).toEqual(["timeout", "55", "-exist"]);
  const restores = f.calls.filter((call) => call.command.endsWith("-restore"));
  expect(
    restores.filter(
      (call) => call.input?.includes("--dport 5175") && call.input.includes("--match-set"),
    ),
  ).toHaveLength(2);
  expect(
    restores.filter((call) => call.input?.includes("_F ") && call.input.includes("ACCEPT")),
  ).toHaveLength(0);
});
test("partial IPv6 install failure retains dual-stack seal and rejects application identity", () => {
  const f = fixture();
  f.ingress.seal();
  f.fail("ip6tables-restore");
  expect(() => f.ingress.commit(f.ingress.prepare([]))).toThrow();
  expect(f.sealed()).toBe(true);
  expect(() => f.ingress.authorize("10.251.0.2", { eventId: "event", teamId: "alpha" })).toThrow();
});
test("restarted controller stays closed until owned types are verified and old grants are discarded", () => {
  const f = fixture();
  f.ingress.seal();
  f.ingress.commit(f.ingress.prepare([]));
  const restarted = new NativeVpnBackend(plan, f.io);
  restarted.seal();
  expect(f.sealed()).toBe(true);
  restarted.commit(restarted.prepare([]));
  expect(f.sealed()).toBe(false);
  expect(
    f.calls.filter((call) => call.command === "ipset" && call.args[0] === "flush"),
  ).toHaveLength(2);
});

test("packet suspension preserves verified peer identity so periodic audit does not close healthy terminals", () => {
  const f = fixture();
  f.ingress.seal();
  f.ingress.commit(f.ingress.prepare([]));
  f.ingress.suspend();
  expect(f.sealed()).toBe(true);
  expect(() =>
    f.ingress.authorize("10.251.0.2", { eventId: "event", teamId: "alpha" }),
  ).not.toThrow();
  f.ingress.seal();
  expect(() => f.ingress.authorize("10.251.0.2", { eventId: "event", teamId: "alpha" })).toThrow();
});

test("a quarantine-looking ACCEPT comment cannot remain ahead of the emergency seal", () => {
  for (const family of ["iptables", "ip6tables"]) {
    const f = fixture();
    f.ingress.seal();
    f.tables
      .get(family)
      ?.get("INPUT")
      ?.unshift(`-A INPUT -m comment --comment tc-quarantine-v1:${"a".repeat(64)} -j ACCEPT`);
    f.ingress.seal();
    expect(f.tables.get(family)?.get("INPUT")?.[0]).toContain("-i tcwg0");
    expect(f.tables.get(family)?.get("INPUT")?.[0]).toEndWith("-j DROP");
  }
});

test("preparation rejects admission displaced by a forged closure comment before any mutation", () => {
  for (const marker of ["tc-quarantine-v1:", "tc-vpn-seal-v1:"]) {
    const f = fixture();
    f.ingress.seal();
    f.tables
      .get("iptables")
      ?.get("INPUT")
      ?.unshift(`-A INPUT -m comment --comment ${marker}${"a".repeat(64)} -j ACCEPT`);
    const before = f.calls.length;
    expect(() => f.ingress.prepare([])).toThrow("leading dual-stack seal");
    expect(f.calls.slice(before).every((call) => call.args.includes("-S"))).toBe(true);
  }
});
