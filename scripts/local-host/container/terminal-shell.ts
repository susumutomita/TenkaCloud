import { execFile, spawn } from "node:child_process";
import { dirname } from "node:path";
import { z } from "zod";
import { type ComposeCli, composeInterpolationEnv, resolveComposeCli } from "./compose-cli";
import type { LocalComposeUnit } from "./container-runner";
import { spawnTerminalPty, terminalPtyAvailable } from "./terminal-pty";
import { TERMINAL_CLEANUP, TERMINAL_WRAPPER, terminalSession } from "./terminal-session";

export interface TerminalHandlers {
  readonly onData: (chunk: string) => void;
  readonly onExit: (code: number | null) => void;
}
export interface TerminalProcess {
  readonly write: (data: string) => void;
  readonly kill: () => void;
  readonly closed?: Promise<void>;
  readonly resize?: (cols: number, rows: number) => void;
}

interface TerminalShellDeps {
  readonly pty?: boolean;
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

async function commandText(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
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
}

async function inspect(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<unknown> {
  const text = await commandText(command, args, env);
  if (!text.trim()) return [];
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
  }
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

async function resolveTerminalContainer(
  unit: LocalComposeUnit,
  service: string,
  cli: ComposeCli,
  base: readonly string[],
  env: NodeJS.ProcessEnv,
  deps: TerminalShellDeps,
): Promise<string> {
  const query = deps.inspect ?? inspect;
  const rawContainers = await query(
    cli.command,
    [...base, "ps", "--format", "json", "--no-trunc", service],
    env,
  );
  const containers = z
    .array(
      z.object({
        ID: z.string().regex(/^[a-f0-9]{64}$/u),
        Project: z.literal(unit.composeProjectName),
        Service: z.literal(service),
        State: z.literal("running"),
      }),
    )
    .length(1)
    .parse(Array.isArray(rawContainers) ? rawContainers : [rawContainers]);
  const container = containers[0];
  if (!container) throw new Error("Terminal container is missing.");
  const id = container.ID;
  const details = z
    .array(
      z.object({
        Id: z.literal(id),
        State: z.object({ Running: z.literal(true) }),
        Config: z.object({ Labels: z.record(z.string(), z.string()) }),
      }),
    )
    .length(1)
    .parse(await query("docker", ["inspect", id], env));
  const detail = details[0];
  if (!detail) throw new Error("Terminal container is missing.");
  const labels = detail.Config.Labels;
  if (
    labels["com.docker.compose.project"] !== unit.composeProjectName ||
    labels["com.docker.compose.service"] !== service ||
    !labels["com.docker.compose.project.config_files"]?.split(",").includes(unit.composePath) ||
    (unit.isolationVersion === 1 &&
      labels["tenkacloud.isolation.generation"] !== unit.isolationGeneration)
  )
    throw new Error("Terminal container ownership changed.");
  return id;
}

export async function cleanupTerminal(
  id: string,
  pid: string,
  starttime: string,
  env: NodeJS.ProcessEnv,
  run = commandText,
  query = inspect,
): Promise<void> {
  try {
    await run(
      "docker",
      ["exec", id, "/bin/sh", "-c", TERMINAL_CLEANUP, "terminal-cleanup", pid, starttime],
      env,
    );
  } catch {
    // A stopped/deleted pinned container cannot retain this exec. Daemon errors stay closed.
    const raw = await query(
      "docker",
      ["container", "ls", "--all", "--no-trunc", "--format", "{{json .}}"],
      env,
    );
    const existing = z
      .array(z.object({ ID: z.string().regex(/^[a-f0-9]{64}$/u), State: z.string() }))
      .parse(Array.isArray(raw) ? raw : [raw]);
    if (
      existing.some(
        (container) =>
          container.ID === id && container.State !== "exited" && container.State !== "dead",
      )
    )
      throw new Error("Terminal cleanup unconfirmed; admission retained.");
  }
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
  if (unit.isolationVersion === 1) {
    env.DOCKER_HOST = "unix:///var/run/docker.sock";
    env.DOCKER_CONTEXT = "";
  }
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
  assertCurrent();
  if (deps.pty ?? terminalPtyAvailable()) {
    const id = await resolveTerminalContainer(unit, service, cli, base, env, deps);
    assertCurrent();
    return terminalSession(
      (events) =>
        (deps.spawn ?? spawnTerminalPty)(
          "docker",
          [
            "exec",
            "--interactive",
            "--tty",
            "--detach-keys=ctrl-@",
            "-e",
            "TERM=xterm-256color",
            id,
            "/bin/sh",
            "-c",
            TERMINAL_WRAPPER,
          ],
          env,
          events,
        ),
      (pid, starttime) => cleanupTerminal(id, pid, starttime, env),
      handlers,
      assertCurrent,
    );
  }
  // Config inspection is asynchronous. Revocation or replacement during it must prevent exec.
  assertCurrent();
  return (deps.spawn ?? spawnShell)(
    cli.command,
    [...base, "exec", "-T", service, "/bin/sh"],
    env,
    handlers,
  );
}
