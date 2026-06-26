import { createServer } from "node:net";
import { isLocalApiHealthy } from "./api";

/**
 * Returns true if a process with `pid` is still running. `process.kill(pid, 0)`
 * sends no signal; it only probes existence. EPERM means the process exists but
 * we may not signal it, so it counts as alive; ESRCH means it is gone.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Fail loudly if `port` on loopback is already in use. We bind a throwaway
 * server and treat any bind error (EADDRINUSE) as "occupied". This is the
 * guard that stops `up()` from silently adopting a foreign server on the API
 * port (the cause of "the screen loads but you cannot play").
 */
export function assertPortFree(port: number, label: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const tester = createServer();
    tester.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        new Error(
          `${label} port ${port} is already in use (${error.code ?? "EADDRINUSE"}). ` +
            "Stop whatever holds it (e.g. an old `make local`) or pass a different port " +
            "via LOCAL_API_PORT / KUMO_PORT.",
        ),
      );
    });
    tester.once("listening", () => {
      tester.close((closeError) => (closeError ? reject(closeError) : resolvePromise()));
    });
    tester.listen(port, "127.0.0.1");
  });
}

/**
 * Wait until the local Participant API at `apiBaseUrl` reports it is *our*
 * server for `problemId`. Fails loudly when the spawned process dies, when a
 * foreign server answers the port, or on timeout -- never silently succeeds
 * against the wrong backend.
 */
export async function waitForLocalApi(
  apiBaseUrl: string,
  problemId: string,
  pid: number,
  logPath: string,
  timeoutMs = 30_000,
  pollIntervalMs = 250,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      throw new Error(
        `Local Participant API (pid ${pid}) exited before becoming ready. See ${logPath}.`,
      );
    }
    let body: unknown;
    try {
      const response = await fetch(`${apiBaseUrl}/healthz`);
      body = response.ok ? await response.json() : undefined;
    } catch {
      body = undefined; // startup race; the server may not be listening yet
    }
    if (body !== undefined) {
      if (isLocalApiHealthy(body, problemId)) return;
      throw new Error(
        `${apiBaseUrl} is served by another process (healthz=${JSON.stringify(body)}); ` +
          `expected local play for "${problemId}". Stop it or pass a different LOCAL_API_PORT.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`Timed out waiting for local Participant API: ${apiBaseUrl}`);
}
