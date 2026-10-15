import { expect, test } from "bun:test";
import type { LocalNetworkPlan } from "../local-network";
import type { Context } from "../model";
import { networkEngineFixture } from "./network-engine-fixture";

type Fixture = ReturnType<typeof networkEngineFixture>;
const context = (f: Fixture, teamId: string): Context => ({
  event: f.store.event("event"),
  team: f.store.team(teamId),
  jobs: f.store.jobs("event", teamId),
  now: 1000,
});

/** Models the real guard: chain bodies are verified exactly against the plan's routes. */
function exactGuard(f: Fixture) {
  const installed = new Map<string, string>();
  const stale = (plan: LocalNetworkPlan) =>
    installed.has(plan.project) &&
    installed.get(plan.project) !== JSON.stringify(plan.publicRoutes);
  f.guard.update = (plan, previous) => {
    if (stale(previous))
      throw new Error("Competition guard changed; runtime admission is refused.");
    installed.set(plan.project, JSON.stringify(plan.publicRoutes));
  };
  f.guard.audit = async (plan) => {
    f.calls.push("audit");
    if (stale(plan)) throw new Error("Competition guard changed; runtime admission is refused.");
  };
  f.guard.endpoints = (plan, service, port) => {
    if (stale(plan)) throw new Error("Competition guard changed; runtime admission is refused.");
    const segment = plan.segments.find((entry) => plan.services[service]?.includes(entry.name));
    if (!segment) return [];
    const parts = (segment.ipv4.split("/")[0] ?? "").split(".");
    parts[3] = String(Number(parts[3]) + 2);
    return [{ service, segment, addresses: [parts.join(".")], port }];
  };
}

for (const fresh of [true, false])
  test(`publishing a running service from a ${fresh ? "fresh" : "stale"} request context never halts the publisher`, async () => {
    const f = networkEngineFixture();
    exactGuard(f);
    const alpha = f.add("alpha", 2);
    const bravo = f.add("bravo", 2);
    await alpha.admitted;
    await bravo.admitted;
    try {
      await f.engine.publishNetworkService(
        context(f, "alpha"),
        alpha.job.problemId,
        "public-1",
        false,
      );
      await f.engine.publishNetworkService(
        context(f, "bravo"),
        bravo.job.problemId,
        "public-1",
        false,
      );
      const loadedBeforeAlpha = context(f, "bravo");
      await f.engine.publishNetworkService(
        context(f, "alpha"),
        alpha.job.problemId,
        "public-0",
        false,
      );
      await f.engine.publishNetworkService(
        fresh ? context(f, "bravo") : loadedBeforeAlpha,
        bravo.job.problemId,
        "public-1",
        true,
      );
      expect(f.store.job("bravo").status).toBe("COMPLETE");
      expect(
        f.calls.filter((call) => ["quarantine", "stop-owned", "reset"].includes(call)),
      ).toEqual([]);
    } finally {
      await f.close();
    }
  });
