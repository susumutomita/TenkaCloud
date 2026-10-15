import { expect, test } from "bun:test";
import type { Context } from "../model";
import { networkEngineFixture } from "./network-engine-fixture";

type Fixture = ReturnType<typeof networkEngineFixture>;
const context = (f: Fixture, teamId: string): Context => ({
  event: f.store.event("event"),
  team: f.store.team(teamId),
  jobs: f.store.jobs("event", teamId),
  now: 1000,
});

test("a refused publication whose audit fails while another team's publication moves the policy gets 409, not a halt", async () => {
  const f = networkEngineFixture();
  const alpha = f.add("alpha", 2);
  const bravo = f.add("bravo", 2);
  await alpha.admitted;
  await bravo.admitted;
  try {
    await f.engine.publishNetworkService(
      context(f, "bravo"),
      bravo.job.problemId,
      "public-1",
      false,
    );
    f.guard.endpoints = () => [];
    const epochs = Reflect.get(f.engine, "policyEpochs") as Map<string, number>;
    const original = f.guard.audit;
    let armed = true;
    let concurrent: Promise<void> | undefined;
    const observed = { before: -1, after: -1 };
    f.guard.audit = async (plan) => {
      if (!armed || !plan.project.includes("bravo")) return original?.(plan);
      armed = false;
      const before = epochs.get("event") ?? 0;
      observed.before = before;
      concurrent = f.engine.publishNetworkService(
        context(f, "alpha"),
        alpha.job.problemId,
        "public-1",
        false,
      );
      for (let i = 0; i < 1000 && (epochs.get("event") ?? 0) === before; i++)
        await new Promise((resolve) => setTimeout(resolve, 1));
      observed.after = epochs.get("event") ?? 0;
      throw new Error("Synthetic audit failure observed during the policy move");
    };
    f.calls.length = 0;
    const outcome = await f.engine
      .publishNetworkService(context(f, "bravo"), bravo.job.problemId, "public-1", true)
      .then(
        () => "resolved",
        (error: { status?: number; message?: string }) => `${error.status} ${error.message}`,
      );
    await concurrent;
    expect(observed.after).toBe(observed.before + 1);
    expect(outcome).toBe("409 Competition network policy is changing.");
    expect(f.store.job("bravo").status).toBe("COMPLETE");
    expect(f.calls.filter((call) => ["quarantine", "stop-owned"].includes(call))).toEqual([]);
  } finally {
    await f.close();
  }
});
