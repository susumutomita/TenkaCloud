import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
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
