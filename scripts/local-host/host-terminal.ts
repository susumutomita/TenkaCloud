import { randomToken } from "./auth";
import type { TerminalProcess } from "./container/terminal-shell";
import { definitionKind, HostError, type Job } from "./model";
import type { ApiRequest, ApiResponse, HostingService } from "./service";
import { digest } from "./store";

export const TERMINAL_MAX_FRAME_BYTES = 1024 * 1024;
const TICKET_TTL_MS = 30_000;
const MAX_TICKETS = 1024;
const MAX_TICKETS_PER_JOB = 8;
const MAX_SESSIONS_PER_JOB = 4;
const MAX_SESSIONS = 128;
const MAX_SESSION_MS = 30 * 60_000;
const IDLE_MS = 5 * 60_000;

export interface TerminalGrant {
  readonly jobId: string;
  readonly eventId: string;
  readonly teamId: string;
  readonly problemId: string;
  readonly keyHash: string;
  readonly generation: string;
}
interface Ticket extends TerminalGrant {
  readonly expiresAt: number;
}
export interface TerminalSocket {
  readonly authorize?: () => void;
  readonly send: (payload: string) => void;
  readonly close: () => void;
  readonly onMessage: (handler: (raw: string) => void) => void;
  readonly onClose: (handler: () => void) => void;
}
const generation = (job: Job) => digest(JSON.stringify([job.unit, job.definition, job.deployedAt]));

function problemIdFrom(path: string): string {
  const match = /^\/portal\/me\/problems\/([^/]+)\/terminal-handoff$/u.exec(path);
  let value: string;
  try {
    value = decodeURIComponent(match?.[1] ?? "");
  } catch {
    throw new HostError(400, "Invalid terminal problem.");
  }
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/u.test(value))
    throw new HostError(404, "Unknown terminal endpoint.");
  return value;
}

type TerminalFrame =
  | { readonly type: "input"; readonly data: string }
  | { readonly type: "resize"; readonly cols: number; readonly rows: number };
function terminalFrame(raw: string): TerminalFrame | undefined {
  if (Buffer.byteLength(raw) > TERMINAL_MAX_FRAME_BYTES) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const frame = value as Record<string, unknown>;
  if (Object.keys(frame).length === 2 && frame.type === "input" && typeof frame.data === "string")
    return { type: "input", data: frame.data };
  if (
    Object.keys(frame).length === 3 &&
    frame.type === "resize" &&
    typeof frame.cols === "number" &&
    Number.isInteger(frame.cols) &&
    frame.cols >= 2 &&
    frame.cols <= 256 &&
    typeof frame.rows === "number" &&
    Number.isInteger(frame.rows) &&
    frame.rows >= 1 &&
    frame.rows <= 128
  )
    return { type: "resize", cols: frame.cols, rows: frame.rows };
  return undefined;
}

/** Ephemeral tickets and shell transports never survive host restart or access revocation. */
export class HostTerminals {
  private readonly tickets = new Map<string, Ticket>();
  private readonly sessions = new Map<
    string,
    { readonly jobId: string; readonly close: () => void; readonly settled: () => Promise<void> }
  >();
  constructor(private readonly service: HostingService) {}

  private authorize(grant: TerminalGrant): Job {
    const job = this.service.authorizeSurface(grant.jobId, grant.keyHash);
    const event = this.service.store.event(job.eventId);
    if (
      !job.unit ||
      job.teamId !== grant.teamId ||
      job.eventId !== grant.eventId ||
      job.problemId !== grant.problemId ||
      generation(job) !== grant.generation ||
      definitionKind(job.definition) !== "compose"
    )
      throw new HostError(409, "Terminal environment changed.", "not_running");
    if (
      !event.problems.some(
        (problem) =>
          problem.problemId === job.problemId &&
          problem.definition === job.definition &&
          (problem.runtime ?? "docker") === "docker",
      ) ||
      !this.service.engine.terminalSupported?.(job)
    )
      throw new HostError(
        404,
        "This problem has no participant terminal.",
        "terminal_not_supported",
      );
    return { ...job };
  }

  issue(request: ApiRequest): ApiResponse {
    const team = this.service.store.authenticateTeam(request.token);
    const problemId = problemIdFrom(request.path);
    if (request.method !== "POST") throw new HostError(405, "Use POST for a terminal ticket.");
    if (
      request.query.size ||
      (request.body !== undefined &&
        request.body !== null &&
        (typeof request.body !== "object" ||
          Array.isArray(request.body) ||
          Object.keys(request.body).length))
    )
      throw new HostError(400, "Terminal tickets accept no target selectors.");
    const job = this.service.store
      .jobs(team.eventId, team.teamId)
      .find((item) => item.problemId === problemId);
    if (!job) throw new HostError(404, "Unknown team problem.", "unknown_problem");
    const grant: TerminalGrant = {
      jobId: job.jobId,
      teamId: team.teamId,
      eventId: team.eventId,
      problemId,
      keyHash: digest(request.token),
      generation: generation(job),
    };
    this.authorize(grant);
    this.prune();
    const existing = [...this.tickets.values()].filter((entry) => entry.jobId === job.jobId).length;
    if (existing >= MAX_TICKETS_PER_JOB || this.tickets.size >= MAX_TICKETS)
      throw new HostError(429, "Too many pending terminal tickets.");
    const ticket = randomToken();
    this.tickets.set(digest(ticket), { ...grant, expiresAt: this.service.now() + TICKET_TTL_MS });
    return { status: 200, body: { ticket, expiresInMs: TICKET_TTL_MS } };
  }

  private prune(): void {
    for (const [key, ticket] of this.tickets)
      if (ticket.expiresAt <= this.service.now()) this.tickets.delete(key);
  }

  redeem(problemId: string, ticket: string): TerminalGrant {
    const key = digest(ticket);
    const grant = this.tickets.get(key);
    this.tickets.delete(key);
    this.prune();
    if (!grant || grant.expiresAt <= this.service.now() || grant.problemId !== problemId)
      throw new HostError(401, "Terminal ticket is invalid or expired.");
    this.authorize(grant);
    return grant;
  }

  countFor(jobId: string): number {
    return [...this.sessions.values()].filter((session) => session.jobId === jobId).length;
  }

  private atCapacity(jobId: string): boolean {
    return this.sessions.size >= MAX_SESSIONS || this.countFor(jobId) >= MAX_SESSIONS_PER_JOB;
  }

  async attach(grant: TerminalGrant, socket: TerminalSocket): Promise<void> {
    if (this.atCapacity(grant.jobId)) {
      socket.send(JSON.stringify({ type: "exit", code: null, reason: "too_many_sessions" }));
      socket.close();
      return;
    }
    const id = randomToken();
    const began = this.service.now();
    let activeAt = began;
    let ended = false;
    let shell: TerminalProcess | undefined;
    let spawning = true;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const release = () => {
      if (spawning) return;
      if (shell?.closed)
        void shell.closed.then(
          () => this.sessions.delete(id),
          () => undefined,
        );
      else this.sessions.delete(id);
    };
    const pendingInput: string[] = [];
    let pendingBytes = 0;
    let pendingSize: { cols: number; rows: number } | undefined;
    const end = (code: number | null, reason?: string, notify = true) => {
      if (ended) return;
      ended = true;
      pendingInput.length = 0;
      clearInterval(timer);
      shell?.kill();
      release();
      if (notify)
        socket.send(JSON.stringify({ type: "exit", code, ...(reason ? { reason } : {}) }));
      socket.close();
    };
    const assertCurrent = () => {
      if (ended) throw new HostError(409, "Terminal has closed.");
      socket.authorize?.();
      this.authorize(grant);
      if (this.service.now() - began >= MAX_SESSION_MS || this.service.now() - activeAt >= IDLE_MS)
        throw new HostError(409, "Terminal session expired.");
    };
    const check = () => {
      try {
        assertCurrent();
        return true;
      } catch {
        end(null, "not_running");
        return false;
      }
    };
    const timer = setInterval(check, 500);
    this.sessions.set(id, {
      jobId: grant.jobId,
      close: () => end(null, "not_running"),
      settled: async () => {
        await started;
        await shell?.closed;
      },
    });
    socket.onClose(() => end(null, undefined, false));
    const resize = (size: { cols: number; rows: number }) => {
      if (!shell) pendingSize = size;
      else if (shell.resize) shell.resize(size.cols, size.rows);
      else end(null, "resize_not_supported");
    };
    const input = (data: string) => {
      activeAt = this.service.now();
      if (shell) shell.write(data);
      else {
        pendingBytes += Buffer.byteLength(data);
        if (pendingBytes > TERMINAL_MAX_FRAME_BYTES) end(null, "invalid_input");
        else pendingInput.push(data);
      }
    };
    socket.onMessage((raw) => {
      const frame = terminalFrame(raw);
      if (!frame) {
        end(null, "invalid_input");
        return;
      }
      if (!check()) return;
      try {
        if (frame.type === "resize") resize(frame);
        else input(frame.data);
      } catch {
        end(null, "transport_failed");
      }
    });

    const activate = (opened: TerminalProcess) => {
      spawning = false;
      if (ended) {
        opened.kill();
        release();
        return;
      }
      if (!check()) return;
      if (pendingSize) resize(pendingSize);
      if (ended) return;
      socket.send(JSON.stringify({ type: "ready", mode: opened.resize ? "pty" : "pipe" }));
      for (const input of pendingInput) {
        assertCurrent();
        opened.write(input);
      }
      pendingInput.length = 0;
    };

    try {
      socket.authorize?.();
      const job = this.authorize(grant);
      if (!this.service.engine.openTerminal) throw new Error("Terminal runtime is unavailable.");
      shell = await this.service.engine.openTerminal(
        job,
        {
          onData: (chunk) => {
            if (!check()) return;
            for (let offset = 0; offset < chunk.length; offset += 16_384)
              socket.send(
                JSON.stringify({ type: "data", data: chunk.slice(offset, offset + 16_384) }),
              );
          },
          onExit: (code) => end(code),
        },
        assertCurrent,
      );
      activate(shell);
    } catch {
      spawning = false;
      if (ended) release();
      else end(null, "spawn_failed");
    } finally {
      markStarted();
    }
  }

  async closeAll(): Promise<void> {
    this.tickets.clear();
    const sessions = [...this.sessions.values()];
    for (const session of sessions) session.close();
    const results = await Promise.allSettled(sessions.map((session) => session.settled()));
    const errors = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason as unknown);
    if (errors.length) throw new AggregateError(errors, "Terminal cleanup is unconfirmed.");
  }
}
