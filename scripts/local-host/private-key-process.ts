import { Readable } from "node:stream";
import { finished } from "node:stream/promises";

/**
 * Bun 1.3.11's node:child_process adapter gives extra pipes two fd owners: the
 * Node socket and the native subprocess. After the socket closes, later GC can
 * close an unrelated file that reused its fd. Keep fd 3 owned only by Bun's
 * subprocess; Bun.file borrows it without introducing a second socket owner.
 */
export function spawnPrivateKeyProcess(
  command: readonly string[],
  options: { readonly cwd: string; readonly env?: NodeJS.ProcessEnv },
) {
  const child = Bun.spawn([...command], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  const descriptor = child.stdio[3];
  if (descriptor === undefined || descriptor === null) {
    child.kill();
    throw new Error("Private organizer-key pipe was not created.");
  }
  const stdout = Readable.from(child.stdout, { objectMode: false });
  const stderr = Readable.from(child.stderr, { objectMode: false });
  const privateOutput = Readable.from(Bun.file(descriptor).stream(), { objectMode: false });
  // Keep the native fd owner alive until every borrowed reader has reached EOF.
  // Callers consume all three streams, including continuing past the key line.
  const exited = Promise.all([
    child.exited,
    finished(stdout),
    finished(stderr),
    finished(privateOutput),
  ]).then(([code]) => {
    if (child.exitCode !== code) throw new Error("Private-pipe process exit changed.");
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
