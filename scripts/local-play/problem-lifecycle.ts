/**
 * [#2392 Phase 2] On-demand problem lifecycle with a concurrency cap and LRU
 * eviction — the scalable core of local play. The warm session knows the
 * whole catalog, but only ever runs at most `maxRunning` containers at once, so
 * the catalog can grow without the machine falling over.
 *
 * This module is the pure state machine: it owns status transitions, the
 * host-port offset pool (one slot per cap unit, so the pool size *is* the cap),
 * and LRU eviction. Docker and the clock are injected, so it is unit-tested
 * with no containers. The API server wires real Docker Compose up/down in.
 *
 * [#2512] There is no time-based reaping: a running container stays up until
 * an explicit stop (portal Stop / `stopAll` on session teardown) or until the
 * cap evicts the least-recently-played problem to make room for another start.
 */

import type {
  NativeCompatibilityRefusal,
  NativeCompatibilityVerdict,
} from "./native-compatibility";
import { PORT_STRIDE } from "./port-remap";

export type ProblemStatus = "stopped" | "starting" | "running" | "stopping" | "error";

/** [#2927] A host port this session wants, and the container already holding it. */
export interface PortConflict {
  readonly port: number;
  /** Container name holding it, when Docker could tell us. */
  readonly heldBy?: string;
}

export interface LifecycleDeps {
  /** Bring a problem's container up on the assigned host-port offset. */
  readonly startContainer: (problemId: string, offset: number) => Promise<void>;
  /** Tear a problem's container down (offset is the one it was started on). */
  readonly stopContainer: (problemId: string, offset: number) => Promise<void>;
  /** Monotonic clock (ms). Injected so LRU eviction is deterministic in tests. */
  readonly now: () => number;
  /**
   * [#2927] Which of `problemId`'s host ports at `offset` are already taken by something
   * this session does not own. Empty (or absent dep) means "go ahead".
   *
   * The offset pool alone cannot answer this: it tracks slots *within one session*, so a
   * container left running by a previous session is invisible to it and slot 0 looks free.
   * Two catalog problems hardcode `127.0.0.1:18080`, so a 45-hour-old container from a
   * previous run made a new problem unstartable with only the daemon's raw
   * "port is already allocated" to go on.
   */
  readonly portConflicts?: (problemId: string, offset: number) => readonly PortConflict[];
  /**
   * [#3008] Whether this host can produce a *meaningful* result for the problem, for the
   * problems that declare `runtime.compatibility`. An absent dep means "no problem in this
   * catalog declares one", which is the common case and keeps current behavior exactly.
   *
   * Unlike {@link portConflicts}, this gate is consulted before a port slot is even
   * considered: a refusal here must leave no container, network, volume or occupied offset
   * behind, so it has to come before anything that could create one.
   */
  readonly nativeCompatibility?: (problemId: string) => NativeCompatibilityVerdict;
}

/**
 * [#2927] Every offset this session may use is blocked by containers it does not own.
 *
 * Deliberately does not stop anything: a participant running several problems at once is
 * legitimate, and this session cannot tell "my own leftovers" from "what they are working
 * on". So it reports precisely what is holding the port and the one command that frees it,
 * and lets the participant decide. The daemon's own message names neither.
 */
export class PortsUnavailableError extends Error {
  constructor(
    readonly problemId: string,
    readonly conflicts: readonly PortConflict[],
  ) {
    super(PortsUnavailableError.describe(problemId, conflicts));
    this.name = "PortsUnavailableError";
  }

  private static describe(problemId: string, conflicts: readonly PortConflict[]): string {
    const named = conflicts.filter((c) => c.heldBy !== undefined);
    const lines = [
      `Cannot start "${problemId}": every host port block it could use is already in use.`,
    ];
    for (const conflict of conflicts) {
      lines.push(
        conflict.heldBy !== undefined
          ? `  port ${conflict.port} is held by container ${conflict.heldBy}`
          : `  port ${conflict.port} is held by another process`,
      );
    }
    if (named.length > 0) {
      const names = [...new Set(named.map((c) => c.heldBy))].join(" ");
      lines.push(`Free them with:  docker stop ${names}`);
      lines.push("Or reclaim everything this project owns with:  make local-down");
    }
    return lines.join("\n");
  }
}

/**
 * [#3008] The host cannot produce a meaningful result for this problem, so it was never
 * started. Carries the structured refusal so the CLI and the portal render the same facts
 * instead of each re-deriving them from a string.
 */
export class NativeCompatibilityError extends Error {
  constructor(
    readonly problemId: string,
    readonly refusal: NativeCompatibilityRefusal,
  ) {
    super(`Cannot start "${problemId}": ${refusal.message}`);
    this.name = "NativeCompatibilityError";
  }
}

export interface LifecycleOptions {
  /** Max simultaneously-running containers (>= 1). Also the port-pool size. */
  readonly maxRunning: number;
}

export interface ProblemLifecycleView {
  readonly problemId: string;
  readonly status: ProblemStatus;
  readonly offset?: number;
  readonly cleanupRequired?: true;
}

interface Entry {
  status: ProblemStatus;
  offset?: number;
  lastAccessedAt: number;
  error?: string;
  /** In-flight start promise, so concurrent `ensureRunning` calls share it. */
  starting?: Promise<number>;
  /** In-flight stop promise, so start/reset waits for teardown to release the slot. */
  stopping?: Promise<void>;
}

export class ProblemLifecycle {
  private readonly entries = new Map<string, Entry>();
  private readonly freeOffsets: number[];

  constructor(
    problemIds: readonly string[],
    private readonly deps: LifecycleDeps,
    options: LifecycleOptions,
  ) {
    if (!Number.isInteger(options.maxRunning) || options.maxRunning < 1) {
      throw new Error(`maxRunning must be a positive integer (got ${options.maxRunning})`);
    }
    for (const id of problemIds) {
      this.entries.set(id, { status: "stopped", lastAccessedAt: 0 });
    }
    // One host-port offset per cap slot; taking an offset is how the cap is enforced.
    this.freeOffsets = Array.from({ length: options.maxRunning }, (_, i) => i * PORT_STRIDE);
  }

  snapshot(): ProblemLifecycleView[] {
    return [...this.entries.entries()].map(([problemId, e]) => ({
      problemId,
      status: e.status,
      ...(e.offset !== undefined ? { offset: e.offset } : {}),
      ...(e.status === "error" && e.offset !== undefined ? { cleanupRequired: true as const } : {}),
    }));
  }

  statusOf(problemId: string): ProblemStatus | undefined {
    return this.entries.get(problemId)?.status;
  }

  /**
   * 直近の start / stop 失敗メッセージ (status "error" のときのみ)。 start が非同期化
   * された (= HTTP 応答は 202 で先に返る) ため、 失敗理由はここを経由して portal の
   * polling へ届く。
   */
  errorOf(problemId: string): string | undefined {
    const entry = this.entries.get(problemId);
    return entry?.status === "error" ? entry.error : undefined;
  }

  /** True when a failed operation may still own a physical runtime and its port slot. */
  cleanupRequired(problemId: string): boolean {
    const entry = this.entries.get(problemId);
    return entry?.status === "error" && entry.offset !== undefined;
  }

  /** Bump last-access so an actively-played problem is not the LRU-eviction victim. No-op if not running. */
  touch(problemId: string): void {
    const entry = this.entries.get(problemId);
    if (entry?.status === "running") entry.lastAccessedAt = this.deps.now();
  }

  /**
   * Ensure a problem's container is running, starting it on demand. Concurrent
   * callers share the in-flight start. When at capacity, the least-recently-used
   * running problem is evicted first. Returns the assigned host-port offset.
   */
  /**
   * [#3008] Whether this host can produce a meaningful result for `problemId`, without
   * starting anything. The API asks this *before* dispatching the detached start, so a
   * refusal is an immediate precise response rather than a 202 followed by an error the
   * participant has to poll for. {@link ensureRunning} re-checks regardless: this is the
   * fast path, not the enforcement point.
   */
  compatibilityOf(problemId: string): NativeCompatibilityVerdict {
    return this.deps.nativeCompatibility?.(problemId) ?? { supported: true };
  }

  async ensureRunning(problemId: string): Promise<number> {
    const entry = this.entries.get(problemId);
    if (!entry) throw new Error(`unknown problem: ${problemId}`);
    // [#3008] Before anything that could allocate: an incompatible host must leave no
    // container, network, volume or port slot behind, and "already running" must not be a
    // way past the gate either — a problem that reached `running` before its requirement
    // was declared is exactly the stale state this refuses.
    const verdict = this.deps.nativeCompatibility?.(problemId);
    if (verdict !== undefined && !verdict.supported) {
      throw new NativeCompatibilityError(problemId, verdict);
    }
    if (entry.stopping) {
      await entry.stopping;
      return this.ensureRunning(problemId);
    }
    if (entry.status === "running" && entry.offset !== undefined) {
      entry.lastAccessedAt = this.deps.now();
      return entry.offset;
    }
    if (entry.starting) return entry.starting;
    // A failed start/stop that retained physical ownership must be torn down
    // before another start can safely reuse the same problem or port slot.
    if (entry.status === "error" && entry.offset !== undefined) {
      await this.stop(problemId);
      return this.ensureRunning(problemId);
    }

    const run = this.startEntry(problemId, entry);
    entry.starting = run;
    try {
      return await run;
    } finally {
      entry.starting = undefined;
    }
  }

  /**
   * [#2927] Take the lowest free offset whose host ports are actually available, keeping
   * the offsets it had to skip in the pool (they may free up, and they still count toward
   * the cap). Throws {@link PortsUnavailableError} — naming what holds each port — when
   * every free offset is blocked, rather than letting compose fail with the daemon's
   * bare message. Returns undefined only when the pool itself is empty (the cap path).
   */
  private takeUsableOffset(problemId: string): number | undefined {
    const probe = this.deps.portConflicts;
    if (!probe) return this.freeOffsets.shift();
    const blocked: PortConflict[] = [];
    for (let i = 0; i < this.freeOffsets.length; i++) {
      const candidate = this.freeOffsets[i] as number;
      const conflicts = probe(problemId, candidate);
      if (conflicts.length === 0) {
        this.freeOffsets.splice(i, 1);
        return candidate;
      }
      blocked.push(...conflicts);
    }
    if (blocked.length > 0) throw new PortsUnavailableError(problemId, blocked);
    return undefined;
  }

  private async startEntry(problemId: string, entry: Entry): Promise<number> {
    // Issue #2845: claim `starting` before the first await. `start` returns 202
    // with `statusOf(problemId)` in the body, and while eviction was awaited
    // that still read `stopped` — reporting "not started" at the one moment the
    // caller has just started it. Only reachable when every slot is taken, which
    // is exactly when eviction makes the window wide.
    entry.status = "starting";
    let offset: number | undefined;
    try {
      if (this.freeOffsets.length === 0) await this.evictLru(problemId);
      // Always take the lowest free offset so port assignment is deterministic
      // (and a freed slot is reused before climbing higher).
      this.freeOffsets.sort((a, b) => a - b);
      // [#2927] ...but skip an offset whose host ports a previous session's container is
      // still holding. Without this the pool hands out slot 0, compose fails on
      // "port is already allocated", and the participant is told nothing useful.
      offset = this.takeUsableOffset(problemId);
      if (offset === undefined) throw new Error("at capacity: no running problem to evict");
    } catch (error) {
      // Claiming `starting` early means an eviction failure must not leave the
      // entry stuck there; it owns nothing at this point, so no cleanup is due.
      entry.status = "error";
      entry.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
    try {
      await this.deps.startContainer(problemId, offset);
    } catch (error) {
      entry.status = "error";
      entry.error = error instanceof Error ? error.message : String(error);
      if (
        typeof error === "object" &&
        error !== null &&
        "retainsOwnership" in error &&
        error.retainsOwnership === true
      ) {
        entry.offset = offset;
      } else {
        this.freeOffsets.push(offset);
      }
      throw error;
    }
    entry.status = "running";
    entry.offset = offset;
    entry.lastAccessedAt = this.deps.now();
    entry.error = undefined;
    return offset;
  }

  /** Stop a running problem's container and release its port slot. No-op if not running. */
  async stop(problemId: string): Promise<void> {
    const entry = this.entries.get(problemId);
    if (!entry) return;
    if (entry.starting) {
      try {
        await entry.starting;
      } catch {
        // The failed start may have retained ownership. Re-enter stop after
        // the shared start promise settles so cleanup can use its recorded unit.
      }
      return this.stop(problemId);
    }
    if (entry.stopping) return entry.stopping;
    if ((entry.status !== "running" && entry.status !== "error") || entry.offset === undefined) {
      return;
    }
    const offset = entry.offset;
    const stopping = this.stopEntry(problemId, entry, offset);
    entry.stopping = stopping;
    try {
      await stopping;
    } finally {
      entry.stopping = undefined;
    }
  }

  private async stopEntry(problemId: string, entry: Entry, offset: number): Promise<void> {
    entry.status = "stopping";
    try {
      await this.deps.stopContainer(problemId, offset);
      entry.status = "stopped";
      entry.offset = undefined;
      entry.error = undefined;
      this.freeOffsets.push(offset);
    } catch (error) {
      // Physical ownership is retained so a later stop/reset can retry. Never
      // release an offset while its container/world may still exist.
      entry.status = "error";
      entry.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  /** Stop every running problem (session teardown). */
  async stopAll(): Promise<void> {
    const errors: unknown[] = [];
    for (const [problemId, entry] of this.entries) {
      if ((entry.status !== "running" && entry.status !== "error") || entry.offset === undefined) {
        continue;
      }
      try {
        await this.stop(problemId);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, "Problem lifecycle cleanup failed");
  }

  /** Evict the least-recently-used running problem (not `exceptId`) to free a slot. */
  private async evictLru(exceptId: string): Promise<void> {
    let victim: string | undefined;
    let oldest = Number.POSITIVE_INFINITY;
    for (const [problemId, entry] of this.entries) {
      if (problemId !== exceptId && entry.status === "running" && entry.lastAccessedAt < oldest) {
        oldest = entry.lastAccessedAt;
        victim = problemId;
      }
    }
    if (victim === undefined) throw new Error("at capacity: no running problem to evict");
    await this.stop(victim);
  }
}
