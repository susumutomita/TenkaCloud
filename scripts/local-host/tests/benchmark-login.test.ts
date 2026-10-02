import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { spawnHostProcess } from "../bench/host-process";
import { adminLogin, apiCall } from "../bench/http-client";
import { spawnPrivateKeyProcess } from "../private-key-process";

const repository = fileURLToPath(new URL("../../../", import.meta.url));

async function availablePorts() {
  const admin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const participant = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const adminPort = admin.port;
  const participantPort = participant.port;
  await Promise.all([admin.stop(true), participant.stop(true)]);
  if (adminPort === undefined || participantPort === undefined)
    throw new Error("Benchmark test listeners did not receive ports.");
  return { adminPort, participantPort };
}

test("HTTP benchmark starts the production host and signs in repeatedly with its private key", async () => {
  const data = mkdtempSync(join(tmpdir(), "tenka-bench-login-"));
  let host: Awaited<ReturnType<typeof spawnHostProcess>> | undefined;
  try {
    host = await spawnHostProcess({
      repositoryRoot: repository,
      dataDirectory: data,
      ...(await availablePorts()),
      gatewayPorts: { start: 1024, end: 1063 },
      readyTimeoutMs: 5000,
    });
    expect(/^[A-Za-z0-9_-]{43}$/u.test(host.info.hostKey)).toBe(true);
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await adminLogin(host.info.adminOrigin, host.info.hostKey);
      expect((await apiCall(host.info.adminOrigin, "/host/me", "GET", token)).status).toBe(200);
    }
    const publicStatus = await fetch(`${host.info.participantOrigin}/api/host/bootstrap-status`);
    expect(publicStatus.status).toBe(404);
    await publicStatus.text();
    await host.stop();
    for (const file of readdirSync(data))
      expect(readFileSync(join(data, file)).includes(host.info.hostKey)).toBe(false);
  } finally {
    await host?.stop();
    rmSync(data, { recursive: true, force: true });
  }
}, 15_000);

test("benchmark production entry delivers its organizer key only through the private pipe", async () => {
  const data = mkdtempSync(join(tmpdir(), "tenka-bench-private-key-"));
  const ports = await availablePorts();
  const { child, stdout, stderr, privateOutput, exited } = spawnPrivateKeyProcess(
    [
      process.execPath,
      "run",
      "scripts/local-host/bench/host-entry.ts",
      "--no-build",
      "--data",
      data,
      "--admin-port",
      String(ports.adminPort),
      "--participant-port",
      String(ports.participantPort),
      "--gateway-ports",
      "1024-1063",
    ],
    { cwd: repository },
  );
  let output = "";
  for (const stream of [stdout, stderr])
    stream.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
  const lines = createInterface({ input: privateOutput });
  let key = "";
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    key = await new Promise<string>((accept, reject) => {
      timeout = setTimeout(() => reject(new Error("Benchmark key pipe timed out.")), 5000);
      lines.once("line", accept);
      void child.exited.then(
        () => reject(new Error("Benchmark exited before its private key.")),
        reject,
      );
    });
    expect(/^[A-Za-z0-9_-]{43}$/u.test(key)).toBe(true);
    const origin = `http://127.0.0.1:${String(ports.adminPort)}`;
    const token = await adminLogin(origin, key);
    expect((await apiCall(origin, "/host/me", "GET", token)).status).toBe(200);
  } finally {
    clearTimeout(timeout);
    lines.close();
    privateOutput.resume();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGINT");
    expect(await exited).toBe(0);
    if (key) expect(output.includes(key)).toBe(false);
    rmSync(data, { recursive: true, force: true });
  }
}, 15_000);
