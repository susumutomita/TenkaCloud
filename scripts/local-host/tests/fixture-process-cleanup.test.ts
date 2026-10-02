import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnHostProcess } from "../bench/host-process";
import { inspectTemporaryDirectories } from "../temporary-directory";

const repository = fileURLToPath(new URL("../../../", import.meta.url));

test("a rehearsal startup failure cleans its new fixture directory", async () => {
  const occupied = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("occupied"),
  });
  const child = Bun.spawn([process.execPath, "run", "scripts/local-host/tests/e2e-host.ts"], {
    cwd: repository,
    env: { ...process.env, HOST_E2E_ENGINE: "fixture", HOST_E2E_ADMIN_PORT: String(occupied.port) },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const [code, output] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);
    expect(code).toBe(1);
    expect(output).toContain("EADDRINUSE");
    expect(
      inspectTemporaryDirectories(repository).some((entry) => entry.ownerPid === child.pid),
    ).toBe(false);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await child.exited;
    }
    await occupied.stop(true);
  }
});

test("benchmark stop waits for the exact spawned child before fixture deletion", async () => {
  const root = mkdtempSync(join(tmpdir(), "tenka-bench-child-synthetic-"));
  const scripts = join(root, "scripts/local-host/bench");
  mkdirSync(scripts, { recursive: true });
  const closed = join(root, "closed.txt");
  writeFileSync(
    join(scripts, "host-entry.ts"),
    `import { writeFileSync, writeSync } from "node:fs";
process.once("SIGINT", async () => { await Bun.sleep(50); writeFileSync(${JSON.stringify(closed)}, "closed"); process.exit(0); });
console.log("Host console: http://127.0.0.1:1\\nParticipant portal: http://127.0.0.1:2\\nState: synthetic.sqlite");
writeSync(3, "sssssssssssssssssssssssssssssssssssssssssss\\n");
await Bun.sleep(10000);
`,
  );
  let host: Awaited<ReturnType<typeof spawnHostProcess>> | undefined;
  try {
    host = await spawnHostProcess({
      repositoryRoot: root,
      dataDirectory: root,
      adminPort: 1,
      participantPort: 2,
      gatewayPorts: { start: 5300, end: 5339 },
      readyTimeoutMs: 1000,
    });
    expect(existsSync(closed)).toBe(false);
    await host.stop();
    expect(readFileSync(closed, "utf8")).toBe("closed");
    await host.stop();
  } finally {
    await host?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("benchmark ignores public keys and stops a timed-out child before rejecting startup", async () => {
  const root = mkdtempSync(join(tmpdir(), "tenka-bench-startup-synthetic-"));
  const scripts = join(root, "scripts/local-host/bench");
  mkdirSync(scripts, { recursive: true });
  const closed = join(root, "closed.txt");
  writeFileSync(
    join(scripts, "host-entry.ts"),
    `import { writeFileSync } from "node:fs";
process.once("SIGINT", async () => { await Bun.sleep(50); writeFileSync(${JSON.stringify(closed)}, "closed"); process.exit(0); });
console.log("Host console: http://127.0.0.1:1\\nParticipant portal: http://127.0.0.1:2\\nHost login key: sssssssssssssssssssssssssssssssssssssssssss\\nState: synthetic.sqlite");
await Bun.sleep(10000);
`,
  );
  let host: Awaited<ReturnType<typeof spawnHostProcess>> | undefined;
  try {
    const started = spawnHostProcess({
      repositoryRoot: root,
      dataDirectory: root,
      adminPort: 1,
      participantPort: 2,
      gatewayPorts: { start: 5300, end: 5339 },
      readyTimeoutMs: 500,
    }).then((running) => {
      host = running;
      return running;
    });
    await expect(started).rejects.toThrow("did not become ready");
    expect(readFileSync(closed, "utf8")).toBe("closed");
  } finally {
    await host?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("benchmark interrupt waits for asynchronous cleanup before exit", async () => {
  const root = mkdtempSync(join(tmpdir(), "tenka-bench-interrupt-synthetic-"));
  const closed = join(root, "closed.txt");
  const script = join(root, "interrupt.ts");
  writeFileSync(
    script,
    `import { writeFileSync } from "node:fs";
import { exitOnInterrupt, onInterrupt } from ${JSON.stringify(join(repository, "scripts/local-host/bench/interrupt.ts"))};
exitOnInterrupt();
onInterrupt(async () => { await Bun.sleep(30); writeFileSync(${JSON.stringify(closed)}, "closed"); });
process.kill(process.pid, "SIGTERM");
await Bun.sleep(10000);
`,
  );
  const child = Bun.spawn([process.execPath, script], { stdout: "ignore", stderr: "pipe" });
  try {
    expect(await child.exited).toBe(143);
    expect(readFileSync(closed, "utf8")).toBe("closed");
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await child.exited;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
