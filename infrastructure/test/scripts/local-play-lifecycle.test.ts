import { describe, expect, it, vi } from "vitest";
import { PORT_STRIDE } from "../../../scripts/local-play/port-remap";
import {
  type LifecycleDeps,
  ProblemLifecycle,
} from "../../../scripts/local-play/problem-lifecycle";

/** Deps with recording docker stubs and a hand-cranked clock. */
function makeDeps(over: Partial<LifecycleDeps> = {}) {
  let clock = 1000;
  const started: Array<[string, number]> = [];
  const stopped: Array<[string, number]> = [];
  const deps: LifecycleDeps = {
    startContainer: vi.fn(async (id: string, offset: number) => {
      started.push([id, offset]);
    }),
    stopContainer: vi.fn(async (id: string, offset: number) => {
      stopped.push([id, offset]);
    }),
    now: () => clock,
    ...over,
  };
  return {
    deps,
    started,
    stopped,
    tick: (ms: number) => (clock += ms),
    setClock: (v: number) => (clock = v),
  };
}

describe("ProblemLifecycle: construction (#2392 Phase 2)", () => {
  it("should reject a non-positive maxRunning", () => {
    const { deps } = makeDeps();
    expect(() => new ProblemLifecycle(["a"], deps, { maxRunning: 0 })).toThrow(/positive integer/);
  });

  it("should start every problem stopped", () => {
    const { deps } = makeDeps();
    const lc = new ProblemLifecycle(["a", "b"], deps, { maxRunning: 2 });
    expect(lc.snapshot()).toEqual([
      { problemId: "a", status: "stopped" },
      { problemId: "b", status: "stopped" },
    ]);
  });
});

describe("ProblemLifecycle: on-demand start (#2392 Phase 2)", () => {
  it("should start a stopped problem on offset 0 and mark it running", async () => {
    const { deps, started } = makeDeps();
    const lc = new ProblemLifecycle(["a", "b"], deps, { maxRunning: 2 });
    const offset = await lc.ensureRunning("a");
    expect(offset).toBe(0);
    expect(started).toEqual([["a", 0]]);
    expect(lc.statusOf("a")).toBe("running");
  });

  it("should give each running problem a distinct port block", async () => {
    const { deps } = makeDeps();
    const lc = new ProblemLifecycle(["a", "b"], deps, { maxRunning: 2 });
    expect(await lc.ensureRunning("a")).toBe(0);
    expect(await lc.ensureRunning("b")).toBe(PORT_STRIDE);
  });

  it("should be idempotent + touch when already running (no second container start)", async () => {
    const { deps, started, tick } = makeDeps();
    const lc = new ProblemLifecycle(["a"], deps, { maxRunning: 1 });
    await lc.ensureRunning("a");
    tick(500);
    const again = await lc.ensureRunning("a");
    expect(again).toBe(0);
    expect(started).toHaveLength(1); // not restarted
  });

  it("should share the in-flight start between concurrent callers", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const { deps } = makeDeps({
      startContainer: vi.fn(async () => {
        await gate;
      }),
    });
    const lc = new ProblemLifecycle(["a"], deps, { maxRunning: 1 });
    const p1 = lc.ensureRunning("a");
    const p2 = lc.ensureRunning("a");
    release();
    await Promise.all([p1, p2]);
    expect(deps.startContainer).toHaveBeenCalledTimes(1);
  });

  it("should reject an unknown problem", async () => {
    const { deps } = makeDeps();
    const lc = new ProblemLifecycle(["a"], deps, { maxRunning: 1 });
    await expect(lc.ensureRunning("nope")).rejects.toThrow(/unknown problem/);
  });

  it("should mark error and release the slot when the container fails to start", async () => {
    const { deps } = makeDeps({
      startContainer: vi.fn(async () => {
        throw new Error("compose boom");
      }),
    });
    const lc = new ProblemLifecycle(["a", "b"], deps, { maxRunning: 1 });
    await expect(lc.ensureRunning("a")).rejects.toThrow(/compose boom/);
    expect(lc.statusOf("a")).toBe("error");
    // 非同期 start (202) の失敗理由は errorOf 経由で view の lastError に届く。
    expect(lc.errorOf("a")).toBe("compose boom");
    // the slot was released, so another problem can still start
    const { deps: ok } = makeDeps();
    const lc2 = new ProblemLifecycle(["a"], ok, { maxRunning: 1 });
    expect(await lc2.ensureRunning("a")).toBe(0);
    // error 状態でない問題 (running / 未登場) は lastError を持たない。
    expect(lc2.errorOf("a")).toBeUndefined();
    expect(lc2.errorOf("never-started")).toBeUndefined();
  });

  it("should retain the slot when failed-start cleanup still owns a container", async () => {
    const ownershipError = Object.assign(new Error("cleanup failed"), {
      retainsOwnership: true,
    });
    const stopped: string[] = [];
    const { deps } = makeDeps({
      startContainer: async () => {
        throw ownershipError;
      },
      stopContainer: async (id) => {
        stopped.push(id);
      },
    });
    const lifecycle = new ProblemLifecycle(["a"], deps, { maxRunning: 1 });

    await expect(lifecycle.ensureRunning("a")).rejects.toThrow("cleanup failed");
    expect(lifecycle.snapshot()).toEqual([
      { problemId: "a", status: "error", offset: 0, cleanupRequired: true },
    ]);
    await lifecycle.stop("a");
    expect(stopped).toEqual(["a"]);
    expect(lifecycle.statusOf("a")).toBe("stopped");
  });

  it("should tear down retained ownership before a retry start", async () => {
    let starts = 0;
    const events: string[] = [];
    const { deps } = makeDeps({
      startContainer: async () => {
        starts += 1;
        events.push(`start-${starts}`);
        if (starts === 1) {
          throw Object.assign(new Error("start cleanup incomplete"), {
            retainsOwnership: true,
          });
        }
      },
      stopContainer: async () => {
        events.push("stop-retained");
      },
    });
    const lifecycle = new ProblemLifecycle(["a"], deps, { maxRunning: 1 });

    await expect(lifecycle.ensureRunning("a")).rejects.toThrow("start cleanup incomplete");
    await expect(lifecycle.ensureRunning("a")).resolves.toBe(0);
    expect(events).toEqual(["start-1", "stop-retained", "start-2"]);
    expect(lifecycle.statusOf("a")).toBe("running");
  });
});

describe("ProblemLifecycle: concurrency cap + LRU eviction (#2392 Phase 2)", () => {
  it("should evict the least-recently-used running problem when at capacity", async () => {
    const { deps, started, stopped, tick, setClock } = makeDeps();
    const lc = new ProblemLifecycle(["a", "b", "c"], deps, { maxRunning: 2 });
    setClock(1000);
    await lc.ensureRunning("a"); // a @ t=1000
    tick(10);
    await lc.ensureRunning("b"); // b @ t=1010
    tick(10);
    lc.touch("a"); // a re-touched @ t=1020, so b is now the LRU
    tick(10);
    await lc.ensureRunning("c"); // at cap → evict LRU (b), then start c
    expect(stopped).toEqual([["b", PORT_STRIDE]]); // b evicted, freeing its offset
    expect(started).toEqual([
      ["a", 0],
      ["b", PORT_STRIDE],
      ["c", PORT_STRIDE], // c reuses the freed slot
    ]);
    expect(lc.statusOf("b")).toBe("stopped");
    expect(lc.statusOf("c")).toBe("running");
  });

  it("should report starting while eviction is still in flight (Issue #2845)", async () => {
    // POST /start answers 202 with `statusOf()` without awaiting the start. While the
    // entry was still evicting, that snapshot read a literal "stopped" — the portal
    // takes that as "nothing happened" and leaves the Start button up.
    let releaseEviction: (() => void) | undefined;
    const evicting = new Promise<void>((resolve) => {
      releaseEviction = resolve;
    });
    const { deps } = makeDeps({
      stopContainer: vi.fn(async () => {
        await evicting;
      }),
    });
    const lc = new ProblemLifecycle(["a", "b"], deps, { maxRunning: 1 });
    await lc.ensureRunning("a");

    const pending = lc.ensureRunning("b"); // at cap → suspends inside evictLru
    expect(lc.statusOf("b")).toBe("starting");

    releaseEviction?.();
    await pending;
    expect(lc.statusOf("b")).toBe("running");
  });

  it("should surface an eviction failure instead of staying stuck in starting", async () => {
    const { deps } = makeDeps({
      stopContainer: vi.fn(async () => {
        throw new Error("docker rm refused");
      }),
    });
    const lc = new ProblemLifecycle(["a", "b"], deps, { maxRunning: 1 });
    await lc.ensureRunning("a");

    await expect(lc.ensureRunning("b")).rejects.toThrow(/docker rm refused/);
    expect(lc.statusOf("b")).toBe("error");
  });
});

describe("ProblemLifecycle: explicit stop / stop-all (#2392 Phase 2, #2512)", () => {
  it("should stop a running problem and free its slot", async () => {
    const { deps, stopped } = makeDeps();
    const lc = new ProblemLifecycle(["a"], deps, { maxRunning: 1 });
    await lc.ensureRunning("a");
    await lc.stop("a");
    expect(stopped).toEqual([["a", 0]]);
    expect(lc.statusOf("a")).toBe("stopped");
    // slot freed → can start again on offset 0
    expect(await lc.ensureRunning("a")).toBe(0);
  });

  it("should no-op stop for a problem that is not running", async () => {
    const { deps, stopped } = makeDeps();
    const lc = new ProblemLifecycle(["a"], deps, { maxRunning: 1 });
    await lc.stop("a");
    await lc.stop("nope");
    expect(stopped).toEqual([]);
  });

  it("should finish an in-flight start before honoring a concurrent stop", async () => {
    let releaseStart = (): void => {};
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const { deps, stopped } = makeDeps({
      startContainer: async () => startGate,
    });
    const lifecycle = new ProblemLifecycle(["a"], deps, { maxRunning: 1 });

    const starting = lifecycle.ensureRunning("a");
    const stopping = lifecycle.stop("a");
    expect(lifecycle.statusOf("a")).toBe("starting");
    releaseStart();
    await Promise.all([starting, stopping]);

    expect(stopped).toEqual([["a", 0]]);
    expect(lifecycle.statusOf("a")).toBe("stopped");
  });

  it("should wait for an in-flight stop before restarting the same problem", async () => {
    let releaseStop = (): void => {};
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const { deps, started } = makeDeps({
      stopContainer: async () => stopGate,
    });
    const lifecycle = new ProblemLifecycle(["a"], deps, { maxRunning: 1 });
    await lifecycle.ensureRunning("a");

    const stopping = lifecycle.stop("a");
    const restarting = lifecycle.ensureRunning("a");
    expect(lifecycle.statusOf("a")).toBe("stopping");
    releaseStop();
    await Promise.all([stopping, restarting]);

    expect(started).toEqual([
      ["a", 0],
      ["a", 0],
    ]);
    expect(lifecycle.statusOf("a")).toBe("running");
  });

  it("should keep running problems up no matter how long they sit untouched (#2512)", async () => {
    const { deps, stopped, tick } = makeDeps();
    const lc = new ProblemLifecycle(["a", "b"], deps, { maxRunning: 2 });
    await lc.ensureRunning("a");
    await lc.ensureRunning("b");
    tick(365 * 24 * 60 * 60 * 1000); // a year of inactivity — no time-based stop
    expect(stopped).toEqual([]);
    expect(lc.statusOf("a")).toBe("running");
    expect(lc.statusOf("b")).toBe("running");
  });

  it("should ignore touch for a problem that is not running", async () => {
    const { deps, stopped } = makeDeps();
    const lc = new ProblemLifecycle(["a"], deps, { maxRunning: 1 });
    lc.touch("a"); // stopped → no-op
    lc.touch("nope"); // unknown → no-op
    expect(stopped).toEqual([]);
    expect(lc.statusOf("a")).toBe("stopped");
  });

  it("should stop every running problem on stopAll", async () => {
    const { deps, stopped } = makeDeps();
    const lc = new ProblemLifecycle(["a", "b"], deps, { maxRunning: 2 });
    await lc.ensureRunning("a");
    await lc.ensureRunning("b");
    await lc.stopAll();
    expect(stopped.map(([id]) => id).sort()).toEqual(["a", "b"]);
    expect(lc.snapshot().every((v) => v.status === "stopped")).toBe(true);
  });

  it("should stop every remaining problem before returning an aggregate failure", async () => {
    const attempted: string[] = [];
    let failFirstAStop = true;
    const { deps } = makeDeps({
      stopContainer: async (id) => {
        attempted.push(id);
        if (id === "a" && failFirstAStop) {
          failFirstAStop = false;
          throw new Error("a stop failed");
        }
      },
    });
    const lc = new ProblemLifecycle(["a", "b"], deps, { maxRunning: 2 });
    await lc.ensureRunning("a");
    await lc.ensureRunning("b");

    await expect(lc.stopAll()).rejects.toThrow("Problem lifecycle cleanup failed");
    expect(attempted).toEqual(["a", "b"]);
    expect(lc.snapshot()).toEqual([
      { problemId: "a", status: "error", offset: 0, cleanupRequired: true },
      { problemId: "b", status: "stopped" },
    ]);

    await expect(lc.stopAll()).resolves.toBeUndefined();
    expect(attempted).toEqual(["a", "b", "a"]);
    expect(lc.snapshot().every((value) => value.status === "stopped")).toBe(true);
  });
});
