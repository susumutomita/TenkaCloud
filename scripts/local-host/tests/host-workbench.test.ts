import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { id } from "../auth";
import { WorkbenchClientError } from "../container/workbench-client";
import { hostWorkbench } from "../host-workbench";
import { startHttpHost } from "../http";
import type { HostedEvent, Job, RuntimeEngine, Team } from "../model";
import { type ApiRequest, HostingService } from "../service";
import { HostStore } from "../store";

const now = Date.parse("2026-10-01T00:00:00Z");
const unavailable = async (): Promise<never> => {
  throw new Error("Unexpected runtime operation.");
};

/** Real host authorization and SQLite, with an explicitly synthetic workbench transport. */
function fixture() {
  const store = new HostStore(new Database(":memory:"));
  const calls: Job[] = [];
  const engine: RuntimeEngine = {
    catalog: () => [],
    start: unavailable,
    recover: unavailable,
    stop: unavailable,
    pause: unavailable,
    resume: unavailable,
    view: unavailable,
    submit: unavailable,
    hint: unavailable,
    surface: () => {
      throw new Error("Unexpected surface.");
    },
    workbench: async (job) => {
      calls.push(job);
      return { id: job.problemId, owner: job.teamId };
    },
  };
  const event: HostedEvent = {
    eventId: id(),
    name: "Workbench boundary",
    status: "READY",
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    startsAt: new Date(now - 1000).toISOString(),
    expiresAt: Math.floor(now / 1000) + 3600,
    scoringLocked: false,
    scoreboardFreezeMinutes: 0,
    problems: [{ problemId: "code-lab", name: "Code lab", definition: "{}", runtime: "docker" }],
  };
  store.putEvent(event);
  const addTeam = (slug: string) => {
    const team: Team = {
      teamId: id(),
      eventId: event.eventId,
      internalSlug: slug,
      displayName: slug,
      loginKey: `synthetic-key-${slug}`,
      snapshot: null,
      score: 0,
      completedProblems: 0,
      scoreEvents: [],
    };
    store.putTeam(team);
    const job: Job = {
      jobId: id(),
      eventId: event.eventId,
      teamId: team.teamId,
      problemId: "code-lab",
      definition: "{}",
      offset: 0,
      status: "COMPLETE",
      unit: `owned-${slug}`,
      deployedAt: now - 1000,
    };
    store.putJob(job);
    return { team, job };
  };
  const a = addTeam("alpha"),
    b = addTeam("beta");
  const service = new HostingService(store, engine, "synthetic-host-key", () => now);
  const request = (patch: Partial<ApiRequest> = {}): ApiRequest => ({
    method: "GET",
    path: "/portal/me/problems/code-lab/workbench/config",
    query: new URLSearchParams(),
    body: {},
    token: a.team.loginKey,
    ...patch,
  });
  return { store, engine, service, event, a, b, calls, request };
}

test("workbench uses only the authenticated team's job and rejects caller-selected targets", async () => {
  const f = fixture();
  try {
    expect((await hostWorkbench(f.service, f.request())).body).toEqual({
      id: "code-lab",
      owner: f.a.team.teamId,
    });
    expect((await hostWorkbench(f.service, f.request({ token: f.b.team.loginKey }))).body).toEqual({
      id: "code-lab",
      owner: f.b.team.teamId,
    });
    expect(f.calls.map((job) => job.jobId)).toEqual([f.a.job.jobId, f.b.job.jobId]);
    for (const patch of [
      { token: "invalid-key" },
      { query: new URLSearchParams({ jobId: f.b.job.jobId }) },
      { body: { url: "http://other.example/" } },
      { path: "/portal/me/problems/other/workbench/config" },
      { path: "/portal/me/problems/code-lab%2Fother/workbench/config" },
      { method: "POST" },
      { path: "/portal/me/problems/code-lab/workbench/shell" },
      {
        method: "POST",
        path: "/portal/me/problems/code-lab/workbench/test",
        body: { files: {}, service: "other" },
      },
      {
        method: "POST",
        path: "/portal/me/problems/code-lab/workbench/test",
        body: { files: { "a.py": "あ".repeat(25_000) } },
      },
    ])
      await expect(hostWorkbench(f.service, f.request(patch))).rejects.toThrow();
    expect(f.calls).toHaveLength(2);
  } finally {
    f.store.close();
  }
});

test("workbench refuses stopped, locked, unstarted, ended and progression-locked access", async () => {
  const mutations = [
    (f: ReturnType<typeof fixture>) => f.store.putJob({ ...f.a.job, status: "STOPPED" }),
    (f: ReturnType<typeof fixture>) => f.store.putJob({ ...f.a.job, unit: null }),
    (f: ReturnType<typeof fixture>) => f.store.putEvent({ ...f.event, scoringLocked: true }),
    (f: ReturnType<typeof fixture>) =>
      f.store.putEvent({ ...f.event, startsAt: new Date(now + 1000).toISOString() }),
    (f: ReturnType<typeof fixture>) => f.store.putEvent({ ...f.event, status: "ENDED" }),
    (f: ReturnType<typeof fixture>) => {
      f.store.setFeatureFlag("challengePrerequisiteGate", true);
      f.store.putEvent({
        ...f.event,
        problems: [
          ...f.event.problems,
          { problemId: "gate", name: "Gate", definition: "{}", runtime: "docker" },
        ],
        progressionGate: {
          gateProblemId: "gate",
          unlockTargetIds: ["code-lab"],
          defaultPolicy: "required",
          completionBonus: 0,
        },
      });
    },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    try {
      mutate(f);
      await expect(hostWorkbench(f.service, f.request())).rejects.toThrow();
      expect(f.calls).toHaveLength(0);
    } finally {
      f.store.close();
    }
  }
});

test("workbench discards in-flight results after revocation, event stop or deployment replacement", async () => {
  const mutations = [
    (f: ReturnType<typeof fixture>) => f.store.putTeam({ ...f.a.team, loginKey: "rotated-key" }),
    (f: ReturnType<typeof fixture>) => f.store.putEvent({ ...f.event, status: "ENDED" }),
    (f: ReturnType<typeof fixture>) => f.store.putEvent({ ...f.event, scoringLocked: true }),
    (f: ReturnType<typeof fixture>) => f.store.putJob({ ...f.a.job, unit: "replacement-unit" }),
    (f: ReturnType<typeof fixture>) => f.store.putJob({ ...f.a.job, deployedAt: now + 1 }),
    (f: ReturnType<typeof fixture>) => {
      f.store.putJob({ ...f.a.job, definition: '{"replacement":true}' });
      f.store.putEvent({
        ...f.event,
        problems: [
          {
            ...f.event.problems[0],
            problemId: "code-lab",
            name: "Code lab",
            definition: '{"replacement":true}',
          },
        ],
      });
    },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    const started = Promise.withResolvers<boolean>();
    const release = Promise.withResolvers<boolean>();
    f.engine.workbench = async () => {
      started.resolve(true);
      await release.promise;
      return { id: "code-lab" };
    };
    try {
      const pending = hostWorkbench(f.service, f.request());
      await started.promise;
      mutate(f);
      release.resolve(true);
      await expect(pending).rejects.toThrow();
    } finally {
      release.resolve(true);
      f.store.close();
    }
  }
});

test("workbench checks config identity and maps upstream errors without exposing private details", async () => {
  const f = fixture();
  try {
    f.engine.workbench = async () => ({ id: "other-team-problem" });
    await expect(hostWorkbench(f.service, f.request())).rejects.toMatchObject({ status: 502 });
    for (const [code, status] of [
      ["not_supported", 404],
      ["unavailable", 502],
      ["invalid_response", 502],
    ] as const) {
      f.engine.workbench = async () => {
        throw new WorkbenchClientError(code, "private http://127.0.0.1:9999/verify");
      };
      await expect(hostWorkbench(f.service, f.request())).rejects.toMatchObject({ status });
      await expect(hostWorkbench(f.service, f.request())).rejects.not.toThrow("127.0.0.1");
    }
  } finally {
    f.store.close();
  }
});

test("participant HTTP routes use the protected workbench helper", async () => {
  const f = fixture();
  const host = await startHttpHost({
    kind: "participant",
    hostname: "127.0.0.1",
    port: 0,
    staticRoot: "/tmp",
    service: f.service,
  });
  try {
    const path = `${host.origin}/api/portal/me/problems/code-lab/workbench/config`;
    expect((await fetch(path)).status).toBe(401);
    const result = await fetch(path, { headers: { authorization: `Bearer ${f.a.team.loginKey}` } });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ id: "code-lab", owner: f.a.team.teamId });
    const denied = await fetch(`${path}?url=http://other.example/`, {
      headers: { authorization: `Bearer ${f.a.team.loginKey}` },
    });
    expect(denied.status).toBe(400);
    expect(f.calls).toHaveLength(1);
  } finally {
    await host.close();
    f.store.close();
  }
});
