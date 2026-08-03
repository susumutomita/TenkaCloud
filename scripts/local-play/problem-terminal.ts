/**
 * [#2846] Interactive shell attached to a running problem container.
 *
 * Container problems ship their play surface as loopback ports, but a whole class of
 * them (the AC26 companion track, the sha256 series) has no network surface at all:
 * the container exists to host `/verify`, and the actual work — read the fixture, edit
 * the starter, run the tests — happens in a shell. Without one, the portal starts a
 * grader and leaves the participant on a screen with nothing to act on.
 *
 * local play only. ADR-014 bars SSE/WebSocket on AWS-backed surfaces because those
 * backends are request-scoped Lambdas sized for the Free Tier (connection registry
 * against the DynamoDB 1/1 rule, per-connection cost). Local play is one long-lived
 * `node:http` process with SQLite on the participant's own machine, so not one of
 * those reasons reaches here; the ADR's Frontend row now says so explicitly.
 *
 * This module is the pure session bookkeeping — who may attach, how many sessions a
 * problem may hold, and how a session ends. Docker is injected, so it unit tests with
 * no daemon.
 */

/** Max concurrent shells per problem. More than this is a runaway tab, not a workflow. */
const MAX_SESSIONS_PER_PROBLEM = 4;

/** A shell process attached to one container. Implemented by the docker adapter. */
export interface TerminalProcess {
  /** Forward participant keystrokes to the shell's stdin. */
  readonly write: (data: string) => void;
  /** Terminate the shell. Idempotent — closing an already-dead shell is a no-op. */
  readonly kill: () => void;
}

export interface TerminalDeps {
  /**
   * Spawn a shell inside the problem's container. `onData` receives merged
   * stdout/stderr; `onExit` fires once when the shell ends, for any reason.
   */
  readonly spawnShell: (
    problemId: string,
    handlers: {
      readonly onData: (chunk: string) => void;
      readonly onExit: (code: number | null) => void;
    },
  ) => TerminalProcess;
  /** Container runtime status, so a shell is never attached to a dead container. */
  readonly statusOf: (problemId: string) => string | undefined;
}

export interface TerminalSession {
  readonly sessionId: string;
  readonly problemId: string;
  /** Forward participant input. No-op once the session has ended. */
  readonly write: (data: string) => void;
  /** End this session and kill its shell. Idempotent. */
  readonly close: () => void;
}

export type AttachFailure =
  | "unknown_problem"
  | "not_running"
  | "too_many_sessions"
  | "spawn_failed";

export type AttachResult =
  | { readonly ok: true; readonly session: TerminalSession }
  | { readonly ok: false; readonly reason: AttachFailure };

interface Entry {
  readonly sessionId: string;
  readonly problemId: string;
  /** Terminate the shell. */
  readonly kill: () => void;
  /** Mark the session ended, drop it from the registry, and notify the client once. */
  readonly finish: (code: number | null) => void;
  readonly ended: boolean;
}

/**
 * Session registry for container shells.
 *
 * The invariant that matters: a shell never outlives the container it is attached to.
 * `stop` and LRU eviction both reclaim the container without asking this module, so
 * the lifecycle calls {@link closeProblem} on every transition out of `running` — an
 * orphaned shell would otherwise sit on a dead container writing into a socket the
 * participant still believes is live.
 */
export class ProblemTerminals {
  private readonly sessions = new Map<string, Entry>();
  private nextId = 1;

  constructor(
    private readonly knownProblemIds: ReadonlySet<string>,
    private readonly deps: TerminalDeps,
  ) {}

  /** Sessions currently attached to a problem (test/observability seam). */
  countFor(problemId: string): number {
    let total = 0;
    for (const entry of this.sessions.values()) {
      if (entry.problemId === problemId && !entry.ended) total += 1;
    }
    return total;
  }

  /**
   * Attach a shell to a running problem. Fails closed: an unknown problem, a container
   * that is not `running`, and a spawn that throws are all reported rather than
   * papered over, because a terminal that silently does nothing is worse than one that
   * says why it did not open.
   */
  attach(
    problemId: string,
    handlers: {
      readonly onData: (chunk: string) => void;
      readonly onExit: (code: number | null) => void;
    },
  ): AttachResult {
    if (!this.knownProblemIds.has(problemId)) return { ok: false, reason: "unknown_problem" };
    if (this.deps.statusOf(problemId) !== "running") return { ok: false, reason: "not_running" };
    if (this.countFor(problemId) >= MAX_SESSIONS_PER_PROBLEM) {
      return { ok: false, reason: "too_many_sessions" };
    }

    const sessionId = `term-${this.nextId++}`;
    // `ended` lives in the closure rather than on the entry: a shell can die before
    // `spawnShell` has returned (image gone, container reaped mid-attach), and an
    // exit that arrives before the entry exists must still be delivered once.
    let ended = false;
    const finish = (code: number | null): void => {
      if (ended) return;
      ended = true;
      this.sessions.delete(sessionId);
      handlers.onExit(code);
    };

    let shell: TerminalProcess;
    try {
      shell = this.deps.spawnShell(problemId, {
        onData: (chunk) => {
          if (!ended) handlers.onData(chunk);
        },
        onExit: finish,
      });
    } catch {
      return { ok: false, reason: "spawn_failed" };
    }

    if (ended) return { ok: false, reason: "spawn_failed" };
    this.sessions.set(sessionId, {
      sessionId,
      problemId,
      kill: () => shell.kill(),
      finish,
      get ended() {
        return ended;
      },
    });

    return {
      ok: true,
      session: {
        sessionId,
        problemId,
        write: (data) => {
          if (!ended) shell.write(data);
        },
        close: () => {
          if (ended) return;
          shell.kill();
          finish(null);
        },
      },
    };
  }

  /** Kill every shell attached to one problem (its container is going away). */
  closeProblem(problemId: string): void {
    for (const entry of [...this.sessions.values()]) {
      if (entry.problemId === problemId) this.killEntry(entry);
    }
  }

  /** Kill every shell (session teardown). */
  closeAll(): void {
    for (const entry of [...this.sessions.values()]) this.killEntry(entry);
  }

  private killEntry(entry: Entry): void {
    if (entry.ended) return;
    // kill() normally drives the adapter's exit handler, which runs `finish`. A shell
    // that is already gone (or an adapter that never calls back) still has to be
    // reclaimed, so `finish` runs here too — it is idempotent.
    try {
      entry.kill();
    } finally {
      entry.finish(null);
    }
  }
}
