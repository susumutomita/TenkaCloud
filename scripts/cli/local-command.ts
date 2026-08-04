import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { runLocalPlayCommand } from "../tenkacloud-local";
import type { ProcessRunner } from "./process";

/**
 * [#2872] The participant portal's dev-server port. Hard-coded rather than derived because
 * `local-play/cors.ts` (LOCAL_PORTAL_ORIGINS) and `local-play/codespaces-links.ts` pin the
 * same number; making it configurable means moving all three together.
 */
export const PORTAL_PORT = 5175;

export interface LocalCommandDeps {
  readonly repoRoot: string;
  readonly processRunner: ProcessRunner;
  readonly runLocal: (args: readonly string[]) => Promise<void>;
  readonly fileExists: (path: string) => boolean;
  readonly log: (message: string) => void;
  /** [#2872] False when the portal port is already taken. Injected so tests need no socket. */
  readonly isPortFree: (port: number) => Promise<boolean>;
}

/**
 * [#2872] Bind-and-release probe on the loopback address the portal will use.
 *
 * A dev server from a previous session keeps the port — including one whose git worktree has
 * since been deleted, which is how this was found. Without the probe that collision surfaces
 * only after `local up` has started the API and written its ownership state, leaving the API
 * running behind a command that reported failure.
 */
export async function isPortFree(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

export interface ParsedLocalCommand {
  readonly command?: string;
  readonly argument?: string;
  readonly database: "sqlite" | "turso";
  readonly problem?: string;
  readonly apiPort?: string;
}

interface LocalCommandAccumulator {
  database: ParsedLocalCommand["database"];
  problem?: string;
  apiPort?: string;
  readonly positionals: string[];
}

function optionValue(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

export function parseLocalCommand(args: readonly string[]): ParsedLocalCommand {
  const parsed: LocalCommandAccumulator = { database: "sqlite", positionals: [] };
  for (let index = 0; index < args.length; index += 1) {
    // `consumeLocalArgument` returns the index of the last argv entry it consumed, which is
    // one further along for `--option value` pairs than for bare flags. Advancing the counter
    // from its return value is the point of the call, not an accident.
    // eslint-disable-next-line sonarjs/updated-loop-counter -- variable-width argv consumption
    index = consumeLocalArgument(args, index, parsed);
  }
  return {
    command: parsed.positionals[0],
    argument: parsed.positionals[1],
    database: parsed.database,
    problem: parsed.problem,
    apiPort: parsed.apiPort,
  };
}

function consumeLocalArgument(
  args: readonly string[],
  index: number,
  parsed: LocalCommandAccumulator,
): number {
  const arg = args[index];
  if (!arg) return index;
  if (arg === "--database") {
    const value = optionValue(args, index, arg);
    if (value !== "sqlite" && value !== "turso") {
      throw new Error("--database must be sqlite or turso");
    }
    parsed.database = value;
    return index + 1;
  }
  if (arg === "--problem") {
    parsed.problem = optionValue(args, index, arg);
    return index + 1;
  }
  if (arg === "--api-port") {
    parsed.apiPort = optionValue(args, index, arg);
    if (!/^\d+$/.test(parsed.apiPort)) throw new Error("--api-port must be a port number");
    return index + 1;
  }
  if (arg.startsWith("--")) throw new Error(`Unknown local option: ${arg}`);
  parsed.positionals.push(arg);
  return index;
}

async function withLocalEnvironment<T>(
  parsed: ParsedLocalCommand,
  action: () => Promise<T>,
): Promise<T> {
  const prior = {
    database: process.env.TENKACLOUD_LOCAL_DATABASE,
    problem: process.env.PROBLEM,
    apiPort: process.env.LOCAL_API_PORT,
  };
  process.env.TENKACLOUD_LOCAL_DATABASE = parsed.database;
  if (parsed.problem !== undefined) process.env.PROBLEM = parsed.problem;
  if (parsed.apiPort !== undefined) process.env.LOCAL_API_PORT = parsed.apiPort;
  try {
    return await action();
  } finally {
    if (prior.database === undefined) delete process.env.TENKACLOUD_LOCAL_DATABASE;
    else process.env.TENKACLOUD_LOCAL_DATABASE = prior.database;
    if (prior.problem === undefined) delete process.env.PROBLEM;
    else process.env.PROBLEM = prior.problem;
    if (prior.apiPort === undefined) delete process.env.LOCAL_API_PORT;
    else process.env.LOCAL_API_PORT = prior.apiPort;
  }
}

async function ensurePortalDependencies(deps: LocalCommandDeps): Promise<void> {
  const rootVite = join(deps.repoRoot, "node_modules", ".bin", "vite");
  const portalVite = join(
    deps.repoRoot,
    "apps",
    "participant-portal",
    "node_modules",
    ".bin",
    "vite",
  );
  if (deps.fileExists(rootVite) || deps.fileExists(portalVite)) return;
  deps.log("Dependencies are missing — installing them without lifecycle scripts.");
  const result = deps.processRunner.run("bun", ["install", "--ignore-scripts"], {
    cwd: deps.repoRoot,
    inherit: true,
  });
  if (result.status !== 0) throw new Error("bun install failed");
}

export async function runLocalCommand(
  args: readonly string[],
  deps: LocalCommandDeps,
): Promise<number> {
  const parsed = parseLocalCommand(args);
  const command = parsed.command;
  if (command && command !== "portal") {
    await withLocalEnvironment(parsed, () =>
      deps.runLocal([command, parsed.argument ?? parsed.problem ?? ""].filter(Boolean)),
    );
    return 0;
  }

  await ensurePortalDependencies(deps);
  if (command === "portal") await deps.runLocal(["status"]);
  let running = true;
  if (command !== "portal") {
    try {
      await deps.runLocal(["status"]);
    } catch {
      running = false;
    }
  }
  // [#2872] Check the portal port BEFORE `up`. `up` starts the API and records ownership in
  // state.json; discovering the collision afterwards left the API running behind a command
  // that exited non-zero, and the next `make local` then refused with "already running".
  if (!(await deps.isPortFree(PORTAL_PORT))) {
    deps.log(
      `Participant Portal port ${PORTAL_PORT} is already in use, so the portal cannot start.\n` +
        `Find the listener with:  lsof -nP -iTCP:${PORTAL_PORT} -sTCP:LISTEN\n` +
        "A dev server from an earlier session keeps the port even if its checkout is gone.",
    );
    return 1;
  }
  if (!running) {
    deps.log(
      parsed.problem
        ? `Starting local play and pre-starting ${parsed.problem}.`
        : "Starting local play. Problems start on demand from the browser portal.",
    );
    await withLocalEnvironment(parsed, () => deps.runLocal(["up", parsed.problem ?? ""]));
  }
  const result = deps.processRunner.run("bun", ["run", "dev", "--host", "127.0.0.1"], {
    cwd: join(deps.repoRoot, "apps", "participant-portal"),
    env: process.env,
    inherit: true,
  });
  // [#2872] The port was free a moment ago, so a failure here is something else (a crashed
  // vite, a lost dependency). Either way `make local` promised "API and portal"; leaving a
  // half-session behind is what made the next run report "already running". Only tear down a
  // session this invocation started — `local portal` attaches to someone else's API.
  if (result.status !== 0 && !running && command !== "portal") {
    deps.log("Participant Portal failed to start; stopping the local API it was started with.");
    await deps.runLocal(["down"]);
  }
  return result.status;
}

export function defaultLocalCommandDeps(
  repoRoot: string,
  processRunner: ProcessRunner,
): LocalCommandDeps {
  return {
    repoRoot,
    processRunner,
    runLocal: runLocalPlayCommand,
    fileExists: existsSync,
    log: console.log,
    isPortFree,
  };
}
