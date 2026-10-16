import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { networkEngineFixture } from "./network-engine-fixture";

for (const stopFails of [false, true])
  test(`Compose stop failure ${stopFails ? "retains retry tracking" : "confirms owned shutdown"}`, async () => {
    const f = networkEngineFixture();
    const { job, unit, admitted } = f.add(`pause-failure-${stopFails}`, 1);
    await admitted;
    const composition = readFileSync(unit.composePath, "utf8");
    const stopError = new Error("Compose stop failed");
    Reflect.set(f.engine, "runCompose", async () => {
      throw stopError;
    });
    let unavailable = stopFails;
    f.guard.stopOwned = async () => {
      f.calls.push("stop-owned");
      if (unavailable) throw new Error("Docker shutdown unavailable");
    };
    try {
      const failure = await f.engine.pause(job).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toContain(stopError);
      expect(f.calls).toContain("quarantine");
      expect(f.calls).toContain("stop-owned");
      expect(f.calls.indexOf("quarantine")).toBeLessThan(f.calls.indexOf("stop-owned"));
      expect(f.engine.terminalSupported(job)).toBe(false);
      expect(f.store.job(job.jobId).status).toBe(stopFails ? "FAILED" : "STOPPED");
      expect(f.store.job(job.jobId).unit).toBeTruthy();
      expect(readFileSync(unit.composePath, "utf8")).toBe(composition);
      expect(existsSync(unit.composePath)).toBe(true);
      expect(f.calls.includes("reset")).toBe(!stopFails);
      expect(f.calls).not.toContain("remove");
      f.calls.length = 0;
      unavailable = false;
      await f.engine.auditNetworks();
      await f.engine.drainNetworkChecks();
      expect(f.calls.includes("stop-owned")).toBe(stopFails);
      expect(f.store.job(job.jobId).status).toBe("STOPPED");
      f.calls.length = 0;
      await f.engine.auditNetworks();
      await f.engine.drainNetworkChecks();
      expect(f.calls).toEqual([]);
    } finally {
      await f.close();
    }
  });

test("successful pause withdraws publications without emergency shutdown", async () => {
  const f = networkEngineFixture();
  const { job, admitted } = f.add("pause-success", 1);
  await admitted;
  Reflect.set(f.engine, "runCompose", async (_unit: unknown, action: string) => {
    f.calls.push(`compose-${action}`);
  });
  try {
    await f.engine.pause(job);
    expect(f.calls).toContain("compose-stop");
    expect(f.calls).not.toContain("quarantine");
    expect(f.calls).not.toContain("stop-owned");
    expect(f.calls).not.toContain("remove");
    expect(f.engine.terminalSupported(job)).toBe(false);
    expect(f.store.job(job.jobId).unit).toBeTruthy();
  } finally {
    await f.close();
  }
});

test("publication withdrawal failure also retains unconfirmed shutdown for retry", async () => {
  const f = networkEngineFixture();
  const { job, admitted } = f.add("pause-withdraw-failure", 1);
  await admitted;
  const withdrawalError = new Error("Publication withdrawal unavailable");
  Reflect.set(f.engine, "withdrawRuntimePublications", async () => {
    throw withdrawalError;
  });
  f.guard.stopOwned = async () => {
    throw new Error("Docker shutdown unavailable");
  };
  try {
    const failure = await f.engine.pause(job).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toContain(withdrawalError);
    expect(f.calls).toContain("quarantine");
    expect(f.calls).not.toContain("reset");
    expect(f.store.job(job.jobId).status).toBe("FAILED");
    expect(f.store.job(job.jobId).unit).toBeTruthy();
    f.guard.stopOwned = async () => {
      f.calls.push("stop-owned-retry");
    };
    await f.engine.auditNetworks();
    await f.engine.drainNetworkChecks();
    expect(f.calls).toContain("stop-owned-retry");
    expect(f.store.job(job.jobId).status).toBe("STOPPED");
  } finally {
    await f.close();
  }
});
