import { expect, test } from "bun:test";
import { requiredNetworkValue } from "../local-network";
import type { Context } from "../model";
import { networkEngineFixture } from "./network-engine-fixture";

type Fixture = ReturnType<typeof networkEngineFixture>;

function context(f: Fixture, teamId: string): Context {
  return {
    event: f.store.event("event"),
    team: f.store.team(teamId),
    jobs: f.store.jobs("event", teamId),
    now: 1000,
  };
}

async function publisherWithStoppedService(f: Fixture, auditFails: boolean) {
  const { job, admitted } = f.add("stopped-service", 2);
  await admitted;
  await f.engine.publishNetworkService(context(f, job.teamId), job.problemId, "public-1", false);
  f.guard.endpoints = () => [];
  if (auditFails)
    f.guard.audit = async () => {
      throw new Error("Synthetic changed rule order");
    };
  f.calls.length = 0;
  return job;
}

test("publishing a stopped service is refused without halting the publisher or changing its ledger", async () => {
  const f = networkEngineFixture();
  const job = await publisherWithStoppedService(f, false);
  try {
    await expect(
      f.engine.publishNetworkService(context(f, job.teamId), job.problemId, "public-1", true),
    ).rejects.toMatchObject({ status: 409 });
    const retained = f.store.job(job.jobId);
    expect(retained.status).toBe("COMPLETE");
    expect(JSON.parse(requiredNetworkValue(retained.unit)).publishedServiceIds).toEqual([
      "public-0",
    ]);
    expect(f.calls.filter((call) => ["quarantine", "stop-owned"].includes(call))).toEqual([]);
    expect(f.engine.terminalSupported(job)).toBe(true);
  } finally {
    await f.close();
  }
});

test("a refused publication whose guard audit also fails still quarantines the publisher", async () => {
  const f = networkEngineFixture();
  const job = await publisherWithStoppedService(f, true);
  try {
    await expect(
      f.engine.publishNetworkService(context(f, job.teamId), job.problemId, "public-1", true),
    ).rejects.toThrow();
    const retained = f.store.job(job.jobId);
    expect(retained.status).toBe("STOPPED");
    expect(JSON.parse(requiredNetworkValue(retained.unit)).publishedServiceIds).toEqual([
      "public-0",
    ]);
    expect(f.calls.filter((call) => ["quarantine", "stop-owned"].includes(call))).toEqual([
      "quarantine",
      "stop-owned",
    ]);
  } finally {
    await f.close();
  }
});
