import { expect, test } from "bun:test";
import { fixture, mutates, plan } from "./vpn-kernel-fixture";

type Fixture = ReturnType<typeof fixture>;
const interfaceSeal = (parent: string, direction: string) =>
  `-A ${parent} ${direction} tcwg0 -m comment --comment tc-vpn-seal-v1:${plan.generation} -j DROP`;
const parents = [
  ["INPUT", ["-i"]],
  ["FORWARD", ["-i", "-o"]],
] as const;
function admittedAheadOfSeal(f: Fixture): string[] {
  return ["iptables", "ip6tables"].flatMap((family) =>
    parents.flatMap(([parent, directions]) => {
      const rules = f.tables.get(family)?.get(parent) ?? [];
      const seals = directions.map((direction) => rules.indexOf(interfaceSeal(parent, direction)));
      if (seals.includes(-1)) return [`${family} ${parent} lost its interface seal`];
      return rules
        .slice(0, Math.max(...seals))
        .filter((rule) => !rule.endsWith(" -j DROP"))
        .map((rule) => `${family} ${rule}`);
    }),
  );
}
const scenarios: Record<string, (f: Fixture) => void> = {
  "first preparation": (f) => f.ingress.seal(),
  "resealed committed generation": (f) => {
    f.ingress.seal();
    f.ingress.commit(f.ingress.prepare([]));
    f.ingress.seal();
  },
};
for (const [scenario, setup] of Object.entries(scenarios))
  test(`only drops precede the interface seal until commit, whichever step fails (${scenario})`, () => {
    const probe = fixture();
    setup(probe);
    const start = probe.calls.length;
    probe.ingress.prepare([]);
    const steps = probe.calls.slice(start).filter(mutates).length;
    expect(steps).toBeGreaterThan(10);
    const violations: string[] = [];
    for (let step = 0; step <= steps; step++) {
      const f = fixture();
      setup(f);
      let seen = 0;
      f.fail((call) => mutates(call) && seen++ === step);
      if (step < steps) expect(() => f.ingress.prepare([])).toThrow("Injected native failure");
      else f.ingress.prepare([]);
      violations.push(...admittedAheadOfSeal(f).map((entry) => `step ${step}: ${entry}`));
    }
    expect(violations).toEqual([]);
  });

test("re-preparing a generation keeps one anti-spoof drop per peer in each family and parent", () => {
  const f = fixture();
  for (let round = 0; round < 3; round++) {
    f.ingress.seal();
    f.ingress.commit(f.ingress.prepare([]));
  }
  const spoofDrops = Object.fromEntries(
    ["iptables", "ip6tables"].flatMap((family) =>
      ["INPUT", "FORWARD"].map((parent) => [
        `${family} ${parent}`,
        (f.tables.get(family)?.get(parent) ?? []).filter(
          (rule) => rule.includes(` -s `) && rule.includes(`tc-vpn-seal-v1:${plan.generation}`),
        ).length,
      ]),
    ),
  );
  expect(spoofDrops).toEqual({
    "iptables INPUT": 1,
    "iptables FORWARD": 1,
    "ip6tables INPUT": 1,
    "ip6tables FORWARD": 1,
  });
});
