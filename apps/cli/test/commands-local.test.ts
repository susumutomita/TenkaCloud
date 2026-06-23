import { beforeEach, describe, expect, it, vi } from "vitest";
import { type LocalDeps, type LocalState, runLocal } from "../src/commands/local.ts";

/**
 * Unit tests for `runLocal(args, deps)` — the `tenkacloud local` subcommand
 * dispatcher. Everything that touches the outside world (fs / spawn / kill /
 * fetch / browser / blocking) is injected via `deps`, so these tests use no real
 * filesystem, process, or network: only in-memory fakes and `vi.fn()` doubles.
 *
 * The fs fake is backed by a single Map for read/write/exists, plus configurable
 * `readdirSync` / `statIsDirectory` so `loadLocalCatalog` (called inside `up` and
 * `serve`) returns a controlled catalog.
 */

const PROBLEMS_DIR = "/work/problems";
const LOCAL_DIR = "/work/.tenkacloud/local";
const STATE_PATH = `${LOCAL_DIR}/state.json`;
const RUNTIME_CONFIG = "/work/portal/runtime-config.json";

/** Deterministic env so paths never depend on homedir() / cwd(). */
function baseEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    TENKACLOUD_LOCAL_DIR: LOCAL_DIR,
    TENKACLOUD_PROBLEMS_DIR: PROBLEMS_DIR,
    TENKACLOUD_PORTAL_RUNTIME_CONFIG: RUNTIME_CONFIG,
    TENKACLOUD_CLI_BIN: "/work/bin/tenkacloud.ts",
    ...extra,
  };
}

interface FakeFs {
  readonly fs: LocalDeps["fs"];
  readonly files: Map<string, string>;
  readonly mkdirCalls: string[];
  readonly rmCalls: string[];
}

/**
 * In-memory fs fake. `files` is the backing store for read/write/exists. The
 * catalog-specific paths (`<problemsDir>/challenges` etc.) are made to "exist"
 * as directories via `dirs`, with `readdirSync`/`statIsDirectory` honoring them.
 */
function makeFs(
  opts: { files?: Record<string, string>; dirs?: Record<string, readonly string[]> } = {},
): FakeFs {
  const files = new Map<string, string>(Object.entries(opts.files ?? {}));
  const dirs = opts.dirs ?? {};
  const dirChildren = new Set<string>();
  for (const [dir, entries] of Object.entries(dirs)) {
    for (const e of entries) dirChildren.add(`${dir}/${e}`);
  }
  const mkdirCalls: string[] = [];
  const rmCalls: string[] = [];

  const fs: LocalDeps["fs"] = {
    existsSync(path: string): boolean {
      if (files.has(path)) return true;
      if (path in dirs) return true;
      return dirChildren.has(path);
    },
    readFileSync(path: string, encoding: "utf8"): string {
      expect(encoding).toBe("utf8");
      const content = files.get(path);
      if (content === undefined) throw new Error(`no such file: ${path}`);
      return content;
    },
    writeFileSync(path: string, data: string): void {
      files.set(path, data);
    },
    mkdirSync(path: string, options: { recursive: true }): void {
      expect(options.recursive).toBe(true);
      mkdirCalls.push(path);
    },
    rmSync(path: string, options: { force: true }): void {
      expect(options.force).toBe(true);
      rmCalls.push(path);
      files.delete(path);
    },
    statIsDirectory(path: string): boolean {
      return path in dirs;
    },
    readdirSync(path: string): readonly string[] {
      return dirs[path] ?? [];
    },
  };
  return { fs, files, mkdirCalls, rmCalls };
}

/** A non-empty catalog: one challenge problem with valid metadata.json. */
function catalogDirs(): Record<string, readonly string[]> {
  return { [`${PROBLEMS_DIR}/challenges`]: ["c1"] };
}
function catalogFiles(): Record<string, string> {
  return {
    [`${PROBLEMS_DIR}/challenges/c1/metadata.json`]: JSON.stringify({
      id: "c1",
      name: "Challenge One",
      category: "Challenge",
      scoring: { kind: "flag", points: 100 },
    }),
  };
}

function stateJson(state: Partial<LocalState>): string {
  const full: LocalState = {
    pid: 4242,
    port: 3199,
    apiBaseUrl: "http://127.0.0.1:3199",
    runtimeConfigPath: RUNTIME_CONFIG,
    ...state,
  };
  return JSON.stringify(full, null, 2);
}

let lines: string[];
const out = (line: string) => {
  lines.push(line);
};

beforeEach(() => {
  lines = [];
});

// ---------------------------------------------------------------------------
// runLocal dispatch
// ---------------------------------------------------------------------------

describe("runLocal dispatch", () => {
  it("should print usage and return 0 when no subcommand is given", async () => {
    const { fs } = makeFs();
    const code = await runLocal([], { out, env: baseEnv(), fs, spawnDetached: vi.fn() });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("tenkacloud local — self-paced local mode");
  });

  it("should print usage and return 1 on an unknown subcommand", async () => {
    const { fs } = makeFs();
    const code = await runLocal(["frobnicate"], {
      out,
      env: baseEnv(),
      fs,
      spawnDetached: vi.fn(),
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("local up [problemId]");
  });

  it("should dispatch to up", async () => {
    const { fs } = makeFs({ dirs: catalogDirs(), files: catalogFiles() });
    const code = await runLocal(["up"], {
      out,
      env: baseEnv(),
      fs,
      spawnDetached: vi.fn(() => 100),
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("Local API starting");
  });

  it("should dispatch to serve", async () => {
    const { fs } = makeFs({ dirs: catalogDirs(), files: catalogFiles() });
    const startApi = vi.fn(async () => ({ port: 3199, state: {} as never, close: vi.fn() }));
    const code = await runLocal(["serve"], {
      out,
      env: baseEnv(),
      fs,
      spawnDetached: vi.fn(),
      startApi: startApi as never,
      block: vi.fn(async () => {}),
    });
    expect(code).toBe(0);
    expect(startApi).toHaveBeenCalled();
  });

  it("should dispatch to open", async () => {
    const { fs } = makeFs();
    const code = await runLocal(["open", "http://x"], {
      out,
      env: baseEnv(),
      fs,
      spawnDetached: vi.fn(),
      openBrowser: vi.fn(),
    });
    expect(code).toBe(0);
  });

  it("should dispatch to status", async () => {
    const { fs } = makeFs({ files: { [STATE_PATH]: stateJson({}) } });
    const fetchImpl = vi.fn(async () => new Response("", { status: 200 }));
    const code = await runLocal(["status"], {
      out,
      env: baseEnv(),
      fs,
      spawnDetached: vi.fn(),
      fetchImpl: fetchImpl as never,
    });
    expect(code).toBe(0);
  });

  it("should dispatch to evaluate", async () => {
    const { fs } = makeFs({ files: { [STATE_PATH]: stateJson({}) } });
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ kind: "ok", totalScore: 100 }), { status: 200 }),
    );
    const code = await runLocal(["evaluate", "c1", "TC{x}"], {
      out,
      env: baseEnv(),
      fs,
      spawnDetached: vi.fn(),
      fetchImpl: fetchImpl as never,
    });
    expect(code).toBe(0);
  });

  it("should dispatch to down", async () => {
    const { fs } = makeFs({ files: { [STATE_PATH]: stateJson({}) } });
    const code = await runLocal(["down"], {
      out,
      env: baseEnv(),
      fs,
      spawnDetached: vi.fn(),
      kill: vi.fn(),
    });
    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// up
// ---------------------------------------------------------------------------

describe("runLocal up", () => {
  it("should return 1 and warn when the catalog is empty", async () => {
    const { fs } = makeFs(); // no problems dir → empty catalog
    const spawnDetached = vi.fn(() => 1);
    const code = await runLocal(["up"], { out, env: baseEnv(), fs, spawnDetached });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain(`No problems found under ${PROBLEMS_DIR}`);
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  it("should return 1 when a positional problemId is not in the catalog", async () => {
    const { fs } = makeFs({ dirs: catalogDirs(), files: catalogFiles() });
    const spawnDetached = vi.fn(() => 1);
    const code = await runLocal(["up", "does-not-exist"], {
      out,
      env: baseEnv(),
      fs,
      spawnDetached,
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("Unknown problem: does-not-exist");
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  it("should start the API, write configs, and return 0 without a problemId", async () => {
    const { fs, files, mkdirCalls } = makeFs({ dirs: catalogDirs(), files: catalogFiles() });
    const spawnDetached = vi.fn(() => 7777);
    const code = await runLocal(["up"], { out, env: baseEnv(), fs, spawnDetached });

    expect(code).toBe(0);
    expect(mkdirCalls).toContain(LOCAL_DIR);
    expect(spawnDetached).toHaveBeenCalledWith("/work/bin/tenkacloud.ts", [
      "local",
      "serve",
      "--port",
      "3199",
    ]);

    const runtime = JSON.parse(files.get(RUNTIME_CONFIG) ?? "");
    expect(runtime.mode).toBe("backend");
    expect(runtime.apiBaseUrl).toBe("http://127.0.0.1:3199");

    const state = JSON.parse(files.get(STATE_PATH) ?? "");
    expect(state.pid).toBe(7777);
    expect(state.port).toBe(3199);
    expect(state.apiBaseUrl).toBe("http://127.0.0.1:3199");
    expect(state.problemId).toBeUndefined();

    expect(lines.join("\n")).toContain("Local API starting on http://127.0.0.1:3199 (pid 7777)");
    expect(lines.join("\n")).toContain(`Wrote portal runtime-config: ${RUNTIME_CONFIG}`);
  });

  it("should record problemId in state when a valid problemId is given", async () => {
    const { fs, files } = makeFs({ dirs: catalogDirs(), files: catalogFiles() });
    const code = await runLocal(["up", "c1"], {
      out,
      env: baseEnv(),
      fs,
      spawnDetached: vi.fn(() => 9),
    });
    expect(code).toBe(0);
    const state = JSON.parse(files.get(STATE_PATH) ?? "");
    expect(state.problemId).toBe("c1");
  });

  it("should honor a valid --port argument", async () => {
    const { fs, files } = makeFs({ dirs: catalogDirs(), files: catalogFiles() });
    const spawnDetached = vi.fn(() => 1);
    await runLocal(["up", "--port", "4000"], { out, env: baseEnv(), fs, spawnDetached });
    expect(spawnDetached).toHaveBeenCalledWith("/work/bin/tenkacloud.ts", [
      "local",
      "serve",
      "--port",
      "4000",
    ]);
    const state = JSON.parse(files.get(STATE_PATH) ?? "");
    expect(state.port).toBe(4000);
    expect(state.apiBaseUrl).toBe("http://127.0.0.1:4000");
  });

  it("should fall back to TENKACLOUD_LOCAL_PORT when --port is absent", async () => {
    const { fs, files } = makeFs({ dirs: catalogDirs(), files: catalogFiles() });
    await runLocal(["up"], {
      out,
      env: baseEnv({ TENKACLOUD_LOCAL_PORT: "5050" }),
      fs,
      spawnDetached: vi.fn(() => 1),
    });
    const state = JSON.parse(files.get(STATE_PATH) ?? "");
    expect(state.port).toBe(5050);
  });

  it("should fall back to the default port when neither --port nor env is set", async () => {
    const { fs, files } = makeFs({ dirs: catalogDirs(), files: catalogFiles() });
    await runLocal(["up"], {
      out,
      env: baseEnv({ TENKACLOUD_LOCAL_PORT: "" }),
      fs,
      spawnDetached: vi.fn(() => 1),
    });
    const state = JSON.parse(files.get(STATE_PATH) ?? "");
    expect(state.port).toBe(3199);
  });

  it("should derive cliBin from env when deps.cliBin is absent", async () => {
    const { fs } = makeFs({ dirs: catalogDirs(), files: catalogFiles() });
    const spawnDetached = vi.fn(() => 1);
    await runLocal(["up"], {
      out,
      env: baseEnv({ TENKACLOUD_CLI_BIN: "/from/env/cli.ts" }),
      fs,
      spawnDetached,
    });
    expect(spawnDetached.mock.calls[0]?.[0]).toBe("/from/env/cli.ts");
  });

  it("should prefer deps.cliBin over the env CLI bin", async () => {
    const { fs } = makeFs({ dirs: catalogDirs(), files: catalogFiles() });
    const spawnDetached = vi.fn(() => 1);
    await runLocal(["up"], {
      out,
      env: baseEnv({ TENKACLOUD_CLI_BIN: "/from/env/cli.ts" }),
      fs,
      spawnDetached,
      cliBin: "/explicit/cli.ts",
    });
    expect(spawnDetached.mock.calls[0]?.[0]).toBe("/explicit/cli.ts");
  });

  it("should derive cliBin from the default cwd path when nothing else is set", async () => {
    // Neither deps.cliBin nor env.TENKACLOUD_CLI_BIN → the final
    // `?? join(cwd, "apps", "cli", "bin", "tenkacloud.ts")` default arm. We keep
    // a real problems dir so the catalog is non-empty and the line is reached.
    const env = baseEnv();
    delete env.TENKACLOUD_CLI_BIN;
    const { fs } = makeFs({ dirs: catalogDirs(), files: catalogFiles() });
    const spawnDetached = vi.fn(() => 1);
    const code = await runLocal(["up"], { out, env, fs, spawnDetached });
    expect(code).toBe(0);
    expect(String(spawnDetached.mock.calls[0]?.[0])).toContain("apps/cli/bin/tenkacloud.ts");
  });
});

// ---------------------------------------------------------------------------
// serve
// ---------------------------------------------------------------------------

describe("runLocal serve", () => {
  it("should call startApi with the parsed port + catalog, print, close, return 0", async () => {
    const { fs } = makeFs({ dirs: catalogDirs(), files: catalogFiles() });
    const close = vi.fn(async () => {});
    const startApi = vi.fn(async () => ({ port: 4321, state: {} as never, close }));
    const block = vi.fn(async () => {});
    const code = await runLocal(["serve", "--port", "4321"], {
      out,
      env: baseEnv(),
      fs,
      spawnDetached: vi.fn(),
      startApi: startApi as never,
      block,
    });
    expect(code).toBe(0);
    expect(startApi).toHaveBeenCalledTimes(1);
    const [portArg, catalogArg, teamArg] = startApi.mock.calls[0] ?? [];
    expect(portArg).toBe(4321);
    expect(Array.isArray(catalogArg)).toBe(true);
    expect((catalogArg as unknown[]).length).toBe(1);
    expect(teamArg).toBe("Local Player");
    expect(block).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(lines.join("\n")).toContain(
      "Local Participant API listening on http://127.0.0.1:4321 (1 problems).",
    );
  });

  it("should fall back to the default port when --port is absent", async () => {
    const { fs } = makeFs({ dirs: catalogDirs(), files: catalogFiles() });
    const startApi = vi.fn(async () => ({ port: 3199, state: {} as never, close: vi.fn() }));
    await runLocal(["serve"], {
      out,
      env: baseEnv(),
      fs,
      spawnDetached: vi.fn(),
      startApi: startApi as never,
      block: vi.fn(async () => {}),
    });
    expect(startApi.mock.calls[0]?.[0]).toBe(3199);
  });

  it("should use the env port for serve when --port is absent", async () => {
    const { fs } = makeFs({ dirs: catalogDirs(), files: catalogFiles() });
    const startApi = vi.fn(async () => ({ port: 6000, state: {} as never, close: vi.fn() }));
    await runLocal(["serve"], {
      out,
      env: baseEnv({ TENKACLOUD_LOCAL_PORT: "6000" }),
      fs,
      spawnDetached: vi.fn(),
      startApi: startApi as never,
      block: vi.fn(async () => {}),
    });
    expect(startApi.mock.calls[0]?.[0]).toBe(6000);
  });
});

// ---------------------------------------------------------------------------
// open
// ---------------------------------------------------------------------------

describe("runLocal open", () => {
  it("should return 1 when neither a url arg nor running state exists", async () => {
    const { fs } = makeFs();
    const openBrowser = vi.fn();
    const code = await runLocal(["open"], {
      out,
      env: baseEnv(),
      fs,
      spawnDetached: vi.fn(),
      openBrowser,
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("Local mode is not running");
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it("should open a url positional and return 0 when openBrowser is provided", async () => {
    const { fs } = makeFs();
    const openBrowser = vi.fn();
    const code = await runLocal(["open", "http://example.test"], {
      out,
      env: baseEnv(),
      fs,
      spawnDetached: vi.fn(),
      openBrowser,
    });
    expect(code).toBe(0);
    expect(openBrowser).toHaveBeenCalledWith("http://example.test");
    expect(lines.join("\n")).toContain("Opened http://example.test");
  });

  it("should open the default url when state is present and no url arg", async () => {
    const { fs } = makeFs({ files: { [STATE_PATH]: stateJson({}) } });
    const openBrowser = vi.fn();
    const code = await runLocal(["open"], {
      out,
      env: baseEnv(),
      fs,
      spawnDetached: vi.fn(),
      openBrowser,
    });
    expect(code).toBe(0);
    expect(openBrowser).toHaveBeenCalledWith("http://localhost:5175");
  });

  it("should use TENKACLOUD_PORTAL_URL when set and state is present", async () => {
    const { fs } = makeFs({ files: { [STATE_PATH]: stateJson({}) } });
    const openBrowser = vi.fn();
    await runLocal(["open"], {
      out,
      env: baseEnv({ TENKACLOUD_PORTAL_URL: "http://portal.test:9999" }),
      fs,
      spawnDetached: vi.fn(),
      openBrowser,
    });
    expect(openBrowser).toHaveBeenCalledWith("http://portal.test:9999");
  });

  it("should print instructions when openBrowser is not provided", async () => {
    const { fs } = makeFs();
    const code = await runLocal(["open", "http://noopen.test"], {
      out,
      env: baseEnv(),
      fs,
      spawnDetached: vi.fn(),
      // openBrowser intentionally omitted → falls into the "print" branch
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("Open http://noopen.test in your browser.");
  });
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

describe("runLocal status", () => {
  it("should return 1 when there is no state", async () => {
    const { fs } = makeFs();
    const code = await runLocal(["status"], {
      out,
      env: baseEnv(),
      fs,
      spawnDetached: vi.fn(),
      fetchImpl: vi.fn() as never,
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("Local mode: not running.");
  });

  it("should report running and return 0 when the health check is ok", async () => {
    const { fs } = makeFs({ files: { [STATE_PATH]: stateJson({ pid: 55 }) } });
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const code = await runLocal(["status"], {
      out,
      env: baseEnv(),
      fs,
      spawnDetached: vi.fn(),
      fetchImpl: fetchImpl as never,
    });
    expect(code).toBe(0);
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:3199/healthz");
    expect(lines.join("\n")).toContain("Local mode: running");
    expect(lines.join("\n")).toContain("api:  http://127.0.0.1:3199 (pid 55)");
  });

  it("should report unreachable and return 1 when the health check is not ok", async () => {
    const { fs } = makeFs({ files: { [STATE_PATH]: stateJson({}) } });
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 503 }));
    const code = await runLocal(["status"], {
      out,
      env: baseEnv(),
      fs,
      spawnDetached: vi.fn(),
      fetchImpl: fetchImpl as never,
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("state present but API unreachable");
  });

  it("should report unreachable and return 1 when fetch throws", async () => {
    const { fs } = makeFs({ files: { [STATE_PATH]: stateJson({}) } });
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const code = await runLocal(["status"], {
      out,
      env: baseEnv(),
      fs,
      spawnDetached: vi.fn(),
      fetchImpl: fetchImpl as never,
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("state present but API unreachable");
  });

  it("should print the problem line when state carries a problemId", async () => {
    const { fs } = makeFs({ files: { [STATE_PATH]: stateJson({ problemId: "c1" }) } });
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const code = await runLocal(["status"], {
      out,
      env: baseEnv(),
      fs,
      spawnDetached: vi.fn(),
      fetchImpl: fetchImpl as never,
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("problem: c1");
  });
});

// ---------------------------------------------------------------------------
// evaluate
// ---------------------------------------------------------------------------

describe("runLocal evaluate", () => {
  it("should return 2 and print usage when args are missing", async () => {
    const { fs } = makeFs({ files: { [STATE_PATH]: stateJson({}) } });
    const fetchImpl = vi.fn();
    const code = await runLocal(["evaluate", "only-problem"], {
      out,
      env: baseEnv(),
      fs,
      spawnDetached: vi.fn(),
      fetchImpl: fetchImpl as never,
    });
    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("Usage: tenkacloud local evaluate <problemId> <flag>");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("should return 1 when there is no running state", async () => {
    const { fs } = makeFs();
    const fetchImpl = vi.fn();
    const code = await runLocal(["evaluate", "c1", "TC{x}"], {
      out,
      env: baseEnv(),
      fs,
      spawnDetached: vi.fn(),
      fetchImpl: fetchImpl as never,
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("Local mode is not running");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("should report success and return 0 when the outcome is ok", async () => {
    const { fs } = makeFs({ files: { [STATE_PATH]: stateJson({}) } });
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ kind: "ok", totalScore: 150 }), { status: 200 }),
    );
    const code = await runLocal(["evaluate", "c1", "TC{x}"], {
      out,
      env: baseEnv(),
      fs,
      spawnDetached: vi.fn(),
      fetchImpl: fetchImpl as never,
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("Correct! total score: 150");
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("http://127.0.0.1:3199/portal/me/submit-flag");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      problemId: "c1",
      flag: "TC{x}",
    });
  });

  it("should report already solved and return 0 when already_scored", async () => {
    const { fs } = makeFs({ files: { [STATE_PATH]: stateJson({}) } });
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ kind: "already_scored" }), { status: 200 }),
    );
    const code = await runLocal(["evaluate", "c1", "TC{x}"], {
      out,
      env: baseEnv(),
      fs,
      spawnDetached: vi.fn(),
      fetchImpl: fetchImpl as never,
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("Already solved.");
  });

  it("should report incorrect with the score and return 1 when wrong", async () => {
    const { fs } = makeFs({ files: { [STATE_PATH]: stateJson({}) } });
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ kind: "wrong", totalScore: 20 }), { status: 200 }),
    );
    const code = await runLocal(["evaluate", "c1", "WRONG"], {
      out,
      env: baseEnv(),
      fs,
      spawnDetached: vi.fn(),
      fetchImpl: fetchImpl as never,
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("Incorrect. total score: 20");
  });

  it("should default the incorrect score to 0 when totalScore is absent", async () => {
    const { fs } = makeFs({ files: { [STATE_PATH]: stateJson({}) } });
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ kind: "wrong" }), { status: 200 }),
    );
    const code = await runLocal(["evaluate", "c1", "WRONG"], {
      out,
      env: baseEnv(),
      fs,
      spawnDetached: vi.fn(),
      fetchImpl: fetchImpl as never,
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("Incorrect. total score: 0");
  });

  it("should filter out --flags so the positionals are problemId + flag", async () => {
    const { fs } = makeFs({ files: { [STATE_PATH]: stateJson({}) } });
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ kind: "ok", totalScore: 1 }), { status: 200 }),
    );
    const code = await runLocal(["evaluate", "--verbose", "c1", "--dry", "TC{x}"], {
      out,
      env: baseEnv(),
      fs,
      spawnDetached: vi.fn(),
      fetchImpl: fetchImpl as never,
    });
    expect(code).toBe(0);
    const [, init] = fetchImpl.mock.calls[0] ?? [];
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      problemId: "c1",
      flag: "TC{x}",
    });
  });
});

// ---------------------------------------------------------------------------
// down
// ---------------------------------------------------------------------------

describe("runLocal down", () => {
  it("should return 0 and say nothing to stop when there is no state", async () => {
    const { fs, rmCalls } = makeFs();
    const kill = vi.fn();
    const code = await runLocal(["down"], {
      out,
      env: baseEnv(),
      fs,
      spawnDetached: vi.fn(),
      kill,
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("nothing to stop");
    expect(kill).not.toHaveBeenCalled();
    expect(rmCalls).toEqual([]);
  });

  it("should kill the pid, remove state, and return 0 when state is present", async () => {
    const { fs, rmCalls } = makeFs({ files: { [STATE_PATH]: stateJson({ pid: 321 }) } });
    const kill = vi.fn();
    const code = await runLocal(["down"], {
      out,
      env: baseEnv(),
      fs,
      spawnDetached: vi.fn(),
      kill,
    });
    expect(code).toBe(0);
    expect(kill).toHaveBeenCalledWith(321);
    expect(rmCalls).toContain(STATE_PATH);
    expect(lines.join("\n")).toContain("Stopped local mode (pid 321).");
  });

  it("should still clean up state and return 0 when kill throws", async () => {
    const { fs, rmCalls } = makeFs({ files: { [STATE_PATH]: stateJson({ pid: 999 }) } });
    const kill = vi.fn(() => {
      throw new Error("ESRCH: no such process");
    });
    const code = await runLocal(["down"], {
      out,
      env: baseEnv(),
      fs,
      spawnDetached: vi.fn(),
      kill,
    });
    expect(code).toBe(0);
    expect(rmCalls).toContain(STATE_PATH);
    expect(lines.join("\n")).toContain("Stopped local mode (pid 999).");
  });
});

// ---------------------------------------------------------------------------
// parsePort / firstPositional / readState edge branches
// ---------------------------------------------------------------------------

describe("runLocal argument parsing edges", () => {
  it("should ignore --port with no following value (uses env/default)", async () => {
    // `up --port` with no value: args[idx+1] is undefined → parsePort falls
    // through to env (6789).
    const { fs, files } = makeFs({ dirs: catalogDirs(), files: catalogFiles() });
    await runLocal(["up", "--port"], {
      out,
      env: baseEnv({ TENKACLOUD_LOCAL_PORT: "6789" }),
      fs,
      spawnDetached: vi.fn(() => 1),
    });
    const state = JSON.parse(files.get(STATE_PATH) ?? "");
    expect(state.port).toBe(6789);
  });

  it("should ignore an invalid --port value (uses env/default)", async () => {
    // `--port abc` → Number("abc") is NaN → not integer → falls through.
    const { fs, files } = makeFs({ dirs: catalogDirs(), files: catalogFiles() });
    await runLocal(["up", "--port", "not-a-number"], {
      out,
      env: baseEnv({ TENKACLOUD_LOCAL_PORT: "" }),
      fs,
      spawnDetached: vi.fn(() => 1),
    });
    const state = JSON.parse(files.get(STATE_PATH) ?? "");
    expect(state.port).toBe(3199);
  });

  it("should skip --port and its value when finding the first positional", async () => {
    // firstPositional must skip "--port" + "4000" and pick "c1".
    const { fs, files } = makeFs({ dirs: catalogDirs(), files: catalogFiles() });
    const code = await runLocal(["up", "--port", "4000", "c1"], {
      out,
      env: baseEnv(),
      fs,
      spawnDetached: vi.fn(() => 1),
    });
    expect(code).toBe(0);
    const state = JSON.parse(files.get(STATE_PATH) ?? "");
    expect(state.problemId).toBe("c1");
    expect(state.port).toBe(4000);
  });

  it("should skip an unrecognized --flag when finding the first positional", async () => {
    // firstPositional must skip "--quiet" (a -- prefixed non-port flag) and
    // pick the real positional "c1".
    const { fs, files } = makeFs({ dirs: catalogDirs(), files: catalogFiles() });
    const code = await runLocal(["up", "--quiet", "c1"], {
      out,
      env: baseEnv(),
      fs,
      spawnDetached: vi.fn(() => 1),
    });
    expect(code).toBe(0);
    const state = JSON.parse(files.get(STATE_PATH) ?? "");
    expect(state.problemId).toBe("c1");
  });

  it("should treat corrupt state.json as no state (readState catch branch)", async () => {
    // existsSync true but JSON.parse throws → readState returns undefined → down
    // reports nothing to stop.
    const { fs } = makeFs({ files: { [STATE_PATH]: "{ not json" } });
    const code = await runLocal(["down"], {
      out,
      env: baseEnv(),
      fs,
      spawnDetached: vi.fn(),
      kill: vi.fn(),
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("nothing to stop");
  });
});

// ---------------------------------------------------------------------------
// Default-dependency fallbacks (omitted-arm coverage)
// ---------------------------------------------------------------------------

describe("runLocal default-dependency fallbacks", () => {
  it("should fall back to console.log when out is omitted (resolveCtx out default)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { fs } = makeFs();
    try {
      // no `out`, no subcommand → prints USAGE via the default console.log.
      const code = await runLocal([], { env: baseEnv(), fs, spawnDetached: vi.fn() });
      expect(code).toBe(0);
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(String(logSpy.mock.calls[0]?.[0])).toContain("tenkacloud local");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("should fall back to process.env when env is omitted (resolveCtx env default)", async () => {
    // Drive resolveCtx's `deps.env ?? process.env` default by omitting env and
    // pointing process.env at our deterministic dirs. Restore afterwards.
    const saved = {
      dir: process.env.TENKACLOUD_LOCAL_DIR,
      problems: process.env.TENKACLOUD_PROBLEMS_DIR,
      runtime: process.env.TENKACLOUD_PORTAL_RUNTIME_CONFIG,
      bin: process.env.TENKACLOUD_CLI_BIN,
    };
    process.env.TENKACLOUD_LOCAL_DIR = LOCAL_DIR;
    process.env.TENKACLOUD_PROBLEMS_DIR = PROBLEMS_DIR;
    process.env.TENKACLOUD_PORTAL_RUNTIME_CONFIG = RUNTIME_CONFIG;
    process.env.TENKACLOUD_CLI_BIN = "/work/bin/tenkacloud.ts";
    const { fs, files } = makeFs({ dirs: catalogDirs(), files: catalogFiles() });
    try {
      const code = await runLocal(["up"], { out, fs, spawnDetached: vi.fn(() => 1) });
      expect(code).toBe(0);
      expect(files.has(STATE_PATH)).toBe(true);
    } finally {
      for (const [k, v] of [
        ["TENKACLOUD_LOCAL_DIR", saved.dir],
        ["TENKACLOUD_PROBLEMS_DIR", saved.problems],
        ["TENKACLOUD_PORTAL_RUNTIME_CONFIG", saved.runtime],
        ["TENKACLOUD_CLI_BIN", saved.bin],
      ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("should use default data/problems/runtime paths when env vars are unset", async () => {
    // Drives the right-hand sides of the `?? join(...)` defaults in resolveCtx.
    // An empty env means no problems dir resolves on disk → empty catalog → up
    // returns 1 without spawning, so no real fs/process is touched.
    const { fs } = makeFs();
    const spawnDetached = vi.fn(() => 1);
    const code = await runLocal(["up"], { out, env: {}, fs, spawnDetached });
    expect(code).toBe(1);
    expect(spawnDetached).not.toHaveBeenCalled();
    // The default problemsDir contains the cwd-relative "problems" segment.
    expect(lines.join("\n")).toContain("/problems (set TENKACLOUD_PROBLEMS_DIR)");
  });

  it("should fall back to the real fetch for status when fetchImpl is omitted", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));
    const { fs } = makeFs({ files: { [STATE_PATH]: stateJson({}) } });
    try {
      const code = await runLocal(["status"], { out, env: baseEnv(), fs, spawnDetached: vi.fn() });
      expect(code).toBe(0);
      expect(fetchSpy).toHaveBeenCalledWith("http://127.0.0.1:3199/healthz");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("should fall back to the real fetch for evaluate when fetchImpl is omitted", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ kind: "ok", totalScore: 5 }), { status: 200 }),
      );
    const { fs } = makeFs({ files: { [STATE_PATH]: stateJson({}) } });
    try {
      const code = await runLocal(["evaluate", "c1", "TC{x}"], {
        out,
        env: baseEnv(),
        fs,
        spawnDetached: vi.fn(),
      });
      expect(code).toBe(0);
      expect(fetchSpy).toHaveBeenCalledWith(
        "http://127.0.0.1:3199/portal/me/submit-flag",
        expect.objectContaining({ method: "POST" }),
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("should fall back to process.kill for down when kill is omitted", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true as never);
    const { fs, rmCalls } = makeFs({ files: { [STATE_PATH]: stateJson({ pid: 314 }) } });
    try {
      const code = await runLocal(["down"], { out, env: baseEnv(), fs, spawnDetached: vi.fn() });
      expect(code).toBe(0);
      expect(killSpy).toHaveBeenCalledWith(314);
      expect(rmCalls).toContain(STATE_PATH);
    } finally {
      killSpy.mockRestore();
    }
  });

  it("should fall back to the never-resolving block when block is omitted", async () => {
    // serve's `await (deps.block ?? (() => new Promise(() => {})))()` default arm
    // never resolves in production (the worker stays resident). We exercise that
    // arm by NOT awaiting runLocal: once startApi resolves, control reaches the
    // default block factory (covering the branch + both inline arrows) and then
    // suspends forever. We assert it got that far, then stop watching — the
    // pending promise is intentionally abandoned. A fake startApi means no real
    // server or process is left behind.
    const { fs } = makeFs({ dirs: catalogDirs(), files: catalogFiles() });
    let closed = false;
    const startApi = vi.fn(async () => ({
      port: 3199,
      state: {} as never,
      close: async () => {
        closed = true;
      },
    }));
    // Deliberately omit `block`.
    void runLocal(["serve"], {
      out,
      env: baseEnv(),
      fs,
      spawnDetached: vi.fn(),
      startApi: startApi as never,
    });
    // Let the microtasks run: startApi resolves, the listen line prints, and the
    // default block factory is invoked (then hangs).
    await new Promise((r) => setTimeout(r, 10));
    expect(startApi).toHaveBeenCalledTimes(1);
    expect(lines.join("\n")).toContain("Local Participant API listening on http://127.0.0.1:3199");
    // handle.close is never reached because the default block never resolves.
    expect(closed).toBe(false);
  });

  it("should fall back to startLocalApi for serve when startApi is omitted", async () => {
    // Omit startApi → serve uses the real startLocalApi (binds port 0 = OS
    // assigned, loopback only). Provide `block` so we don't hang; the handle is
    // closed before the test ends.
    const { fs } = makeFs({ dirs: catalogDirs(), files: catalogFiles() });
    const code = await runLocal(["serve", "--port", "0"], {
      out,
      env: baseEnv(),
      fs,
      spawnDetached: vi.fn(),
      block: vi.fn(async () => {}),
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toMatch(
      /Local Participant API listening on http:\/\/127\.0\.0\.1:\d+/,
    );
  });
});
