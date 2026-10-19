import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { spawnHostProcess } from "../bench/host-process";
import { adminLogin, apiCall } from "../bench/http-client";
import { spawnPrivateKeyProcess } from "../private-key-process";
import { ensureHostBuild } from "./host-build-fixture";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
await ensureHostBuild(repository);

/** Authentication uses the production native host without depending on a Docker daemon. */
function loginFixture() {
  const root = mkdtempSync(join(tmpdir(), "tenka-bench-login-"));
  const data = join(root, "state");
  const bin = join(root, "bin");
  const probes = join(root, "docker-probes.log");
  mkdirSync(data, { mode: 0o700 });
  mkdirSync(bin, { mode: 0o700 });
  for (const command of ["docker", "docker-compose"]) {
    writeFileSync(
      join(bin, command),
      `#!/bin/sh\nprintf '%s\\n' ${command} >> "$TENKACLOUD_TEST_DOCKER_LOG"\nexit 1\n`,
      { mode: 0o700 },
    );
  }
  return {
    root,
    data,
    probes,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      TENKACLOUD_COMPOSE_CLI: "",
      TENKACLOUD_TEST_DOCKER_LOG: probes,
    },
  };
}

function expectFixtureProbes(probes: string): void {
  expect(readFileSync(probes, "utf8").trim().split("\n")).toEqual(["docker", "docker-compose"]);
}

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
  const fixture = loginFixture();
  const { data } = fixture;
  let host: Awaited<ReturnType<typeof spawnHostProcess>> | undefined;
  try {
    host = await spawnHostProcess({
      repositoryRoot: repository,
      dataDirectory: data,
      ...(await availablePorts()),
      gatewayPorts: { start: 1024, end: 1063 },
      readyTimeoutMs: 5000,
      env: fixture.env,
    });
    expectFixtureProbes(fixture.probes);
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
    rmSync(fixture.root, { recursive: true, force: true });
  }
}, 15_000);

test("benchmark production entry delivers its organizer key only through the private pipe", async () => {
  const fixture = loginFixture();
  const { data } = fixture;
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
    { cwd: repository, env: fixture.env },
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
    expectFixtureProbes(fixture.probes);
  } finally {
    clearTimeout(timeout);
    lines.close();
    privateOutput.resume();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGINT");
    expect(await exited).toBe(0);
    if (key) expect(output.includes(key)).toBe(false);
    rmSync(fixture.root, { recursive: true, force: true });
  }
}, 15_000);
