import { execFile, spawn } from "node:child_process";
import { dirname } from "node:path";
import { z } from "zod";
import { type ComposeCli, composeInterpolationEnv, resolveComposeCli } from "./compose-cli";
import type { LocalComposeUnit } from "./container-runner";

export interface TerminalHandlers {
  readonly onData: (chunk: string) => void;
  readonly onExit: (code: number | null) => void;
}
export interface TerminalProcess {
  readonly write: (data: string) => void;
  readonly kill: () => void;
}

interface TerminalShellDeps {
  readonly cli?: ComposeCli;
  readonly inspect?: (
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ) => Promise<unknown>;
  readonly spawn?: (
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
    handlers: TerminalHandlers,
  ) => TerminalProcess;
}

function interpolationEnvironment(unit: LocalComposeUnit): NodeJS.ProcessEnv {
  const inherited = composeInterpolationEnv(unit.secretEnv);
  const allowed = [
    "PATH",
    "HOME",
    "USER",
    "TMPDIR",
    "XDG_RUNTIME_DIR",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
    "DOCKER_CERT_PATH",
    "DOCKER_TLS_VERIFY",
    ...unit.secretEnv,
  ];
  return Object.fromEntries(
    allowed.filter((name) => inherited[name] !== undefined).map((name) => [name, inherited[name]]),
  );
}

async function inspect(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<unknown> {
  const text = await new Promise<string>((resolve, reject) => {
    execFile(
      command,
      [...args],
      { env, timeout: 5000, maxBuffer: 1024 * 1024, encoding: "utf8" },
      (error, stdout) => {
        if (error) reject(new Error("Unable to verify the terminal's Compose configuration."));
        else resolve(stdout);
      },
    );
  });
  return JSON.parse(text) as unknown;
}

function spawnShell(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  handlers: TerminalHandlers,
): TerminalProcess {
  const child = spawn(command, [...args], { env, stdio: ["pipe", "pipe", "pipe"] });
  let ended = false;
  const finish = (code: number | null) => {
    if (ended) return;
    ended = true;
    handlers.onExit(code);
  };
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    if (!ended) handlers.onData(chunk);
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    if (!ended) handlers.onData(chunk);
  });
  child.once("error", () => finish(null));
  child.stdin.once("error", () => finish(null));
  child.once("close", finish);
  return {
    write: (data) => {
      if (ended) return;
      if (child.stdin.writableLength + Buffer.byteLength(data) > 1024 * 1024) {
        child.kill("SIGKILL");
        finish(null);
        return;
      }
      child.stdin.write(data);
    },
    kill: () => {
      if (!ended) {
        child.stdin.destroy();
        child.kill("SIGKILL");
        finish(null);
      }
    },
  };
}

/** Only an owned Compose unit and its metadata-declared participant stage may receive a shell. */
export async function spawnDeclaredTerminal(
  unit: LocalComposeUnit,
  service: string,
  handlers: TerminalHandlers,
  assertCurrent: () => void,
  deps: TerminalShellDeps = {},
): Promise<TerminalProcess> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(service))
    throw new Error("Invalid declared terminal service.");
  assertCurrent();
  const cli = deps.cli ?? resolveComposeCli();
  const base = [
    ...cli.prefix,
    "-f",
    unit.composePath,
    "-p",
    unit.composeProjectName,
    "--project-directory",
    unit.projectDirectory ?? dirname(unit.composePath),
  ];
  const env = interpolationEnvironment(unit);
  const raw = await (deps.inspect ?? inspect)(
    cli.command,
    [...base, "config", "--format", "json"],
    env,
  );
  const config = z.object({ services: z.record(z.string(), z.unknown()) }).parse(raw);
  const selected = z
    .object({ build: z.object({ target: z.literal("participant") }) })
    .safeParse(config.services[service]);
  if (!selected.success)
    throw new Error("The declared terminal service must build the participant target.");
  // Config inspection is asynchronous. Revocation or replacement during it must prevent exec.
  assertCurrent();
  return (deps.spawn ?? spawnShell)(
    cli.command,
    [...base, "exec", "-T", service, "/bin/sh"],
    env,
    handlers,
  );
}
