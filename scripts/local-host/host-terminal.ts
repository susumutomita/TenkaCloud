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

function terminalInput(raw: string): string | undefined {
  if (Buffer.byteLength(raw) > TERMINAL_MAX_FRAME_BYTES) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const frame = value as Record<string, unknown>;
  if (Object.keys(frame).length !== 2 || frame.type !== "input" || typeof frame.data !== "string")
    return undefined;
  return frame.data;
}

/** Ephemeral tickets and shell transports never survive host restart or access revocation. */
export class HostTerminals {
  private readonly tickets = new Map<string, Ticket>();
  private readonly sessions = new Map<
    string,
    { readonly jobId: string; readonly close: () => void }
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

  async attach(grant: TerminalGrant, socket: TerminalSocket): Promise<void> {
    if (this.sessions.size >= MAX_SESSIONS || this.countFor(grant.jobId) >= MAX_SESSIONS_PER_JOB) {
      socket.send(JSON.stringify({ type: "exit", code: null, reason: "too_many_sessions" }));
      socket.close();
      return;
    }
    const id = randomToken();
    const began = this.service.now();
    let activeAt = began;
    let ended = false;
    let shell: TerminalProcess | undefined;
    const pendingInput: string[] = [];
    let pendingBytes = 0;
    const end = (code: number | null, reason?: string, notify = true) => {
      if (ended) return;
      ended = true;
      pendingInput.length = 0;
      clearInterval(timer);
      this.sessions.delete(id);
      shell?.kill();
      if (notify)
        socket.send(JSON.stringify({ type: "exit", code, ...(reason ? { reason } : {}) }));
      socket.close();
    };
    const assertCurrent = () => {
      if (ended) throw new HostError(409, "Terminal has closed.");
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
    this.sessions.set(id, { jobId: grant.jobId, close: () => end(null, "not_running") });
    socket.onClose(() => end(null, undefined, false));
    socket.onMessage((raw) => {
      const input = terminalInput(raw);
      if (input === undefined) {
        end(null, "invalid_input");
        return;
      }
      if (!check()) return;
      activeAt = this.service.now();
      if (shell) shell.write(input);
      else {
        pendingBytes += Buffer.byteLength(input);
        if (pendingBytes > TERMINAL_MAX_FRAME_BYTES) end(null, "invalid_input");
        else pendingInput.push(input);
      }
    });
    try {
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
      if (ended) shell.kill();
      else if (check()) {
        for (const input of pendingInput) {
          assertCurrent();
          shell.write(input);
        }
        pendingInput.length = 0;
      }
    } catch {
      end(null, "spawn_failed");
    }
  }

  closeAll(): void {
    this.tickets.clear();
    for (const session of [...this.sessions.values()]) session.close();
  }
}
