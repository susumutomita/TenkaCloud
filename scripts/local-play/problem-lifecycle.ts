/**
 * [#2392 Phase 2] On-demand problem lifecycle with a concurrency cap and LRU
 * idle reaping — the scalable core of local play. The warm session knows the
 * whole catalog, but only ever runs at most `maxRunning` containers at once, so
 * the catalog can grow without the machine falling over.
 *
 * This module is the pure state machine: it owns status transitions, the
 * host-port offset pool (one slot per cap unit, so the pool size *is* the cap),
 * LRU eviction, and idle reaping. Docker and the clock are injected, so it is
 * unit-tested with no containers. The API server wires real `docker compose`
 * up/down in.
 */

import { PORT_STRIDE } from "./port-remap";

export type ProblemStatus = "stopped" | "starting" | "running" | "stopping" | "error";

export interface LifecycleDeps {
  /** Bring a problem's container up on the assigned host-port offset. */
  readonly startContainer: (problemId: string, offset: number) => Promise<void>;
  /** Tear a problem's container down (offset is the one it was started on). */
  readonly stopContainer: (problemId: string, offset: number) => Promise<void>;
  /** Monotonic clock (ms). Injected so idle reaping is deterministic in tests. */
  readonly now: () => number;
}

export interface LifecycleOptions {
  /** Max simultaneously-running containers (>= 1). Also the port-pool size. */
  readonly maxRunning: number;
  /** Stop a running problem after this many ms without a `touch`. */
  readonly idleMs: number;
}

export interface ProblemLifecycleView {
  readonly problemId: string;
  readonly status: ProblemStatus;
  readonly offset?: number;
}

interface Entry {
  status: ProblemStatus;
  offset?: number;
  lastAccessedAt: number;
  error?: string;
  /** In-flight start promise, so concurrent `ensureRunning` calls share it. */
  starting?: Promise<number>;
}

export class ProblemLifecycle {
  private readonly entries = new Map<string, Entry>();
  private readonly freeOffsets: number[];

  constructor(
    problemIds: readonly string[],
    private readonly deps: LifecycleDeps,
    private readonly options: LifecycleOptions,
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
    }));
  }

  statusOf(problemId: string): ProblemStatus | undefined {
    return this.entries.get(problemId)?.status;
  }

  /** Bump last-access so an actively-played problem is not idle-reaped. No-op if not running. */
  touch(problemId: string): void {
    const entry = this.entries.get(problemId);
    if (entry?.status === "running") entry.lastAccessedAt = this.deps.now();
  }

  /**
   * Ensure a problem's container is running, starting it on demand. Concurrent
   * callers share the in-flight start. When at capacity, the least-recently-used
   * running problem is evicted first. Returns the assigned host-port offset.
   */
  async ensureRunning(problemId: string): Promise<number> {
    const entry = this.entries.get(problemId);
    if (!entry) throw new Error(`unknown problem: ${problemId}`);
    if (entry.status === "running" && entry.offset !== undefined) {
      entry.lastAccessedAt = this.deps.now();
      return entry.offset;
    }
    if (entry.starting) return entry.starting;

    const run = this.startEntry(problemId, entry);
    entry.starting = run;
    try {
      return await run;
    } finally {
      entry.starting = undefined;
    }
  }

  private async startEntry(problemId: string, entry: Entry): Promise<number> {
    if (this.freeOffsets.length === 0) await this.evictLru(problemId);
    // Always take the lowest free offset so port assignment is deterministic
    // (and a freed slot is reused before climbing higher).
    this.freeOffsets.sort((a, b) => a - b);
    const offset = this.freeOffsets.shift();
    if (offset === undefined) throw new Error("at capacity: no idle problem to evict");
    entry.status = "starting";
    try {
      await this.deps.startContainer(problemId, offset);
    } catch (error) {
      entry.status = "error";
      entry.error = error instanceof Error ? error.message : String(error);
      this.freeOffsets.push(offset);
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
    if (!entry || entry.status !== "running" || entry.offset === undefined) return;
    const offset = entry.offset;
    entry.status = "stopping";
    try {
      await this.deps.stopContainer(problemId, offset);
    } finally {
      entry.status = "stopped";
      entry.offset = undefined;
      this.freeOffsets.push(offset);
    }
  }

  /** Stop every running problem idle for longer than `idleMs`. */
  async reapIdle(): Promise<void> {
    const cutoff = this.deps.now() - this.options.idleMs;
    for (const [problemId, entry] of this.entries) {
      if (entry.status === "running" && entry.lastAccessedAt <= cutoff) {
        await this.stop(problemId);
      }
    }
  }

  /** Stop every running problem (session teardown). */
  async stopAll(): Promise<void> {
    for (const [problemId, entry] of this.entries) {
      if (entry.status === "running") await this.stop(problemId);
    }
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
    if (victim === undefined) throw new Error("at capacity: no idle problem to evict");
    await this.stop(victim);
  }
}
