import { closeSync } from "node:fs";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";

/**
 * Bun 1.3.11's node:child_process adapter gives extra pipes two fd owners: the
 * Node socket and the native subprocess. After the socket closes, later GC can
 * close an unrelated file that reused its fd. Bun.file borrows fd 3 without
 * introducing a second socket owner. Since Bun 1.4, reading child.stdio on
 * POSIX transfers extra pipe ownership to the caller, so release it explicitly
 * after its reader settles. Older Bun versions retain native ownership.
 */
export function spawnPrivateKeyProcess(
  command: readonly string[],
  options: {
    readonly cwd: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly stdin?: "pipe";
  },
) {
  const child = Bun.spawn([...command], {
    cwd: options.cwd,
    env: options.env,
    stdio: [options.stdin ?? "ignore", "pipe", "pipe", "pipe"],
  });
  const descriptor = child.stdio[3];
  if (descriptor === undefined || descriptor === null) {
    child.kill();
    throw new Error("Private organizer-key pipe was not created.");
  }
  const stdout = Readable.from(child.stdout, { objectMode: false });
  const stderr = Readable.from(child.stderr, { objectMode: false });
  const privateOutput = Readable.from(Bun.file(descriptor).stream(), { objectMode: false });
  const privateOutputFinished = finished(privateOutput).finally(() => {
    if (process.platform !== "win32" && Bun.semver.satisfies(Bun.version, ">=1.4.0"))
      closeSync(descriptor);
  });
  // Keep the subprocess alive until every reader has reached EOF.
  // Callers consume all three streams, including continuing past the key line.
  const exited = Promise.all([
    child.exited,
    finished(stdout),
    finished(stderr),
    privateOutputFinished,
  ]).then(([code]) => {
    // Bun represents signal exits with exitCode=null and exited=128+signal.
    // Read the native owner here even after every borrowed reader has closed.
    if (child.signalCode === null && child.exitCode !== code)
      throw new Error("Private-pipe process exit changed.");
    return code;
  });
  return {
    child,
    stdout,
    stderr,
    privateOutput,
    exited,
  };
}

export type PrivateKeyProcess = ReturnType<typeof spawnPrivateKeyProcess>;
