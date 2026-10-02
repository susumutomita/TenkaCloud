/** Starts only an explicitly supplied, already installed sqld binary on loopback. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { isAbsolute } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { createClient } from "@libsql/client/http";

export function installedSqld(path: string | undefined) {
  assert.ok(
    path && isAbsolute(path),
    "Pass the absolute path to an installed official sqld binary.",
  );
  const version = spawnSync(path, ["--version"], { env: { PATH: process.env.PATH } });
  assert.equal(version.status, 0, version.stderr.toString());
  return {
    path,
    version: version.stdout.toString().trim(),
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
  };
}

export async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

export function localClient(port: number, timeoutMs = 10000) {
  const timedFetch: typeof fetch = (input, init) =>
    fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  return createClient({
    url: `http://127.0.0.1:${port}`,
    fetch: timedFetch,
  });
}

export async function startSqld(
  binary: string,
  dbPath: string,
  port: number,
  extra: string[] = [],
) {
  const processHandle = spawn(
    binary,
    ["--no-welcome", "--db-path", dbPath, "--http-listen-addr", `127.0.0.1:${port}`, ...extra],
    { env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let logs = "";
  for (const stream of [processHandle.stdout, processHandle.stderr])
    stream.on("data", (value: Buffer) => {
      logs = `${logs}${value.toString()}`.slice(-20000);
    });
  const exited = new Promise<void>((resolve, reject) => {
    processHandle.once("exit", () => resolve());
    processHandle.once("error", reject);
  });
  const stop = async () => {
    processHandle.kill("SIGTERM");
    const timeout = setTimeout(() => processHandle.kill("SIGKILL"), 5000);
    try {
      await exited;
    } finally {
      clearTimeout(timeout);
    }
  };
  const client = localClient(port, 1000);
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await client.execute("SELECT 1");
        return { stop, logs: () => logs };
      } catch {
        assert.equal(processHandle.exitCode, null, `sqld exited before readiness: ${logs}`);
        await pause(50);
      }
    }
    throw new Error(`Local sqld did not become ready: ${logs}`);
  } catch (error) {
    await stop();
    throw error;
  } finally {
    client.close();
  }
}

export async function eventually(check: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await pause(50);
  }
  throw new Error("Local replica did not catch up within the rehearsal deadline.");
}
