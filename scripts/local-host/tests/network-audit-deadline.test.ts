import { expect, test } from "bun:test";
import { type LocalNetworkPlan, localNetworkPlan, requiredNetworkValue } from "../local-network";
import { workerDeadline } from "../network-audit";

// eslint-disable-next-line sonarjs/no-hardcoded-ip -- synthetic allocation; no worker or connection
const base = localNetworkPlan("tch-deadline-fixture", { dmz: "10.244.0.0/28" });
function withRoutes(count: number): LocalNetworkPlan {
  const segment = requiredNetworkValue(base.segments[0]);
  const route = {
    service: "web",
    from: segment,
    to: segment,
    // eslint-disable-next-line sonarjs/no-hardcoded-ip -- synthetic workload address; no connection
    address: "10.244.0.2",
    port: 8080,
    publisherProject: "tch-deadline-publisher",
    publisherOwner: base.owner,
    fromProject: base.project,
    fromOwner: base.owner,
  };
  return { ...base, publicRoutes: Array.from({ length: count }, () => route) };
}

test("worker deadlines grow with the admitted route budget and stop at an explicit bound", () => {
  expect(workerDeadline("vpn-prepare")).toBe(20_000);
  expect(workerDeadline("verify", withRoutes(0))).toBe(20_000);
  expect(workerDeadline("verify", withRoutes(256))).toBe(45_600);
  expect(workerDeadline("publish", withRoutes(10), { previous: withRoutes(0) })).toBe(23_000);
  expect(workerDeadline("publish", withRoutes(0), { previous: withRoutes(256) })).toBe(45_600);
  expect(workerDeadline("publish", withRoutes(256), { previous: withRoutes(256) })).toBe(120_000);
});

test("VPN preparation deadlines grow with every admitted runtime and its routes up to the same bound", () => {
  const runtimes = (count: number, routes: number) =>
    Array.from({ length: count }, () => ({ plan: withRoutes(routes) }));
  expect(workerDeadline("vpn-prepare", undefined, { runtimes: [] })).toBe(20_000);
  expect(workerDeadline("vpn-prepare", undefined, { runtimes: runtimes(4, 0) })).toBe(40_000);
  expect(workerDeadline("vpn-prepare", undefined, { runtimes: runtimes(2, 10) })).toBe(32_000);
  expect(workerDeadline("vpn-prepare", undefined, { runtimes: runtimes(40, 0) })).toBe(120_000);
});

/* eslint-disable sonarjs/no-hardcoded-ip -- Synthetic deadline input; no connections. */
test("worker deadlines count egress routes and segments for audits, publication and VPN preparation", () => {
  const segment = { ...requiredNetworkValue(base.segments[0]), service: "web" };
  const plan = {
    ...base,
    egressSegments: [segment],
    egressRoutes: [
      { requestId: "upstream", service: "web", segment, address: "8.8.8.8", port: 443 },
    ],
  };
  expect(workerDeadline("verify", plan)).toBe(20_200);
  expect(workerDeadline("publish", plan, { previous: plan })).toBe(20_800);
  expect(workerDeadline("vpn-prepare", undefined, { runtimes: [{ plan }] })).toBe(25_200);
});

/* eslint-enable sonarjs/no-hardcoded-ip */
