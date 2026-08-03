import { describe, expect, it, vi } from "vitest";
import {
  ProblemTerminals,
  type TerminalDeps,
  type TerminalProcess,
} from "../../../scripts/local-play/problem-terminal";

/**
 * [#2846] Shell sessions attached to running problem containers. Docker is stubbed:
 * `spawnShell` hands back a fake process whose data/exit callbacks the test drives.
 */

interface FakeShell extends TerminalProcess {
  readonly written: string[];
  readonly emit: (chunk: string) => void;
  readonly exit: (code: number | null) => void;
  readonly killed: () => number;
}

function makeDeps(over: Partial<TerminalDeps> = {}) {
  const shells: FakeShell[] = [];
  const deps: TerminalDeps = {
    statusOf: () => "running",
    spawnShell: (_problemId, handlers) => {
      const written: string[] = [];
      let kills = 0;
      const shell: FakeShell = {
        written,
        write: (data) => written.push(data),
        kill: () => {
          kills += 1;
        },
        emit: handlers.onData,
        exit: handlers.onExit,
        killed: () => kills,
      };
      shells.push(shell);
      return shell;
    },
    ...over,
  };
  return { deps, shells };
}

function makeTerminals(over: Partial<TerminalDeps> = {}, ids = ["a", "b"]) {
  const { deps, shells } = makeDeps(over);
  return { terminals: new ProblemTerminals(new Set(ids), deps), shells, deps };
}

function collector() {
  const data: string[] = [];
  const exits: Array<number | null> = [];
  return {
    data,
    exits,
    handlers: {
      onData: (chunk: string) => data.push(chunk),
      onExit: (code: number | null) => exits.push(code),
    },
  };
}

describe("ProblemTerminals: attach (#2846)", () => {
  it("should attach a shell to a running problem and pipe both directions", () => {
    const { terminals, shells } = makeTerminals();
    const sink = collector();

    const result = terminals.attach("a", sink.handlers);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    result.session.write("python show.py\n");
    expect(shells[0]?.written).toEqual(["python show.py\n"]);

    shells[0]?.emit("field p = 2013265921\n");
    expect(sink.data).toEqual(["field p = 2013265921\n"]);
    expect(terminals.countFor("a")).toBe(1);
  });

  it("should refuse a problem that is not in the catalog", () => {
    const { terminals } = makeTerminals();
    expect(terminals.attach("nope", collector().handlers)).toEqual({
      ok: false,
      reason: "unknown_problem",
    });
  });

  it.each([
    "stopped",
    "starting",
    "error",
    undefined,
  ])("should refuse to attach while the container is %s", (status) => {
    const { terminals } = makeTerminals({ statusOf: () => status });
    expect(terminals.attach("a", collector().handlers)).toEqual({
      ok: false,
      reason: "not_running",
    });
  });

  it("should cap concurrent sessions per problem", () => {
    const { terminals } = makeTerminals();
    for (let i = 0; i < 4; i++) {
      expect(terminals.attach("a", collector().handlers).ok).toBe(true);
    }
    expect(terminals.attach("a", collector().handlers)).toEqual({
      ok: false,
      reason: "too_many_sessions",
    });
    // The cap is per problem, not global.
    expect(terminals.attach("b", collector().handlers).ok).toBe(true);
  });

  it("should report a spawn failure instead of handing back a dead session", () => {
    const { terminals } = makeTerminals({
      spawnShell: () => {
        throw new Error("docker exec: no such container");
      },
    });
    expect(terminals.attach("a", collector().handlers)).toEqual({
      ok: false,
      reason: "spawn_failed",
    });
    expect(terminals.countFor("a")).toBe(0);
  });

  it("should report a shell that dies before spawn returns, and notify exactly once", () => {
    // The container can be reaped mid-attach; the adapter then fires onExit before it
    // has returned the handle. Registering that session would leave a live-looking
    // terminal attached to nothing.
    const sink = collector();
    const { terminals } = makeTerminals({
      spawnShell: (_id, handlers) => {
        handlers.onExit(137);
        return { write: () => {}, kill: () => {} };
      },
    });

    expect(terminals.attach("a", sink.handlers)).toEqual({ ok: false, reason: "spawn_failed" });
    expect(sink.exits).toEqual([137]);
    expect(terminals.countFor("a")).toBe(0);
  });
});

describe("ProblemTerminals: session end (#2846)", () => {
  it("should drop the session and notify when the shell exits on its own", () => {
    const { terminals, shells } = makeTerminals();
    const sink = collector();
    const result = terminals.attach("a", sink.handlers);

    shells[0]?.exit(0);

    expect(sink.exits).toEqual([0]);
    expect(terminals.countFor("a")).toBe(0);
    // Output and input after the end are dropped rather than delivered to a dead peer.
    shells[0]?.emit("late");
    expect(sink.data).toEqual([]);
    if (result.ok) result.session.write("late");
    expect(shells[0]?.written).toEqual([]);
  });

  it("should be idempotent when the participant closes the session", () => {
    const { terminals, shells } = makeTerminals();
    const sink = collector();
    const result = terminals.attach("a", sink.handlers);
    if (!result.ok) throw new Error("attach failed");

    result.session.close();
    result.session.close();

    expect(shells[0]?.killed()).toBe(1);
    expect(sink.exits).toEqual([null]);
    expect(terminals.countFor("a")).toBe(0);
  });

  it("should not double-notify when kill drives the adapter's exit callback", () => {
    const { terminals } = makeTerminals({
      spawnShell: (_id, handlers) => {
        const shell: TerminalProcess = {
          write: () => {},
          kill: () => handlers.onExit(143),
        };
        return shell;
      },
    });
    const sink = collector();
    const result = terminals.attach("a", sink.handlers);
    if (!result.ok) throw new Error("attach failed");

    result.session.close();

    expect(sink.exits).toEqual([143]);
  });
});

describe("ProblemTerminals: container teardown (#2846)", () => {
  it("should kill only the shells of the problem whose container is going away", () => {
    // The invariant: a shell never outlives its container. `stop` and LRU eviction
    // reclaim the container without consulting this module, so the lifecycle has to
    // close the sessions or they sit attached to nothing.
    const { terminals, shells } = makeTerminals();
    const onA = collector();
    const onB = collector();
    terminals.attach("a", onA.handlers);
    terminals.attach("b", onB.handlers);

    terminals.closeProblem("a");

    expect(shells[0]?.killed()).toBe(1);
    expect(shells[1]?.killed()).toBe(0);
    expect(onA.exits).toEqual([null]);
    expect(onB.exits).toEqual([]);
    expect(terminals.countFor("a")).toBe(0);
    expect(terminals.countFor("b")).toBe(1);
  });

  it("should reclaim a session even when the adapter never calls back", () => {
    const { terminals } = makeTerminals({
      spawnShell: () => ({ write: () => {}, kill: () => {} }),
    });
    const sink = collector();
    terminals.attach("a", sink.handlers);

    terminals.closeProblem("a");

    expect(sink.exits).toEqual([null]);
    expect(terminals.countFor("a")).toBe(0);
    // Idempotent: closing a problem with no live sessions changes nothing.
    terminals.closeProblem("a");
    expect(sink.exits).toEqual([null]);
  });

  it("should reclaim a session whose kill throws", () => {
    const { terminals } = makeTerminals({
      spawnShell: () => ({
        write: () => {},
        kill: () => {
          throw new Error("docker kill failed");
        },
      }),
    });
    const sink = collector();
    terminals.attach("a", sink.handlers);

    expect(() => terminals.closeProblem("a")).toThrow(/docker kill failed/);
    // The registry must not keep a session it can no longer control.
    expect(terminals.countFor("a")).toBe(0);
    expect(sink.exits).toEqual([null]);
  });

  it("should close every shell on session teardown", () => {
    const { terminals, shells } = makeTerminals();
    terminals.attach("a", collector().handlers);
    terminals.attach("b", collector().handlers);

    terminals.closeAll();

    expect(shells.map((s) => s.killed())).toEqual([1, 1]);
    expect(terminals.countFor("a")).toBe(0);
    expect(terminals.countFor("b")).toBe(0);
  });

  it("should give each session a distinct id", () => {
    const { terminals } = makeTerminals();
    const first = terminals.attach("a", collector().handlers);
    const second = terminals.attach("a", collector().handlers);
    if (!first.ok || !second.ok) throw new Error("attach failed");
    expect(first.session.sessionId).not.toBe(second.session.sessionId);
    expect(first.session.problemId).toBe("a");
  });
});

describe("ProblemTerminals: spawn contract (#2846)", () => {
  it("should spawn against the problem it was asked for", () => {
    const spawnShell = vi.fn(() => ({ write: () => {}, kill: () => {} }));
    const { terminals } = makeTerminals({ spawnShell });
    terminals.attach("b", collector().handlers);
    expect(spawnShell.mock.calls[0]?.[0]).toBe("b");
  });
});
