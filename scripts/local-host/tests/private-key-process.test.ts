import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { fstatSync, mkdtempSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { closeServer, listen } from "../../lib/node-http";
import { spawnPrivateKeyProcess } from "../private-key-process";

const syntheticKey = "sssssssssssssssssssssssssssssssssssssssssss";
const syntheticKeyLine = `${syntheticKey}\n`;

async function text(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function openDescriptorTargets(): Set<string> {
  return new Set(
    readdirSync("/proc/self/fd").flatMap((descriptor) => {
      try {
        return [readlinkSync(`/proc/self/fd/${descriptor}`)];
      } catch {
        // Reading the directory itself briefly opens another descriptor.
        return [];
      }
    }),
  );
}

async function runChild(): Promise<{
  stdout: string;
  stderr: string;
  key: string;
  privateTarget?: string;
}> {
  const spawned = spawnPrivateKeyProcess(
    [
      process.execPath,
      "-e",
      `import { writeSync } from "node:fs";
process.stdout.write("public startup\\n");
process.stderr.write("public diagnostic\\n");
writeSync(3, ${JSON.stringify(syntheticKeyLine)});`,
    ],
    { cwd: process.cwd() },
  );
  const privateTarget =
    process.platform === "linux"
      ? readlinkSync(`/proc/self/fd/${String(spawned.child.stdio[3])}`)
      : undefined;
  const [code, stdout, stderr, key] = await Promise.all([
    spawned.exited,
    text(spawned.stdout),
    text(spawned.stderr),
    text(spawned.privateOutput),
  ]);
  expect(code).toBe(0);
  return { stdout, stderr, key, privateTarget };
}

test("private child output carries the organizer key separately from public output", async () => {
  const { stdout, stderr, key } = await runChild();
  expect({ stdout, stderr, key }).toEqual({
    stdout: "public startup\n",
    stderr: "public diagnostic\n",
    key: syntheticKeyLine,
  });
});

test("a failed private reader preserves its error and releases caller-owned descriptors", async () => {
  const result = spawnPrivateKeyProcess([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
    cwd: process.cwd(),
  });
  const descriptor = result.child.stdio[3];
  const failure = new Error("Synthetic private reader failure");
  const exited = result.exited.catch((error: unknown) => error);
  result.stdout.resume();
  result.stderr.resume();
  try {
    result.privateOutput.destroy(failure);
    expect(await exited).toBe(failure);
    // Keep the subprocess alive: cleanup must not depend on its exit or GC.
    if (process.platform !== "win32" && Bun.semver.satisfies(Bun.version, ">=1.4.0")) {
      if (descriptor === undefined || descriptor === null)
        throw new Error("Synthetic private descriptor was not created.");
      expect(() => fstatSync(descriptor)).toThrow("EBADF");
    }
  } finally {
    result.child.kill("SIGKILL");
    await result.child.exited;
  }
});

test("collecting private-pipe children cannot close later SQLite descriptors", async () => {
  // Bun 1.3.11's node:child_process extra pipes have two owners. Once a child
  // exits, GC can close its old descriptor number after SQLite has reused it.
  const privateTargets: string[] = [];
  for (let index = 0; index < 12; index++) {
    const { privateTarget } = await runChild();
    if (privateTarget) privateTargets.push(privateTarget);
  }

  const directory = mkdtempSync(join(tmpdir(), "tenka-private-pipe-sqlite-"));
  const databases: Database[] = [];
  try {
    for (let index = 0; index < 24; index++) {
      const database = new Database(join(directory, `${index}.sqlite`));
      databases.push(database);
      database.exec(
        "PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; CREATE TABLE sentinel(value BLOB); INSERT INTO sentinel VALUES(zeroblob(10000));",
      );
    }
    for (let round = 0; round < 6; round++) {
      Bun.gc(true);
      // Let finalizers run, without retaining the completed child handles.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (process.platform === "linux") {
      const openTargets = openDescriptorTargets();
      expect(privateTargets.every((target) => !openTargets.has(target))).toBe(true);
    }
    for (const database of databases) {
      // Evict cached pages so the assertion must read the still-owned WAL.
      database.exec("PRAGMA shrink_memory");
      expect(database.query("SELECT length(value) AS length FROM sentinel").get()).toEqual({
        length: 10000,
      });
      database.exec(
        "INSERT INTO sentinel VALUES(zeroblob(20000)); PRAGMA wal_checkpoint(TRUNCATE)",
      );
      expect(database.query("SELECT sum(length(value)) AS length FROM sentinel").get()).toEqual({
        length: 30000,
      });
    }
  } finally {
    for (const database of databases) database.close();
    rmSync(directory, { recursive: true, force: true });
  }
  if (process.platform === "linux")
    expect([...openDescriptorTargets()].some((target) => target.startsWith(directory))).toBe(false);
});

async function controlledChild(): Promise<void> {
  const result = spawnPrivateKeyProcess(
    [
      "node",
      "--eval",
      `require("node:fs").writeSync(3, ${JSON.stringify(syntheticKeyLine)});
process.stdin.on("data", (data) => process.stdout.write(data));
process.stdin.on("end", () => process.exit(0));`,
    ],
    { cwd: process.cwd(), stdin: "pipe" },
  );
  const input = result.child.stdin;
  if (!input) throw new Error("Synthetic control pipe was not created.");
  const output = Promise.all([
    result.exited,
    text(result.stdout),
    text(result.stderr),
    text(result.privateOutput),
  ]);
  input.write("controlled input\n");
  await input.end();
  expect(await output).toEqual([0, "controlled input\n", "", syntheticKeyLine]);
}

test("collecting controlled Node children leaves later WebSockets connected and responsive", async () => {
  const server = createServer();
  const sockets = new WebSocketServer({ noServer: true });
  const unexpected: unknown[] = [];
  server.on("upgrade", (request, socket, head) =>
    sockets.handleUpgrade(request, socket, head, (accepted) => {
      accepted.on("message", (data) => accepted.send(data));
      accepted.on("close", (code) => unexpected.push({ side: "server", code }));
      accepted.on("error", (error) => unexpected.push(error));
    }),
  );
  const origin = await listen(server, "127.0.0.1", 0);
  const clients: WebSocket[] = [];
  const echoed = new Set<number>();
  try {
    // The study fixture's Node host has a writable control pipe and a private fd 3.
    // Allocate new transports after its normal exit, then collect the old owners.
    // The former node:child_process adapter can close one of these live sockets.
    for (let index = 0; index < 12; index++) await controlledChild();
    for (let index = 0; index < 24; index++) {
      const client = new WebSocket(origin.replace(/^http/u, "ws"));
      clients.push(client);
      client.on("message", (data) => {
        if (data.toString() === "echo") echoed.add(index);
      });
      client.on("close", (code) => unexpected.push({ side: "client", index, code }));
      client.on("error", (error) => unexpected.push(error));
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Synthetic handshake timed out.")), 1000);
        client.once("open", () => {
          clearTimeout(timer);
          resolve();
        });
        client.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
    }
    for (let round = 0; round < 6; round++) {
      Bun.gc(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    for (const client of clients) client.send("echo");
    const deadline = Date.now() + 1000;
    while (echoed.size !== clients.length && unexpected.length === 0 && Date.now() < deadline)
      await Bun.sleep(5);
    expect(unexpected).toEqual([]);
    expect(echoed.size).toBe(clients.length);
    expect(clients.every((client) => client.readyState === WebSocket.OPEN)).toBe(true);
  } finally {
    for (const client of clients) client.terminate();
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    server.closeAllConnections();
    await closeServer(server);
  }
});

const exitCases = [
  { code: 0, signal: undefined },
  { code: 7, signal: undefined },
  { code: 130, signal: "SIGINT" as const },
  { code: 137, signal: "SIGKILL" as const },
] as const;

test.each(
  exitCases.flatMap((entry) => [
    { ...entry, stdin: undefined },
    { ...entry, stdin: "pipe" as const },
  ]),
)(
  "private pipe preserves exit status $code with signal $signal and stdin $stdin",
  async ({ code, signal, stdin }) => {
    const result = spawnPrivateKeyProcess(
      [
        process.execPath,
        "--eval",
        signal ? "console.log('ready');setInterval(()=>{},1000)" : `process.exit(${code})`,
      ],
      { cwd: process.cwd(), stdin },
    );
    // Attach rejection handling before the child can finish.
    const exited = result.exited.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    const ready = signal
      ? new Promise<void>((resolve) => result.stdout.once("data", () => resolve()))
      : Promise.resolve();
    result.stdout.resume();
    result.stderr.resume();
    result.privateOutput.resume();
    try {
      await ready;
      if (signal) result.child.kill(signal);
      expect(await exited).toEqual({ value: code });
      expect(result.child.exitCode).toBe(signal ? null : code);
      expect(result.child.signalCode).toBe(signal ?? null);
    } finally {
      if (result.child.exitCode === null && result.child.signalCode === null)
        result.child.kill("SIGKILL");
      await result.child.exited;
      await exited;
    }
  },
);
