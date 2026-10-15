import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { DockerHostingEngine } from "../docker-engine";
import type { LocalNetworkGuard } from "../linux-network-guard";
import { localNetworkPlan, requiredNetworkValue } from "../local-network";
import type { Job } from "../model";
import { HostStore } from "../store";

// Real engine and durable SQLite; injected transports never touch Docker or host rules.
for (const failStop of [false, true])
  test(`guard drift revokes admission and durably records ${failStop ? "FAILED" : "STOPPED"}`, async () => {
    const calls: string[] = [];
    const noop = () => undefined;
    const guard: LocalNetworkGuard = {
      stopOwned: async () => {
        calls.push("stop");
        if (failStop) throw new Error("Synthetic stop failure");
      },
      preflight: noop,
      install: noop,
      verify: noop,
      remove: noop,
      update: noop,
      occupiedRoutes: () => [],
      endpoints: () => [],
      routePublications: noop,
      verifyNetworks: () => {
        throw new Error("Synthetic changed rule order");
      },
      quarantine: () => {
        calls.push("quarantine");
      },
      resetStopped: () => {
        calls.push("reset");
      },
    };
    const engine = new DockerHostingEngine(
      fileURLToPath(new URL("../../../", import.meta.url)),
      "/virtual-fixture/unused-network-failure",
      undefined,
      false,
      guard,
      async (_unit, action) => {
        calls.push(action);
        if (failStop) throw new Error("Synthetic stop failure");
      },
    );
    const problem = requiredNetworkValue(engine.catalog()[0]);
    const definition = JSON.parse(problem.definition) as {
      problem: { challengeEndpoints: Record<string, string> };
      composeText: string;
    };
    const job: Job = {
      jobId: "failure-test",
      eventId: "event",
      teamId: "team",
      problemId: problem.problemId,
      definition: problem.definition,
      offset: 0,
      status: "COMPLETE",
      networkIsolationVersion: 1,
      unit: null,
    };
    // eslint-disable-next-line sonarjs/no-hardcoded-ip -- synthetic plan, no network operation
    const subnets = { default: "10.240.0.0/28" };
    const plan = localNetworkPlan("tch-failure-test", subnets, {
      composeText: definition.composeText,
      definition: job.definition,
      eventId: job.eventId,
    });
    const unit = {
      problemId: job.problemId,
      offset: 0,
      composePath: "/virtual-fixture/unused-compose.yml",
      composeProjectName: plan.project,
      secretEnv: [],
      projectDirectory: "/virtual-fixture",
      remappedComposePath: "/virtual-fixture/unused-compose.yml",
      networkSubnets: subnets,
      isolationVersion: 1,
      isolationGeneration: plan.generation,
    };
    job.unit = JSON.stringify(unit);
    const store = new HostStore(new Database(":memory:"));
    store.putEvent({
      eventId: job.eventId,
      name: "Failure fixture",
      status: "READY",
      createdAt: "2026-10-14",
      updatedAt: "2026-10-14",
      expiresAt: 1,
      scoringLocked: false,
      scoreboardFreezeMinutes: 0,
      problems: [problem],
    });
    store.putTeam({
      teamId: job.teamId,
      eventId: job.eventId,
      internalSlug: "team",
      displayName: "team",
      loginKey: "synthetic",
      snapshot: null,
      score: 0,
      completedProblems: 0,
      scoreEvents: [],
    });
    store.putJob(job);
    engine.bindNetworkState({
      jobs: () => store.jobs(job.eventId),
      retain: (updates) => {
        for (const update of updates) store.putJob({ ...store.job(update.jobId), ...update });
      },
    });
    const running = Reflect.get(engine, "running") as Map<string, unknown>;
    const admit = Reflect.get(engine, "admitRunning") as (job: Job, started: unknown) => void;
    admit.call(engine, job, { unit, problem: definition.problem });
    try {
      const proof = Reflect.get(engine, "guardProofs") as Map<string, { attemptedAt: number }>;
      const entry = requiredNetworkValue(proof.get(job.jobId));
      entry.attemptedAt = 0;
      engine.terminalSupported(job);
      await engine.drainNetworkChecks();
      for (let attempt = 0; attempt < 20 && store.job(job.jobId).status === "COMPLETE"; attempt++)
        await new Promise((resolve) => setTimeout(resolve, 1));
      expect(running.has(job.jobId)).toBe(false);
      expect(store.job(job.jobId).status).toBe(failStop ? "FAILED" : "STOPPED");
      expect(store.job(job.jobId).error).toContain(
        failStop ? "could not be confirmed" : "requires verified recovery",
      );
      expect(calls).toEqual(failStop ? ["quarantine", "stop"] : ["quarantine", "stop", "reset"]);
    } finally {
      store.close();
    }
  });

test("partial isolated startup quarantines before failed teardown and retains ownership even when quarantine fails", async () => {
  for (const failQuarantine of [false, true]) {
    const calls: string[] = [];
    const noop = () => undefined;
    const guard: LocalNetworkGuard = {
      stopOwned: async () => {
        throw new Error("Unexpected owned stop");
      },
      preflight: noop,
      install: noop,
      verify: noop,
      verifyNetworks: noop,
      occupiedRoutes: () => [],
      endpoints: () => [],
      update: noop,
      routePublications: noop,
      resetStopped: noop,
      remove: () => {
        throw new Error("must not discard live ownership");
      },
      quarantine: () => {
        calls.push("quarantine");
        if (failQuarantine) throw new Error("Synthetic family failure");
      },
    };
    const engine = new DockerHostingEngine(
      fileURLToPath(new URL("../../../", import.meta.url)),
      "/virtual-fixture/failed-start",
      undefined,
      true,
      guard,
      async (_unit, action) => {
        calls.push(action);
        throw new Error("Synthetic teardown failure");
      },
    );
    // eslint-disable-next-line sonarjs/no-hardcoded-ip -- synthetic guard scope only, no connection
    const plan = localNetworkPlan("tch-partial-start", { default: "10.240.0.0/28" });
    const unit = {
      problemId: "problem",
      offset: 0,
      composePath: "/virtual-fixture/compose.yml",
      composeProjectName: plan.project,
      secretEnv: [],
      projectDirectory: "/virtual-fixture",
      remappedComposePath: "/virtual-fixture/compose.yml",
    };
    const job: Job = {
      jobId: "partial-start",
      teamId: "team",
      eventId: "event",
      problemId: "problem",
      definition: "{}",
      offset: 0,
      status: "PENDING",
      unit: JSON.stringify(unit),
    };
    const running = Reflect.get(engine, "running") as Map<string, unknown>;
    running.set(job.jobId, { unit });
    const ownership = job.unit;
    const cleanup = Reflect.get(engine, "cleanupFailedStart") as (
      job: Job,
      owned: {
        unit: typeof unit;
        guarded: typeof plan;
        environment: NodeJS.ProcessEnv;
        retain: (unit: string | null) => void;
      },
      error: unknown,
    ) => Promise<never>;
    await expect(
      cleanup.call(
        engine,
        job,
        {
          unit,
          guarded: plan,
          environment: {},
          retain: () => {
            throw new Error("must retain ownership");
          },
        },
        new Error("Unsafe admission after partial up"),
      ),
    ).rejects.toThrow();
    expect(calls).toEqual(["quarantine", "down"]);
    expect(running.has(job.jobId)).toBe(false);
    expect(job.unit).toBe(ownership);
  }
});
