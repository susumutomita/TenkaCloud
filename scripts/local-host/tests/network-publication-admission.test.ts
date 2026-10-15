import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import type { LocalComposeUnit, StartedContainer } from "../container/container-runner";
import type { NetworkSubnets } from "../docker-networks";
import type { LocalNetworkPlan } from "../local-network";
import { requiredNetworkValue } from "../local-network";
import type { Context, Job } from "../model";
import type { VpnIngress } from "../vpn/native-backend";
import { networkEngineFixture } from "./network-engine-fixture";
import { plan as vpnPlan } from "./vpn-kernel-fixture";

type Fixture = ReturnType<typeof networkEngineFixture>;

function context(f: Fixture, teamId: string): Context {
  return {
    event: f.store.event("event"),
    team: f.store.team(teamId),
    jobs: f.store.jobs("event", teamId),
    now: 1000,
  };
}

function publishedIds(f: Fixture, jobId: string): unknown {
  return JSON.parse(requiredNetworkValue(f.store.job(jobId).unit)).publishedServiceIds;
}

function halt(f: Fixture, job: Job, unit: LocalComposeUnit): Promise<void> {
  const run = Reflect.get(f.engine, "haltGuardedUnit") as (
    job: Job,
    unit: LocalComposeUnit,
    error: unknown,
  ) => Promise<never>;
  return run.call(f.engine, job, unit, new Error("Synthetic guard drift")).catch(() => undefined);
}

/** A retained runtime of another event, planned for that event's own network generation. */
function foreignRuntime(f: Fixture, name: string): Job {
  const { unit } = f.add(name);
  const job: Job = { ...f.store.job(name), eventId: "other-event", unit: null };
  const plan = Reflect.get(f.engine, "plan") as (
    job: Job,
    verifySources: boolean,
    subnets: NetworkSubnets,
  ) => { started: StartedContainer; composeText: string };
  const prepared = plan.call(f.engine, job, false, requiredNetworkValue(unit.networkSubnets));
  writeFileSync(prepared.started.unit.composePath, prepared.composeText, { mode: 0o600 });
  job.unit = JSON.stringify(prepared.started.unit);
  f.store.putJob(job);
  return job;
}

test("an unrelated event's unconfirmed halt cannot block this event's publication", async () => {
  const f = networkEngineFixture();
  const { job, admitted } = f.add("publisher", 2);
  await admitted;
  const foreign = foreignRuntime(f, "historical");
  const foreignUnit = JSON.parse(requiredNetworkValue(foreign.unit)) as LocalComposeUnit;
  f.engine.bindNetworkState({
    jobs: () => f.store.jobs(),
    retain: (updates) => {
      for (const update of updates) f.store.putJob({ ...f.store.job(update.jobId), ...update });
    },
  });
  f.guard.stopOwned = async (plan: LocalNetworkPlan) => {
    if (plan.project === foreignUnit.composeProjectName)
      throw new Error("Synthetic persistent Docker failure");
  };
  await halt(f, foreign, foreignUnit);
  expect(f.store.job(foreign.jobId).status).toBe("FAILED");
  try {
    await f.engine.publishNetworkService(context(f, "publisher"), job.problemId, "public-1", false);
    expect(publishedIds(f, job.jobId)).toEqual(["public-0"]);
  } finally {
    await f.close();
  }
});

test("a publication queued before a guard halt cannot change the halted runtime's ledger", async () => {
  const f = networkEngineFixture();
  const { job, unit, admitted } = f.add("halted-publisher", 2);
  await admitted;
  let open: () => void = () => undefined;
  Reflect.set(
    f.engine,
    "publicMutation",
    new Promise<void>((resolve) => {
      open = resolve;
    }),
  );
  const request = f.engine.publishNetworkService(
    context(f, "halted-publisher"),
    job.problemId,
    "public-1",
    false,
  );
  try {
    await halt(f, job, unit);
    expect(f.store.job(job.jobId).status).toBe("STOPPED");
    open();
    await expect(request).rejects.toMatchObject({ status: 409 });
    expect(publishedIds(f, job.jobId)).toEqual(["public-0", "public-1"]);
  } finally {
    open();
    await request.catch(() => undefined);
    await f.close();
  }
});

test("VPN ingress is sealed before the first publication policy mutation", async () => {
  const f = networkEngineFixture();
  const { job, admitted } = f.add("vpn-publisher", 2);
  await admitted;
  const ingress: VpnIngress = {
    plan: vpnPlan,
    seal: () => {
      f.calls.push("vpn-seal");
    },
    validate: () => undefined,
    reconcile: async () => {
      f.calls.push("vpn-reconcile");
    },
    authorize: () => undefined,
  };
  f.engine.bindVpnIngress(ingress);
  f.calls.length = 0;
  try {
    await f.engine.publishNetworkService(
      context(f, "vpn-publisher"),
      job.problemId,
      "public-1",
      false,
    );
    const mutation = f.calls.indexOf("update");
    expect(mutation).toBeGreaterThan(-1);
    expect(f.calls.slice(0, mutation)).toContain("vpn-seal");
    expect(f.calls.at(-1)).toBe("vpn-reconcile");
  } finally {
    await f.close();
  }
});
