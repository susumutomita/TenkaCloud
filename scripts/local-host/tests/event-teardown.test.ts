import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { id } from "../auth";
import { apiRequest } from "../bench/state-setup";
import type { HostedEvent, Job, Team } from "../model";
import { HostingService } from "../service";
import { HostStore } from "../store";
import { ExerciseFixture } from "./exercise-fixture";
import { bootstrapOrganizer } from "./organizer-fixture";

async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup();
  try {
    await run(f);
  } finally {
    await f.service.drain();
    f.store.close();
  }
}

async function setup() {
  const store = new HostStore(new Database(":memory:"));
  const engine = new ExerciseFixture((path) => new Database(path));
  const calls = { stop: 0, recover: 0 };
  const controls = { failStop: false, wait: Promise.resolve() };
  engine.stop = async () => {
    calls.stop++;
    await controls.wait;
    if (controls.failStop) throw new Error("Synthetic cleanup failure; ownership retained.");
  };
  engine.recover = async () => {
    calls.recover++;
  };
  const event: HostedEvent = {
    eventId: id(),
    name: "Disposable teardown test",
    status: "READY",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    scoringLocked: false,
    scoreboardFreezeMinutes: 0,
    problems: [...engine.catalog()],
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
  const problem = engine.catalog()[0];
  if (!problem) throw new Error("Expected synthetic catalog problem.");
  const job: Job = {
    jobId: id(),
    eventId: event.eventId,
    teamId: team.teamId,
    problemId: "sqli-demo",
    definition: problem.definition,
    offset: 0,
    status: "COMPLETE",
    unit: JSON.stringify({ syntheticOwner: team.teamId }),
  };
  store.putEvent(event);
  store.putTeam(team);
  store.putJob(job);
  const service = new HostingService(store, engine, "synthetic-host-key");
  const admin = await bootstrapOrganizer(service, "synthetic-host-key");
  const request = (method: string, path = `/events/${event.eventId}`) =>
    service.admin(apiRequest({ method, path, token: admin }));
  const detail = async () =>
    (await request("GET")).body as { status: string; teardownStatus?: string };
  return { store, service, event, team, job, calls, controls, request, detail };
}

test("teardown follows active cleanup to confirmed completion and keeps archival separate", async () => {
  await fixture(async (f) => {
    let finish: () => void = () => {
      throw new Error("Stop gate was not initialized.");
    };
    f.controls.wait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    expect((await f.detail()).teardownStatus).toBeUndefined();
    expect((await f.request("DELETE")).status).toBe(202);
    try {
      expect(await f.detail()).toMatchObject({ status: "TEARDOWN", teardownStatus: "in_progress" });
      await expect(f.request("DELETE")).rejects.toMatchObject({ status: 409 });
    } finally {
      finish();
    }
    await f.service.drain();
    expect(await f.detail()).toMatchObject({ status: "TEARDOWN", teardownStatus: "complete" });
    const list = (await f.request("GET", "/events")).body as {
      items: { teardownStatus: string }[];
    };
    expect(list.items[0]?.teardownStatus).toBe("complete");
    expect(f.store.event(f.event.eventId)).not.toHaveProperty("teardownStatus");
    await expect(f.request("DELETE")).rejects.toMatchObject({ status: 409 });
    expect(f.calls.stop).toBe(1);
    expect(f.store.team(f.team.teamId).score).toBe(17);
    expect((await f.request("POST", `/events/${f.event.eventId}/archive`)).status).toBe(200);
    expect(await f.detail()).toMatchObject({ status: "ARCHIVED" });
  });
});

test("failed cleanup and recovered surviving runtimes remain incomplete until a successful retry", async () => {
  await fixture(async (f) => {
    f.controls.failStop = true;
    await f.request("DELETE");
    await f.service.drain();
    expect((await f.detail()).teardownStatus).toBe("incomplete");
    expect(f.store.job(f.job.jobId)).toMatchObject({ status: "FAILED", unit: f.job.unit });
    await expect(f.request("POST", `/events/${f.event.eventId}/archive`)).rejects.toMatchObject({
      status: 409,
    });
    await f.service.recover();
    expect(f.store.job(f.job.jobId).status).toBe("COMPLETE");
    expect((await f.detail()).teardownStatus).toBe("incomplete");
    f.controls.failStop = false;
    await f.request("DELETE");
    await f.service.drain();
    expect((await f.detail()).teardownStatus).toBe("complete");
    expect(f.calls.stop).toBe(2);
  });
});

test("interrupted cleanup is not active work or completion and recovery confirms removal", async () => {
  await fixture(async (f) => {
    f.store.putEvent({ ...f.event, status: "TEARDOWN" });
    f.store.putJob({ ...f.job, status: "DELETING" });
    expect((await f.detail()).teardownStatus).toBe("incomplete");
    await f.service.recover();
    expect((await f.detail()).teardownStatus).toBe("complete");
    expect(f.calls.stop).toBe(1);
    f.store.putJob({ ...f.job, status: "DELETED" });
    expect((await f.detail()).teardownStatus).toBe("incomplete");
    f.store.putJob({ ...f.job, status: "DELETING", unit: null });
    await f.service.recover();
    expect((await f.detail()).teardownStatus).toBe("complete");
    expect(f.calls.stop).toBe(1);
  });
});
