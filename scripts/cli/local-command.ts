import { existsSync } from "node:fs";
import { join } from "node:path";
import { runLocalPlayCommand } from "../tenkacloud-local";
import type { ProcessRunner } from "./process";

export interface LocalCommandDeps {
  readonly repoRoot: string;
  readonly processRunner: ProcessRunner;
  readonly runLocal: (args: readonly string[]) => Promise<void>;
  readonly fileExists: (path: string) => boolean;
  readonly log: (message: string) => void;
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
  };
}
