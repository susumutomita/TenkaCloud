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

import { PORT_STRIDE } from "./port-remap";

export type ProblemStatus = "stopped" | "starting" | "running" | "stopping" | "error";

export interface LifecycleDeps {
  /** Bring a problem's container up on the assigned host-port offset. */
  readonly startContainer: (problemId: string, offset: number) => Promise<void>;
  /** Tear a problem's container down (offset is the one it was started on). */
  readonly stopContainer: (problemId: string, offset: number) => Promise<void>;
  /** Monotonic clock (ms). Injected so LRU eviction is deterministic in tests. */
  readonly now: () => number;
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
  async ensureRunning(problemId: string): Promise<number> {
    const entry = this.entries.get(problemId);
    if (!entry) throw new Error(`unknown problem: ${problemId}`);
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
      offset = this.freeOffsets.shift();
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
