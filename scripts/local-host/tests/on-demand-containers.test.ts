import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { boundedCompose } from "../container-budget";
import { type DockerDefinition, loadDockerCatalog } from "../docker-catalog";
import { DockerHostingEngine } from "../docker-engine";
import type { Context, Job } from "../model";
import { type ApiRequest, HostingService } from "../service";
import { HostStore } from "../store";
import { bootstrapOrganizer } from "./organizer-fixture";

const root = fileURLToPath(new URL("../../../", import.meta.url));
class SyntheticContainers extends DockerHostingEngine {
  readonly retained = new Map<string, { progress: number; running: boolean }>();
  readonly calls = {
    start: [] as string[],
    resume: [] as string[],
    pause: [] as string[],
    remove: [] as string[],
  };
  failResume = false;
  override catalog() {
    return super.catalog().slice(0, 20);
  }
  override async start(job: Job, retain: (unit: string | null) => void) {
    this.calls.start.push(job.jobId);
    retain(JSON.stringify({ jobId: job.jobId }));
    this.retained.set(job.jobId, { progress: 7, running: true });
  }
  override async pause(job: Job) {
    this.calls.pause.push(job.jobId);
    const state = this.retained.get(job.jobId);
    if (state) state.running = false;
  }
  override async resume(job: Job) {
    this.calls.resume.push(job.jobId);
    if (this.failResume) throw new Error("Synthetic resume failure");
    const state = this.retained.get(job.jobId);
    if (!state) throw new Error("Missing synthetic runtime");
    state.running = true;
  }
  override async recover(job: Job) {
    if (!this.retained.has(job.jobId)) throw new Error("Missing synthetic runtime");
  }
  override async stop(job: Job) {
    this.calls.remove.push(job.jobId);
    this.retained.delete(job.jobId);
  }
  override async view(context: Context) {
    return {
      problems: context.event.problems.map((problem) => ({
        problemId: problem.problemId,
        instructions: "Synthetic lifecycle",
        scoring: { kind: "flag", points: 100 },
        stackOutputs: {},
      })),
    };
  }
}
function request(method: string, path: string, token: string, body: unknown = {}): ApiRequest {
  return { method, path, token, body, query: new URLSearchParams() };
}
async function fixture(
  run: (f: {
    service: HostingService;
    store: HostStore;
    engine: SyntheticContainers;
    eventId: string;
    teams: { teamId: string; teamLoginKey: string }[];
    admin: string;
  }) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), "tenka-demand-"));
  const store = new HostStore(new Database(":memory:"));
  const engine = new SyntheticContainers(root, directory);
  const service = new HostingService(store, engine, "synthetic-host-key");
  service.containerLimits = { perTeam: 3, global: 5, memoryMiB: 65_536 };
  service.gatewayPorts = { start: 5200, end: 5239 };
  const admin = await bootstrapOrganizer(service, "synthetic-host-key");
  try {
    const created = await service.admin(
      request("POST", "/events", admin, {
        name: "20 exercises × 5 teams",
        teams: Array.from({ length: 5 }, (_, i) => ({ internalSlug: `team-${i}` })),
        problems: engine.catalog().map((problem) => ({ problemId: problem.problemId })),
      }),
    );
    const event = created.body as {
      eventId: string;
      teams: { teamId: string; teamLoginKey: string }[];
    };
    expect(created.status).toBe(201);
    expect(
      (await service.admin(request("POST", `/events/${event.eventId}/deploy`, admin))).status,
    ).toBe(202);
    await service.drain();
    await service.admin(
      request("PATCH", `/events/${event.eventId}/schedule`, admin, { startNow: true }),
    );
    await run({ service, store, engine, ...event, admin });
  } finally {
    await service.drain();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("20×5 deployment allocates 100 isolated dormant jobs without launching 100 runtimes", async () => {
  await fixture(async (f) => {
    const catalog = await f.service.admin(request("GET", "/host/catalog", f.admin));
    expect((catalog.body as { limits: unknown }).limits).toEqual({
      maxTeams: 40,
      maxEventJobs: 512,
    });
    const jobs = f.store.jobs(f.eventId);
    expect(jobs).toHaveLength(100);
    expect(
      jobs.every(
        (job) =>
          job.status === "STOPPED" &&
          job.unit === null &&
          job.runtimePorts !== undefined &&
          job.gatewaySlot === undefined,
      ),
    ).toBe(true);
    const ports = jobs.flatMap((job) => Object.values(job.runtimePorts ?? {}));
    expect(new Set(ports).size).toBe(ports.length);
    expect(ports.length).toBeLessThan(400);
    expect(f.engine.calls.start).toEqual([]);
    expect(f.store.event(f.eventId).status).toBe("READY");
    await f.service.recover();
    expect(f.engine.calls.start).toEqual([]);
    expect(f.store.jobs(f.eventId).every((job) => job.status === "STOPPED")).toBe(true);
  });
});

test("per-team/global limits serialize starts; stop/resume preserves progress, ports and generation", async () => {
  await fixture(async (f) => {
    const a = f.teams[0],
      b = f.teams[1];
    if (!a || !b) throw new Error("Expected teams");
    const jobs = f.store.jobs(f.eventId, a.teamId);
    const action = (job: Job, verb: string, key = a.teamLoginKey) =>
      f.service.participant(
        request("POST", `/portal/me/problems/${job.problemId}/container/${verb}`, key),
      );
    for (const job of jobs.slice(0, 3)) {
      expect((await action(job, "start")).status).toBe(202);
      await f.service.drain();
    }
    const first = jobs[0],
      fourth = jobs[3];
    if (!first || !fourth) throw new Error("Expected jobs");
    await expect(action(fourth, "start")).rejects.toMatchObject({ kind: "team_container_limit" });
    const before = f.store.job(first.jobId);
    expect((await action(first, "stop")).status).toBe(202);
    await f.service.drain();
    expect(f.store.job(first.jobId)).toMatchObject({
      status: "STOPPED",
      unit: before.unit,
      runtimePorts: before.runtimePorts,
      deployedAt: before.deployedAt,
    });
    expect(f.store.job(first.jobId).gatewaySlot).toBeUndefined();
    expect(f.engine.retained.get(first.jobId)?.progress).toBe(7);
    await action(first, "start");
    await f.service.drain();
    expect(f.store.job(first.jobId)).toMatchObject({
      status: "COMPLETE",
      unit: before.unit,
      runtimePorts: before.runtimePorts,
      deployedAt: before.deployedAt,
    });
    expect(f.engine.calls.resume).toEqual([first.jobId]);
    const other = f.store.jobs(f.eventId, b.teamId);
    for (const job of other.slice(0, 2)) {
      await action(job, "start", b.teamLoginKey);
      await f.service.drain();
    }
    if (!other[2]) throw new Error("Expected third job");
    await expect(action(other[2], "start", b.teamLoginKey)).rejects.toMatchObject({
      kind: "host_container_limit",
    });
    expect(f.engine.calls.remove).toEqual([]);
    expect(f.engine.calls.pause).toEqual([first.jobId]);
    await expect(
      f.service.participant(
        request("POST", `/portal/me/problems/${first.problemId}/container/start`, a.teamLoginKey, {
          teamId: b.teamId,
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});

test("memory budget and failed resumes preserve owned state; administrative restart cannot bypass limits", async () => {
  await fixture(async (f) => {
    const team = f.teams[0];
    if (!team) throw new Error("Expected team");
    const job = f.store.jobs(f.eventId, team.teamId)[0];
    if (!job) throw new Error("Expected job");
    const action = (verb: string) =>
      f.service.participant(
        request(
          "POST",
          `/portal/me/problems/${job.problemId}/container/${verb}`,
          team.teamLoginKey,
        ),
      );
    f.service.containerLimits = { perTeam: 3, global: 5, memoryMiB: 1 };
    await expect(action("start")).rejects.toMatchObject({ kind: "host_container_memory_limit" });
    await expect(
      f.service.admin(
        request("POST", `/events/${f.eventId}/deployments/${job.jobId}/restart`, f.admin),
      ),
    ).rejects.toMatchObject({ kind: "host_container_memory_limit" });
    f.service.containerLimits = { perTeam: 3, global: 5, memoryMiB: 65_536 };
    await action("start");
    await f.service.drain();
    await action("stop");
    await f.service.drain();
    const before = f.store.job(job.jobId);
    f.engine.failResume = true;
    await action("start");
    await f.service.drain();
    expect(f.store.job(job.jobId)).toMatchObject({
      status: "FAILED",
      unit: before.unit,
      runtimePorts: before.runtimePorts,
      deployedAt: before.deployedAt,
    });
    f.engine.failResume = false;
    await action("start");
    await f.service.drain();
    expect(f.store.job(job.jobId).status).toBe("COMPLETE");
    expect(f.engine.retained.get(job.jobId)?.progress).toBe(7);
    expect(f.engine.calls.start).toEqual([job.jobId]);
    expect(f.engine.calls.remove).toEqual([]);
  });
});

test("every catalog Compose plan receives bounded missing resources without changing authored memory caps", () => {
  for (const problem of loadDockerCatalog(root)) {
    const definition = JSON.parse(problem.definition) as DockerDefinition;
    const result = boundedCompose(definition.composeText);
    expect(result.cost.services).toBeGreaterThan(0);
    expect(result.cost.memoryMiB).toBeGreaterThan(0);
    expect(result.text).toContain("mem_limit:");
    expect(result.text).toContain("cpus:");
    expect(result.text).toContain("pids_limit:");
  }
});
