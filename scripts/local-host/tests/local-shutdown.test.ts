import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { id } from "../auth";
import type { HostedEvent, Job, RuntimeEngine, Team } from "../model";
import { HostingService } from "../service";
import { HostStore } from "../store";

function fixture() {
  const store = new HostStore(new Database(":memory:"));
  const calls = {
    starts: [] as string[],
    stops: [] as string[],
    pauses: [] as string[],
    resumes: [] as string[],
  };
  const failures = { pause: false, resume: false };
  const unavailable = async (): Promise<never> => {
    throw new Error("Unexpected gameplay call.");
  };
  const engine: RuntimeEngine = {
    catalog: () => [],
    start: async (job) => {
      calls.starts.push(job.jobId);
    },
    stop: async (job) => {
      calls.stops.push(job.jobId);
    },
    recover: async () => {
      await Promise.resolve();
    },
    pause: async (job) => {
      calls.pauses.push(job.jobId);
      if (failures.pause) throw new Error("Synthetic stop failure.");
    },
    resume: async (job) => {
      calls.resumes.push(job.jobId);
      if (failures.resume) throw new Error("Synthetic resume failure.");
    },
    view: unavailable,
    submit: unavailable,
    hint: unavailable,
    surface: () => {
      throw new Error("Unexpected surface access.");
    },
  };
  const event: HostedEvent = {
    eventId: id(),
    name: "Disposable lifecycle test",
    status: "READY",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startsAt: new Date().toISOString(),
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    scoringLocked: false,
    scoreboardFreezeMinutes: 0,
    problems: [],
  };
  const team: Team = {
    teamId: id(),
    eventId: event.eventId,
    internalSlug: "alpha",
    displayName: "Alpha",
    loginKey: "synthetic-team-key",
    snapshot: null,
    score: 17,
    completedProblems: 0,
    scoreEvents: [],
  };
  store.putEvent(event);
  store.putTeam(team);
  const add = (kind: "compose" | "cloudformation", status: Job["status"] = "COMPLETE") => {
    const job: Job = {
      jobId: id(),
      eventId: event.eventId,
      teamId: team.teamId,
      problemId: id(),
      definition: JSON.stringify(kind === "compose" ? {} : { kind }),
      offset: 0,
      status,
      unit: JSON.stringify({ syntheticOwner: team.teamId }),
      deployedAt: 123,
    };
    store.putJob(job);
    return job;
  };
  const service = () => new HostingService(store, engine, "synthetic-host-key");
  return { store, calls, failures, event, team, add, service };
}

test("managed down stops owned local environments and resumes in place without deleting data", async () => {
  const f = fixture();
  try {
    const local = f.add("compose");
    const manualStop = f.add("compose", "STOPPED");
    const cloud = f.add("cloudformation");
    expect(await f.service().stopLocalEnvironments()).toEqual({ stopped: 1, failed: 0, cloud: 1 });
    expect(f.store.job(local.jobId)).toMatchObject({
      status: "STOPPED",
      unit: local.unit,
      resumeAfterLocalDown: true,
    });
    expect(f.store.job(manualStop.jobId).resumeAfterLocalDown).toBeUndefined();
    expect(f.store.job(cloud.jobId)).toEqual(cloud);
    expect(f.store.team(f.team.teamId)).toEqual(f.team);
    await f.service().recover();
    expect(f.calls.pauses).toEqual([local.jobId]);
    expect(f.calls.resumes).toEqual([local.jobId]);
    expect(f.calls.starts).toEqual([]);
    expect(f.calls.stops).toEqual([]);
    expect(f.store.job(local.jobId)).toMatchObject({
      status: "COMPLETE",
      unit: local.unit,
      deployedAt: 123,
    });
    expect(f.store.job(local.jobId).resumeAfterLocalDown).toBeUndefined();
    expect(f.store.team(f.team.teamId)).toEqual(f.team);
  } finally {
    f.store.close();
  }
});

test("a failed local stop remains owned and resumes without the destructive rebuild path", async () => {
  const f = fixture();
  try {
    const job = f.add("compose");
    f.failures.pause = true;
    expect(await f.service().stopLocalEnvironments()).toEqual({ stopped: 0, failed: 1, cloud: 0 });
    expect(f.store.job(job.jobId)).toMatchObject({
      status: "FAILED",
      unit: job.unit,
      resumeAfterLocalDown: true,
    });
    await f.service().recover();
    expect(f.store.job(job.jobId).status).toBe("COMPLETE");
    expect(f.calls.starts).toEqual([]);
    expect(f.calls.stops).toEqual([]);
  } finally {
    f.store.close();
  }
});

test("interrupted down and failed resume retain ownership until an in-place retry succeeds", async () => {
  const f = fixture();
  try {
    const job = f.add("compose");
    f.store.putJob({ ...job, operation: "stop", resumeAfterLocalDown: true });
    f.failures.resume = true;
    await f.service().recover();
    expect(f.store.job(job.jobId)).toMatchObject({
      status: "FAILED",
      unit: job.unit,
      resumeAfterLocalDown: true,
    });
    f.failures.resume = false;
    await f.service().recover();
    expect(f.store.job(job.jobId)).toMatchObject({ status: "COMPLETE", unit: job.unit });
    expect(f.calls.starts).toEqual([]);
    expect(f.calls.stops).toEqual([]);
  } finally {
    f.store.close();
  }
});

test("finished events are stopped but not automatically started again", async () => {
  const f = fixture();
  try {
    const job = f.add("compose");
    f.store.putEvent({ ...f.event, status: "ENDED", endsAt: new Date().toISOString() });
    expect(await f.service().stopLocalEnvironments()).toEqual({ stopped: 1, failed: 0, cloud: 0 });
    await f.service().recover();
    expect(f.store.job(job.jobId).status).toBe("STOPPED");
    expect(f.calls.resumes).toEqual([]);
  } finally {
    f.store.close();
  }
});
