import { spawn } from "node:child_process";
import { accessSync, closeSync, constants, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { SimulatorSettings } from "./simulator-hosting";

interface ManagedSimulatorOptions {
  readonly binary: string;
  readonly dataDirectory: string;
  readonly signal?: AbortSignal;
  readonly startupTimeoutMs?: number;
}

interface SimulatorExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

const startupFailure =
  "Managed Simulator could not start. Check the installed native Simulator executable, and the private host data directory. No existing Simulator was reused; subprocess output is withheld to protect credentials.";

function checkStateParents(directory: string): void {
  const parent = dirname(directory);
  if (parent !== directory) checkStateParents(parent);
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0))
      throw new Error(
        "Managed Simulator data path must contain safe directories without symlinks.",
      );
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

function privateDirectory(directory: string): void {
  checkStateParents(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    throw new Error(
      "Managed Simulator requires an owner-only simulator data directory, without symlinks. Check its ownership and permissions; retained state and tokens were not changed.",
    );
  for (const name of ["practice.db", "simulator-token"]) {
    const path = join(directory, name);
    try {
      const file = lstatSync(path);
      if (
        !file.isFile() ||
        file.nlink !== 1 ||
        file.uid !== process.getuid?.() ||
        (file.mode & 0o077) !== 0
      )
        throw new Error(
          "Managed Simulator state and token must be private, owned regular files without links. Retained files were not changed.",
        );
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  createPrivateDatabase(directory);
}

function createPrivateDatabase(directory: string): void {
  // SQLite inherits an existing file's mode. Create only a new empty database,
  // without changing the process-wide umask or overwriting any retained state.
  try {
    closeSync(openSync(join(directory, "practice.db"), "wx", 0o600));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
}

function launchCommand(binary: string): string {
  if (process.platform === "win32")
    throw new Error(
      "Managed native Simulator requires a POSIX host. Use an explicitly configured external Simulator on this platform.",
    );
  const command = resolve(binary);
  try {
    accessSync(command, constants.X_OK);
  } catch {
    throw new Error(
      "Managed Simulator executable is missing or not executable. Check the installed Simulator or --simulator-binary.",
    );
  }
  return command;
}

/** Own only this child process group; never attach to or stop an existing listener. */
export async function startManagedSimulator(options: ManagedSimulatorOptions): Promise<{
  settings: SimulatorSettings & { readonly tokenFile: string };
  stop(): Promise<void>;
  exited: Promise<SimulatorExit>;
}> {
  if (options.signal?.aborted) throw new Error("Managed Simulator startup was cancelled.");
  const launch = launchCommand(options.binary);
  const directory = resolve(options.dataDirectory, "simulator");
  try {
    privateDirectory(directory);
  } catch (error) {
    // Never reflect OS errors: filenames and diagnostics can contain private data.
    if (error instanceof Error && error.message.startsWith("Managed Simulator")) throw error;
    throw new Error(
      "Cannot prepare the private managed Simulator data directory. Check host data directory ownership and permissions.",
    );
  }
  const state = join(directory, "practice.db");
  const tokenFile = join(directory, "simulator-token");
  const child = spawn(
    launch,
    ["--listen=127.0.0.1:0", `--state=${state}`, `--token-file=${tokenFile}`],
    {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        ...process.env,
        CI: "1",
        START_LISTEN: "127.0.0.1:0",
        START_STATE: state,
        START_TOKEN_FILE: tokenFile,
      },
    },
  );
  let resolveExit!: (value: SimulatorExit) => void;
  const exited = new Promise<SimulatorExit>((resolve) => {
    resolveExit = resolve;
  });
  let rejectReady!: (error: Error) => void;
  let resolveReady!: (endpoint: string) => void;
  const ready = new Promise<string>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  child.once("exit", (code, signal) => {
    resolveExit({ code, signal });
    rejectReady(new Error(startupFailure));
  });
  child.once("error", () => {
    resolveExit({ code: null, signal: null });
    rejectReady(new Error(startupFailure));
  });
  const groupExists = () => {
    if (!child.pid) return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const signalGroup = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      /* Already exited. */
    }
  };
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      options.signal?.removeEventListener("abort", abort);
      signalGroup("SIGTERM");
      for (let i = 0; i < 20 && groupExists(); i++)
        await new Promise((resolve) => setTimeout(resolve, 25));
      if (groupExists()) signalGroup("SIGKILL");
      // Descendants can retain stdout even after the direct child exits.
      child.stdout.destroy();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 500))]);
    })();
    return stopping;
  };
  const abort = () => {
    rejectReady(new Error("Managed Simulator startup was cancelled."));
    void stop();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  child.stdout.on("data", readinessReader(resolveReady));
  child.stdout.on("error", () => rejectReady(new Error(startupFailure)));
  const timer = setTimeout(
    () =>
      rejectReady(
        new Error(
          "Managed Simulator startup timed out. Check the native Simulator executable and local resources, then retry. The owned child is stopped; retained state and token remain.",
        ),
      ),
    options.startupTimeoutMs ?? 120_000,
  );
  try {
    const endpoint = await ready;
    if (options.signal?.aborted) throw new Error("Managed Simulator startup was cancelled.");
    return {
      settings: { endpoint, tokenFile, region: "ap-northeast-1", bootstrap: true },
      stop,
      exited,
    };
  } catch (error) {
    await stop();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Bound line buffering and accept only exact numeric-loopback readiness. */
function readinessReader(ready: (endpoint: string) => void): (chunk: Buffer) => void {
  let line = "";
  let discard = false;
  const acceptByte = (byte: number) => {
    if (byte !== 10) {
      if (discard) return;
      line += String.fromCharCode(byte);
      if (line.length > 128) {
        line = "";
        discard = true;
      }
      return;
    }
    const endpoint = readinessEndpoint(line);
    if (endpoint) ready(endpoint);
    line = "";
    discard = false;
  };
  return (chunk) => {
    for (const byte of chunk) acceptByte(byte);
  };
}

function readinessEndpoint(line: string): string | undefined {
  const match = /^AWS simulation endpoint http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\r?$/u.exec(line);
  return match && Number(match[1]) <= 65535 ? `http://127.0.0.1:${match[1]}` : undefined;
}
