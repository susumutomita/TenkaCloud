import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { boundedCompose } from "../container-budget";
import { type DockerDefinition, loadDockerCatalog } from "../docker-catalog";
import { DockerHostingEngine } from "../docker-engine";
import { listen, startHttpHost } from "../http";
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
  readonly evaluations: { jobId: string; submission: string }[] = [];
  afterEvaluate?: () => void;
  override async evaluate(job: Job, submission: string): Promise<boolean> {
    this.evaluations.push({ jobId: job.jobId, submission });
    this.afterEvaluate?.();
    return submission === job.teamId;
  }
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
  return {
    method,
    path,
    token,
    body,
    query: new URLSearchParams(),
    externalEvaluationTrusted: true,
  };
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
  ctfd = false,
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
        ...(ctfd ? { scoringAuthority: "ctfd" } : {}),
        teams: Array.from({ length: 5 }, (_, i) => ({ internalSlug: `team-${i}` })),
        problems: (ctfd
          ? engine
              .catalog()
              .filter(
                (p) =>
                  (JSON.parse(p.definition) as DockerDefinition).problem.scoring.kind === "verify",
              )
              .slice(0, 1)
          : engine.catalog()
        ).map((problem) => ({ problemId: problem.problemId })),
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

test("external evaluation uses only the owned running job and never writes scores or snapshots", async () => {
  await fixture(async (f) => {
    const first = f.teams[0];
    const second = f.teams[1];
    if (!first || !second) throw new Error("Expected two teams");
    const job = f.store.jobs(f.eventId, first.teamId)[0];
    if (!job) throw new Error("Expected job");
    const path = `/portal/me/problems/${job.problemId}/evaluate`;
    const evaluate = (key: string, body: unknown, method = "POST") =>
      f.service.participant(request(method, path, key, body));
    await expect(evaluate(first.teamLoginKey, { submission: first.teamId })).rejects.toMatchObject({
      status: 409,
    });
    await f.service.participant(
      request("POST", `/portal/me/problems/${job.problemId}/container/start`, first.teamLoginKey),
    );
    await f.service.drain();
    const before = JSON.stringify(f.store.team(first.teamId));
    expect((await evaluate(first.teamLoginKey, { submission: first.teamId })).body).toEqual({
      correct: true,
    });
    expect((await evaluate(first.teamLoginKey, { submission: "wrong" })).body).toEqual({
      correct: false,
    });
    expect(JSON.stringify(f.store.team(first.teamId))).toBe(before);
    expect(f.engine.evaluations.map((entry) => entry.jobId)).toEqual([job.jobId, job.jobId]);
    await expect(evaluate(second.teamLoginKey, { submission: first.teamId })).rejects.toMatchObject(
      { status: 409 },
    );
    for (const body of [
      { submission: "answer", teamId: first.teamId },
      { submission: "answer", url: "https://untrusted.invalid/" },
      { submission: "x".repeat(65537) },
      {},
    ])
      await expect(evaluate(first.teamLoginKey, body)).rejects.toMatchObject({ status: 400 });
    await expect(
      evaluate(first.teamLoginKey, { submission: "answer" }, "GET"),
    ).rejects.toMatchObject({ status: 400 });
    await expect(evaluate("invalid-key", { submission: "answer" })).rejects.toMatchObject({
      status: 401,
    });
    const queryRequest = request("POST", path, first.teamLoginKey, { submission: "answer" });
    queryRequest.query.set("teamId", first.teamId);
    await expect(f.service.participant(queryRequest)).rejects.toMatchObject({ status: 400 });
    await f.service.admin(request("POST", `/events/${f.eventId}/lock-scoring`, f.admin));
    await expect(evaluate(first.teamLoginKey, { submission: first.teamId })).rejects.toMatchObject({
      kind: "scoring_locked",
    });
    expect(f.engine.evaluations).toHaveLength(2);
  }, true);
});

test("one problem's view issues only that environment's link and reports link failures", async () => {
  await fixture(async (f) => {
    const team = f.teams[0];
    if (!team) throw new Error("Expected team");
    const [first, second] = f.store.jobs(f.eventId, team.teamId);
    if (!first || !second) throw new Error("Expected two jobs");
    for (const job of [first, second]) {
      await f.service.participant(
        request("POST", `/portal/me/problems/${job.problemId}/container/start`, team.teamLoginKey),
      );
      await f.service.drain();
    }
    f.engine.surfaces = (job: Job) => ({ Web: `http://127.0.0.1:5300/${job.jobId}/` });
    const issued: string[] = [];
    f.service.surfaceLink = async (job) => {
      issued.push(job.jobId);
      return `http://127.0.0.1:5200/handoff/${job.jobId}`;
    };
    const read = (path: string) =>
      f.service.participant(request("GET", path, team.teamLoginKey)) as Promise<{
        body: { problems: { problemId: string; stackOutputs: object; accessError?: string }[] };
      }>;
    const scoped = await read(`/portal/me/problems/${first.problemId}`);
    expect(scoped.body.problems.map((problem) => problem.problemId)).toEqual([first.problemId]);
    expect(scoped.body.problems[0]?.stackOutputs).toEqual({
      Web: `http://127.0.0.1:5200/handoff/${first.jobId}`,
    });
    expect(issued).toEqual([first.jobId]);
    issued.length = 0;
    await read("/portal/me");
    expect(issued.sort()).toEqual([first.jobId, second.jobId].sort());
    for (const path of ["/portal/me/problems/not-in-event", "/portal/me/problems/Upper"])
      await expect(read(path)).rejects.toMatchObject({ status: 404 });
    f.service.surfaceLink = () => Promise.reject(new Error("Gateway pending-ticket limit"));
    const failed = await read(`/portal/me/problems/${first.problemId}`);
    expect(failed.body.problems[0]).toMatchObject({
      problemId: first.problemId,
      stackOutputs: {},
      accessError: "link_unavailable",
    });
  });
});

test("external verdict is discarded when the team key is revoked during the verifier call", async () => {
  await fixture(async (f) => {
    const team = f.teams[0];
    if (!team) throw new Error("Expected team");
    const job = f.store.jobs(f.eventId, team.teamId)[0];
    if (!job) throw new Error("Expected job");
    await f.service.participant(
      request("POST", `/portal/me/problems/${job.problemId}/container/start`, team.teamLoginKey),
    );
    await f.service.drain();
    f.engine.afterEvaluate = () => {
      const current = f.store.team(team.teamId);
      current.loginKey = "revoked-fixture-key";
      f.store.putTeam(current);
    };
    await expect(
      f.service.participant(
        request("POST", `/portal/me/problems/${job.problemId}/evaluate`, team.teamLoginKey, {
          submission: team.teamId,
        }),
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(f.store.team(team.teamId).scoreEvents).toEqual([]);
  }, true);
});

test.each(["event-ended", "runtime-replaced"])(
  "external verdict is discarded after %s during verification",
  async (change) => {
    await fixture(async (f) => {
      const team = f.teams[0];
      if (!team) throw new Error("Expected team");
      const job = f.store.jobs(f.eventId, team.teamId)[0];
      if (!job) throw new Error("Expected job");
      await f.service.participant(
        request("POST", `/portal/me/problems/${job.problemId}/container/start`, team.teamLoginKey),
      );
      await f.service.drain();
      f.engine.afterEvaluate = () => {
        if (change === "event-ended") {
          const event = f.store.event(f.eventId);
          event.status = "ENDED";
          f.store.putEvent(event);
        } else {
          const current = f.store.job(job.jobId);
          current.unit = JSON.stringify({ replaced: true });
          f.store.putJob(current);
        }
      };
      await expect(
        f.service.participant(
          request("POST", `/portal/me/problems/${job.problemId}/evaluate`, team.teamLoginKey, {
            submission: team.teamId,
          }),
        ),
      ).rejects.toMatchObject({ status: 409 });
      expect(f.store.team(team.teamId).scoreEvents).toEqual([]);
    }, true);
  },
);

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

test("native events reject external evaluation before invoking a verifier", async () => {
  await fixture(async (f) => {
    const team = f.teams[0];
    if (!team) throw new Error("Missing fixture team");
    const job = f.store.jobs(f.eventId, team.teamId)[0];
    if (!job) throw new Error("Missing fixture job");
    expect(f.store.event(f.eventId).scoringAuthority).toBeUndefined();
    await expect(
      f.service.participant(
        request("POST", `/portal/me/problems/${job.problemId}/evaluate`, team.teamLoginKey, {
          submission: "wrong",
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(f.engine.evaluations).toEqual([]);
    expect(f.store.team(team.teamId).scoreEvents).toEqual([]);
  });
});

test("CTFd authority persists and rejects native answers and hints without writes", async () => {
  await fixture(async (f) => {
    const team = f.teams[0];
    if (!team) throw new Error("Missing fixture team");
    const job = f.store.jobs(f.eventId, team.teamId)[0];
    if (!job) throw new Error("Missing fixture job");
    expect(f.store.event(f.eventId).scoringAuthority).toBe("ctfd");
    f.store.setFeatureFlag("challengePrerequisiteGate", true);
    await expect(
      f.service.admin(request("PUT", `/events/${f.eventId}/progression-gate`, f.admin, {})),
    ).rejects.toMatchObject({ status: 409 });
    expect(f.store.event(f.eventId).progressionGate).toBeUndefined();
    for (const trusted of [undefined, false]) {
      await expect(
        f.service.participant({
          ...request("POST", `/portal/me/problems/${job.problemId}/evaluate`, team.teamLoginKey, {
            submission: team.teamId,
          }),
          externalEvaluationTrusted: trusted,
        }),
      ).rejects.toMatchObject({ status: 403 });
    }
    const before = JSON.stringify(f.store.team(team.teamId));
    for (const [path, body] of [
      ["/portal/me/submit-flag", { problemId: job.problemId, flag: "wrong" }],
      [`/portal/me/problems/${job.problemId}/hints/test/reveal`, {}],
    ] as const) {
      await expect(
        f.service.participant({
          ...request("POST", path, team.teamLoginKey, body),
          nonce: "receipt-key-123",
        }),
      ).rejects.toMatchObject({ status: 409 });
    }
    expect(JSON.stringify(f.store.team(team.teamId))).toBe(before);
    expect(f.store.receipt(team.teamId, "receipt-key-123", "unused")).toBeUndefined();
  }, true);
});

test("creation rejects invalid authority and unsupported multi-checkpoint CTFd exercises", async () => {
  await fixture(async (f) => {
    const multi = f.engine
      .catalog()
      .find(
        (p) =>
          (JSON.parse(p.definition) as DockerDefinition).problem.scoring.kind === "multi-verify",
      );
    if (!multi) throw new Error("Missing multi-checkpoint catalog fixture");
    const before = f.store.events().length;
    for (const [authority, status] of [
      ["unknown", 400],
      ["ctfd", 422],
    ] as const) {
      await expect(
        f.service.admin(
          request("POST", "/events", f.admin, {
            name: "Rejected",
            scoringAuthority: authority,
            teams: [{ internalSlug: "isolated" }],
            problems: [{ problemId: multi.problemId }],
          }),
        ),
      ).rejects.toMatchObject({ status });
    }
    expect(f.store.events()).toHaveLength(before);
  });
});

async function privateTestPort(): Promise<number> {
  const probe = createServer();
  const origin = await listen(probe, "127.0.0.1", 0);
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return Number(new URL(origin).port);
}

test.each([
  { config: {}, allowed: true },
  { config: { behindProxy: true }, allowed: false },
  { config: { advertised: "https://public.example.test" }, allowed: false },
  { config: { hostname: "0.0.0.0" }, allowed: false },
])(
  "CTFd evaluation rejects public/proxy/forwarded HTTP access: %j",
  async ({ config, allowed }) => {
    await fixture(async (f) => {
      const team = f.teams[0];
      if (!team) throw new Error("Missing fixture team");
      const job = f.store.jobs(f.eventId, team.teamId)[0];
      if (!job) throw new Error("Missing fixture job");
      const path = `/portal/me/problems/${job.problemId}/evaluate`;
      await f.service.participant(
        request("POST", `/portal/me/problems/${job.problemId}/container/start`, team.teamLoginKey),
      );
      await f.service.drain();
      const port = await privateTestPort();
      const host = await startHttpHost({
        kind: "participant",
        hostname: "127.0.0.1",
        port,
        staticRoot: root,
        service: f.service,
        ...config,
      });
      try {
        const cases: {
          headers: Record<string, string>;
          body: Record<string, unknown>;
          privateStatus: number;
        }[] = [
          { headers: {}, body: {}, privateStatus: 200 },
          ...["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"].map(
            (header) => ({ headers: { [header]: "127.0.0.1" }, body: {}, privateStatus: 403 }),
          ),
          {
            headers: { externalEvaluationTrusted: "true" },
            body: { externalEvaluationTrusted: true },
            privateStatus: 400,
          },
        ];
        for (const entry of cases) {
          const response = await fetch(`http://127.0.0.1:${port}/api${path}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${team.teamLoginKey}`,
              ...entry.headers,
            },
            body: JSON.stringify({ submission: team.teamId, ...entry.body }),
          });
          expect(response.status).toBe(allowed ? entry.privateStatus : 403);
        }
      } finally {
        await host.close();
      }
      expect(f.engine.evaluations).toHaveLength(Number(allowed));
    }, true);
  },
);
