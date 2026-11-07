import { spawn } from "node:child_process";

/** Only controlled, non-secret fixture diagnostics may cross the CLI boundary. */
export class SimulatorFixtureError extends Error {}

const interruptCleanups = new Set<() => Promise<void>>();
let interrupted = false;
const interruptedOperation = new Promise<never>(() => {
  // Once interrupted, only the signal handler may finish the CLI, after owned cleanup settles.
});

function interruptFixture(signal: "SIGINT" | "SIGTERM"): void {
  if (interrupted) return;
  interrupted = true;
  const exitCode = signal === "SIGINT" ? 130 : 143;
  const cleanup = Promise.allSettled(
    [...interruptCleanups].map((stop) => Promise.resolve().then(stop)),
  );
  void withinFixtureDeadline(cleanup, 15_000, "Interrupted fixture cleanup timed out.")
    .catch(() => {
      // Signal exits deliberately expose no errors, private paths, process output or credentials.
    })
    .finally(() => process.exit(exitCode));
}

const onInterrupt = () => interruptFixture("SIGINT");
const onTerminate = () => interruptFixture("SIGTERM");

/** Register before asynchronous setup, including version checks and partially started children. */
export function registerFixtureInterruptCleanup(stop: () => Promise<void>): () => void {
  if (interrupted) throw new SimulatorFixtureError("The simulator fixture is being interrupted.");
  if (interruptCleanups.size === 0) {
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
  }
  interruptCleanups.add(stop);
  return () => {
    interruptCleanups.delete(stop);
    if (interruptCleanups.size === 0 && !interrupted) {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
    }
  };
}

/** Keep the CLI result pending during signal cleanup instead of printing a premature result. */
export async function waitForFixtureOperation<T>(operation: Promise<T>): Promise<T> {
  try {
    const result = await operation;
    if (interrupted) return interruptedOperation;
    return result;
  } catch (error) {
    if (interrupted) return interruptedOperation;
    throw error;
  }
}

export interface FixtureProcess {
  readonly exited: Promise<number | null>;
  readonly hasExited: () => boolean;
  readonly output: () => string;
  readonly outputLimitExceeded: () => boolean;
  stop(): Promise<void>;
}

export async function withinFixtureDeadline<T>(
  operation: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new SimulatorFixtureError(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A separate POSIX process group also owns make's shell and Bun descendants. */
export function spawnFixtureProcess(
  command: readonly [string, ...string[]],
  options: {
    cwd: string;
    environment: NodeJS.ProcessEnv;
    captureVersion?: boolean;
    captureStdout?: boolean;
    input?: string;
  },
): FixtureProcess {
  if (interrupted) throw new SimulatorFixtureError("The simulator fixture is being interrupted.");
  if (process.platform === "win32")
    throw new SimulatorFixtureError("The simulator acceptance fixture requires a POSIX host.");
  const child = spawn(command[0], command.slice(1), {
    cwd: options.cwd,
    env: options.environment,
    detached: true,
    stdio: [
      options.input === undefined ? "ignore" : "pipe",
      options.captureVersion || options.captureStdout ? "pipe" : "ignore",
      options.captureVersion ? "pipe" : "ignore",
    ],
  });
  let ended = false;
  let output = "";
  let outputLimitExceeded = false;
  let capturedBytes = 0;
  const outputLimit = options.captureVersion ? 4096 : 64 * 1024;
  // Only requested version/CLI stdout, never host/simulator logs. Always drain but bound storage.
  const capture = (chunk: Buffer) => {
    const remaining = Math.max(0, outputLimit - capturedBytes);
    output += chunk.subarray(0, remaining).toString("utf8");
    capturedBytes += chunk.length;
    outputLimitExceeded ||= capturedBytes > outputLimit;
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  child.stdin?.on("error", () => {
    // EPIPE is reflected by the child's exit, never an uncaught error or credential dump.
  });
  child.stdin?.end(options.input);
  const exited = new Promise<number | null>((resolve) => {
    child.once("error", () => {
      ended = true;
      resolve(null);
    });
    child.once("close", (code) => {
      ended = true;
      resolve(code);
    });
  });
  const signalGroup = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
        throw new SimulatorFixtureError("Could not stop the fixture process group.");
    }
  };
  let stopping: Promise<void> | undefined;
  return {
    exited,
    hasExited: () => ended,
    output: () => output,
    outputLimitExceeded: () => outputLimitExceeded,
    stop() {
      stopping ??= (async () => {
        signalGroup("SIGTERM");
        try {
          await withinFixtureDeadline(exited, 2000, "Fixture process shutdown timed out.");
        } catch {
          // Escalate a bounded graceful shutdown, then await the actual child exit below.
        } finally {
          // A shell may exit before its children; terminate the entire owned group too.
          signalGroup("SIGKILL");
        }
        await withinFixtureDeadline(exited, 2000, "Fixture process did not exit after shutdown.");
      })();
      return stopping;
    },
  };
}

/** The participant's copied shell setup stays on stdin; stderr and credentials are never returned. */
export async function fixtureShellOutput(
  script: string,
  options: { cwd: string; environment: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<{ exitCode: number; stdout: string }> {
  const timeout = options.timeoutMs ?? 15_000;
  if (
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > 15_000 ||
    Buffer.byteLength(script) > 1024 * 1024
  )
    throw new SimulatorFixtureError("Invalid fixture shell request limits.");
  const shell = Bun.which("bash", { PATH: "/usr/bin:/bin" });
  if (!shell) throw new SimulatorFixtureError("Install bash before simulator acceptance.");
  let child: FixtureProcess | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () => (stopping ??= child?.stop() ?? Promise.resolve());
  const unregister = registerFixtureInterruptCleanup(stop);
  try {
    child = spawnFixtureProcess([shell], {
      cwd: options.cwd,
      environment: options.environment,
      input: script,
      captureStdout: true,
    });
    const exitCode = await waitForFixtureOperation(
      withinFixtureDeadline(child.exited, timeout, "Fixture CLI command timed out."),
    );
    if (exitCode === null)
      throw new SimulatorFixtureError("Fixture CLI command did not exit normally.");
    if (child.outputLimitExceeded())
      throw new SimulatorFixtureError("Fixture CLI output limit exceeded.");
    return { exitCode, stdout: child.output() };
  } finally {
    try {
      await stop();
    } finally {
      unregister();
    }
  }
}

export async function fixtureCommandOutput(
  command: readonly [string, ...string[]],
  options: {
    cwd: string;
    environment: NodeJS.ProcessEnv;
    onSpawn?: (child: FixtureProcess) => void;
  },
): Promise<string> {
  const child = spawnFixtureProcess(command, { ...options, captureVersion: true });
  try {
    options.onSpawn?.(child);
    const code = await waitForFixtureOperation(
      withinFixtureDeadline(child.exited, 5000, "Tool version check timed out."),
    );
    if (code !== 0 || child.outputLimitExceeded())
      throw new SimulatorFixtureError("Tool version check failed.");
    return child.output().trim();
  } finally {
    await child.stop();
  }
}

/** Retries only local readiness probes; requests themselves must have finite deadlines. */
export async function waitForFixtureReady(
  child: FixtureProcess,
  probe: () => Promise<boolean>,
  milliseconds: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (interrupted) return interruptedOperation;
    if (child.hasExited()) throw new SimulatorFixtureError(`${label} exited before readiness.`);
    try {
      if (await probe()) return;
    } catch {
      // Connection refusal and an incomplete token/session file are expected during startup.
    }
    await Bun.sleep(50);
  }
  throw new SimulatorFixtureError(`${label} readiness timed out.`);
}
