import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomToken } from "../auth";
import { resetLocalOrganizerKey, stopManagedLocal } from "../local";

const sessionFile = "local-session.json";

function temporary() {
  return mkdtempSync(join(tmpdir(), "tenka-local-process-"));
}

test("down never signals an unrelated live PID or accepts a different controller session", async () => {
  const data = temporary();
  const sentinel = join(data, "retained-data");
  writeFileSync(sentinel, "keep");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ sessionId: randomToken(), code: 0 }),
  });
  const session = {
    protocol: 2,
    pid: process.pid,
    port: server.port,
    token: randomToken(),
    sessionId: randomToken(),
  };
  writeFileSync(join(data, sessionFile), JSON.stringify(session), { mode: 0o600 });
  try {
    await expect(stopManagedLocal(data)).rejects.toThrow("no PID was signalled");
    expect(process.kill(process.pid, 0)).toBe(true);
    expect(readFileSync(join(data, sessionFile), "utf8") === JSON.stringify(session)).toBe(true);
    expect(readFileSync(sentinel, "utf8")).toBe("keep");
  } finally {
    await server.stop(true);
    rmSync(data, { recursive: true, force: true });
  }
});

test("down removes dead-owner metadata without touching retained data", async () => {
  const data = temporary();
  const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await child.exited;
  const sentinel = join(data, "retained-data");
  writeFileSync(sentinel, "keep");
  writeFileSync(
    join(data, sessionFile),
    JSON.stringify({ pid: child.pid, port: 65530, token: randomToken(), sessionId: randomToken() }),
    { mode: 0o600 },
  );
  try {
    await stopManagedLocal(data);
    expect(existsSync(join(data, sessionFile))).toBe(false);
    expect(readFileSync(sentinel, "utf8")).toBe("keep");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("key recovery rejects absent or unrelated state without creating host records", async () => {
  const data = temporary();
  const path = join(data, "hosting.sqlite");
  try {
    await expect(resetLocalOrganizerKey(data)).rejects.toThrow("No existing local host database");
    expect(existsSync(join(data, "local-launcher.sqlite"))).toBe(false);
    const unrelated = new Database(path);
    unrelated.run("CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES ('retain');");
    unrelated.close();
    const before = readFileSync(path);
    await expect(resetLocalOrganizerKey(data)).rejects.toThrow("not an existing TenkaCloud");
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(existsSync(join(data, "local-launcher.sqlite"))).toBe(false);
    expect(existsSync(join(data, "host-key"))).toBe(false);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("legacy controllers are refused before sending a reset or shutdown request", async () => {
  const data = temporary();
  const database = new Database(join(data, "hosting.sqlite"));
  database.run("CREATE TABLE host_schema(version INTEGER); INSERT INTO host_schema VALUES (5);");
  database.close();
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      requests += 1;
      return Response.json({});
    },
  });
  writeFileSync(
    join(data, sessionFile),
    JSON.stringify({
      pid: process.pid,
      port: server.port,
      token: randomToken(),
      sessionId: randomToken(),
    }),
    { mode: 0o600 },
  );
  try {
    await expect(resetLocalOrganizerKey(data)).rejects.toThrow("original terminal");
    await expect(stopManagedLocal(data)).rejects.toThrow("original terminal");
    expect(requests).toBe(0);
  } finally {
    await server.stop(true);
    rmSync(data, { recursive: true, force: true });
  }
});
