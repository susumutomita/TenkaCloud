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
  expect(workerDeadline("publish", withRoutes(10), withRoutes(0))).toBe(23_000);
  expect(workerDeadline("publish", withRoutes(0), withRoutes(256))).toBe(45_600);
  expect(workerDeadline("publish", withRoutes(256), withRoutes(256))).toBe(120_000);
});
