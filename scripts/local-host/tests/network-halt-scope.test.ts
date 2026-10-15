import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import type { LocalComposeUnit } from "../container/container-runner";
import { requiredNetworkValue } from "../local-network";
import { networkEngineFixture } from "./network-engine-fixture";

test("a malformed retained DMZ route cannot prevent quarantine, owned shutdown and stopped reset", async () => {
  const f = networkEngineFixture();
  const { job, unit, admitted } = f.add("malformed-routes");
  await admitted;
  job.unit = JSON.stringify({ ...unit, publicNetworkRoutes: [null] });
  f.store.putJob(job);
  f.calls.length = 0;
  try {
    await expect(f.engine.recover(job)).rejects.toThrow();
    const retained = f.store.job(job.jobId);
    expect(retained.status).toBe("STOPPED");
    expect(JSON.parse(requiredNetworkValue(retained.unit)).publicNetworkRoutes).toEqual([]);
    expect(f.calls.filter((call) => ["quarantine", "stop-owned", "reset"].includes(call))).toEqual([
      "quarantine",
      "stop-owned",
      "reset",
    ]);
  } finally {
    await f.close();
  }
});

test("guard removal that fails after a confirmed Compose down is retried directly", async () => {
  const f = networkEngineFixture();
  const { job, unit, admitted } = f.add("removed-workloads");
  await admitted;
  const compose: string[] = [];
  Reflect.set(f.engine, "runCompose", async (_unit: LocalComposeUnit, action: string) => {
    compose.push(action);
  });
  // A stopped reset proves present owned bridges; after Compose down they are gone.
  f.guard.resetStoppedAsync = async () => {
    throw new Error("Competition bridge is missing or belongs to another runtime.");
  };
  let removals = 0;
  f.guard.remove = () => {
    removals++;
    if (removals === 1) throw new Error("Synthetic transient firewall failure");
  };
  const unconfirmed = Reflect.get(f.engine, "unconfirmedHalts") as Map<string, unknown>;
  try {
    await expect(f.engine.stop(job)).rejects.toThrow();
    expect(unconfirmed.has(job.jobId)).toBe(false);
    expect(f.store.job(job.jobId).status).toBe("FAILED");
    f.calls.length = 0;
    await expect(f.engine.recover(f.store.job(job.jobId))).rejects.toThrow("retry its removal");
    expect(f.calls).not.toContain("quarantine");
    expect(unconfirmed.has(job.jobId)).toBe(false);
    await f.engine.stop(f.store.job(job.jobId));
    expect(removals).toBe(2);
    expect(compose).toEqual(["down"]);
    expect(existsSync(unit.composePath)).toBe(false);
  } finally {
    await f.close();
  }
});
