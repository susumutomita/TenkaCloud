import { Database } from "bun:sqlite";
import { id } from "../auth";
import type { TerminalHandlers } from "../container/terminal-shell";
import { startHttpHost } from "../http";
import type { HostedEvent, Job, RuntimeEngine, Team } from "../model";
import { type ApiRequest, HostingService } from "../service";
import { HostStore } from "../store";

const unavailable = async (): Promise<never> => {
  throw new Error("Unexpected test runtime operation.");
};

/** Real HTTP/SQLite/WS authorization; fake shell processes, never a Docker runtime claim. */
export async function terminalFixture(
  teamCount = 2,
  authorizePeer?: (remote: string, team: { eventId: string; teamId: string }) => void,
) {
  const store = new HostStore(new Database(":memory:"));
  let clock = Date.parse("2026-10-01T00:00:00Z");
  const shells: {
    job: Job;
    writes: string[];
    resizes: { cols: number; rows: number }[];
    kills: number;
    handlers: TerminalHandlers;
  }[] = [];
  const hooks: { beforeOpen?: () => Promise<void>; pty?: boolean; closed?: Promise<void> } = {};
  const engine: RuntimeEngine = {
    catalog: () => [],
    start: unavailable,
    recover: unavailable,
    stop: unavailable,
    pause: unavailable,
    resume: unavailable,
    submit: unavailable,
    hint: unavailable,
    surface: () => {
      throw new Error("Unexpected surface.");
    },
    view: async (context) => ({
      problems: context.jobs.map((job) => ({
        problemId: job.problemId,
        status: "COMPLETE",
        score: 0,
        stackOutputs: {},
        instructions: "Synthetic participant instruction",
        lifecycle: { status: "running", runtimeKind: "docker", terminal: true },
      })),
    }),
    terminalSupported: (job) => job.problemId === "terminal-lab",
    openTerminal: async (job, handlers, assertCurrent) => {
      await hooks.beforeOpen?.();
      assertCurrent();
      const shell = {
        job,
        writes: [] as string[],
        resizes: [] as { cols: number; rows: number }[],
        kills: 0,
        handlers,
      };
      shells.push(shell);
      return {
        closed: hooks.closed,
        ...(hooks.pty
          ? {
              resize: (cols: number, rows: number) => {
                shell.resizes.push({ cols, rows });
              },
            }
          : {}),
        write: (data) => {
          shell.writes.push(data);
          handlers.onData(data);
        },
        kill: () => {
          shell.kills += 1;
          handlers.onExit(null);
        },
      };
    },
  };
  const event: HostedEvent = {
    eventId: id(),
    name: "Terminal event",
    status: "READY",
    createdAt: new Date(clock).toISOString(),
    updatedAt: new Date(clock).toISOString(),
    startsAt: new Date(clock - 1000).toISOString(),
    expiresAt: Math.floor(clock / 1000) + 3600,
    scoringLocked: false,
    scoreboardFreezeMinutes: 0,
    problems: [
      { problemId: "terminal-lab", name: "Terminal lab", definition: "{}", runtime: "docker" },
      { problemId: "no-terminal", name: "No terminal", definition: "{}", runtime: "docker" },
    ],
  };
  store.putEvent(event);
  const add = (slug: string) => {
    const team: Team = {
      teamId: id(),
      eventId: event.eventId,
      internalSlug: slug,
      displayName: slug,
      loginKey: `synthetic-terminal-${slug}`,
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
      problemId: "terminal-lab",
      definition: "{}",
      offset: 0,
      status: "COMPLETE",
      unit: `owned-${slug}`,
      deployedAt: clock - 1000,
    };
    store.putJob(job);
    store.putJob({ ...job, jobId: id(), problemId: "no-terminal" });
    return { team, job };
  };
  const a = add("alpha"),
    b = add("beta");
  const extras = Array.from({ length: Math.max(0, teamCount - 2) }, (_, index) =>
    add(`extra-${index}`),
  );
  const service = new HostingService(store, engine, "synthetic-host-key", () => clock);
  const terminalTrace: { jobId: string; kind: string; bytes?: number }[] = [];
  const recordTerminal = (jobId: string, kind: string, payload?: string) => {
    if (terminalTrace.length < 256)
      terminalTrace.push({
        jobId,
        kind,
        ...(payload === undefined ? {} : { bytes: Buffer.byteLength(payload) }),
      });
  };
  const attach = service.terminals.attach.bind(service.terminals);
  service.terminals.attach = (grant, socket) =>
    attach(grant, {
      ...socket,
      send: (payload) => {
        recordTerminal(grant.jobId, "server-send", payload);
        socket.send(payload);
      },
      close: () => {
        recordTerminal(grant.jobId, "server-close");
        socket.close();
      },
      onMessage: (handler) =>
        socket.onMessage((payload) => {
          recordTerminal(grant.jobId, "server-receive", payload);
          handler(payload);
        }),
      onClose: (handler) =>
        socket.onClose(() => {
          recordTerminal(grant.jobId, "transport-close");
          handler();
        }),
    });
  const authorizationErrors: { jobId: string; message: string }[] = [];
  const authorizeSurface = service.authorizeSurface.bind(service);
  service.authorizeSurface = (jobId, keyHash) => {
    try {
      return authorizeSurface(jobId, keyHash);
    } catch (error) {
      authorizationErrors.push({
        jobId,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
  const participant = await startHttpHost({
    kind: "participant",
    hostname: "127.0.0.1",
    port: 0,
    staticRoot: "/tmp",
    service,
    ...(authorizePeer
      ? {
          authorizePeer: (remote: string, token: string) =>
            authorizePeer(remote, store.authenticateTeam(token)),
          authorizeTerminalPeer: authorizePeer,
        }
      : {}),
  });
  const admin = await startHttpHost({
    kind: "admin",
    hostname: "127.0.0.1",
    port: 0,
    staticRoot: "/tmp",
    service,
  });
  const request = (patch: Partial<ApiRequest> = {}): ApiRequest => ({
    method: "POST",
    path: "/portal/me/problems/terminal-lab/terminal-handoff",
    query: new URLSearchParams(),
    body: {},
    token: a.team.loginKey,
    ...patch,
  });
  const issue = async (key = a.team.loginKey, problemId = "terminal-lab") => {
    const response = await fetch(
      `${participant.origin}/api/portal/me/problems/${problemId}/terminal-handoff`,
      { method: "POST", headers: { authorization: `Bearer ${key}` } },
    );
    const body = (await response.json()) as { ticket?: string; expiresInMs?: number };
    return { status: response.status, body };
  };
  const ticket = async (key = a.team.loginKey) => {
    const result = await issue(key);
    if (result.status !== 200 || !result.body.ticket)
      throw new Error("Synthetic terminal ticket failed.");
    return result.body.ticket;
  };
  let closed = false;
  return {
    store,
    engine,
    service,
    shells,
    authorizationErrors,
    terminalTrace,
    hooks,
    event,
    a,
    b,
    extras,
    participant,
    admin,
    request,
    issue,
    ticket,
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await participant.close();
      } finally {
        await admin.close();
        store.close();
      }
    },
  };
}
