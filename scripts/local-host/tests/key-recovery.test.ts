import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hasDatabaseState, persistentKey, prepareDatabase } from "../files";
import type { RuntimeEngine } from "../model";
import { startLocalHost } from "../server";
import { HostStore } from "../store";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), "tenka-key-recovery-"));
  directories.push(directory);
  return directory;
}

const unavailable = async (): Promise<never> => {
  throw new Error("A key recovery test must not call an exercise runtime.");
};
const engine: RuntimeEngine = {
  catalog: () => [],
  start: unavailable,
  recover: unavailable,
  stop: unavailable,
  pause: unavailable,
  resume: unavailable,
  view: unavailable,
  submit: unavailable,
  hint: unavailable,
  surface: () => {
    throw new Error("A key recovery test must not open an exercise surface.");
  },
};

function start(dataDirectory: string, createEngine = () => engine) {
  return startLocalHost(
    root,
    {
      dataDirectory,
      hostname: "127.0.0.1",
      adminPort: 0,
      participantPort: 0,
      gatewayPorts: { start: 58000, end: 58039 },
    },
    createEngine,
    () => undefined,
  );
}

function storedState() {
  const directory = temporary();
  const databasePath = join(directory, "hosting.sqlite");
  const keyPath = join(directory, "host-key");
  const key = persistentKey(keyPath);
  prepareDatabase(databasePath);
  const store = new HostStore(new Database(databasePath));
  try {
    store.putEvent({
      eventId: "synthetic-event",
      name: "Synthetic recovery fixture",
      status: "DRAFT",
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      expiresAt: 0,
      scoringLocked: false,
      scoreboardFreezeMinutes: 0,
      problems: [],
    });
  } finally {
    store.close();
  }
  return { directory, databasePath, keyPath, key };
}

test.each([false, true])(
  "a fresh host initializes and reuses its key (empty file: %s)",
  async (emptyFile) => {
    const directory = temporary();
    const databasePath = join(directory, "hosting.sqlite");
    if (emptyFile) writeFileSync(databasePath, "", { mode: 0o600 });
    expect(hasDatabaseState(databasePath)).toBe(false);
    const first = await start(directory);
    const key = first.masterKey;
    await first.stop();
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(hasDatabaseState(databasePath)).toBe(true);
    expect(statSync(first.masterKeyPath).mode & 0o777).toBe(0o600);
    const second = await start(directory);
    try {
      expect(second.masterKey).toBe(key);
    } finally {
      await second.stop();
    }
  },
);

test.each(["missing", "malformed"])(
  "%s host-key refuses populated state before opening SQLite",
  async (damage) => {
    const f = storedState();
    if (damage === "missing") unlinkSync(f.keyPath);
    else writeFileSync(f.keyPath, "invalid\n");
    const before = readFileSync(f.databasePath);
    let engineCreated = false;
    await expect(
      start(f.directory, () => {
        engineCreated = true;
        return engine;
      }),
    ).rejects.toThrow(damage === "missing" ? "Missing host-key file" : "Invalid host-key file");
    expect(engineCreated).toBe(false);
    expect(readFileSync(f.databasePath)).toEqual(before);
    expect(existsSync(f.keyPath)).toBe(damage !== "missing");
    if (damage === "malformed") expect(readFileSync(f.keyPath, "utf8")).toBe("invalid\n");
  },
);

test("missing host-key refuses a legacy database before any schema migration", async () => {
  const directory = temporary();
  const path = join(directory, "hosting.sqlite");
  const database = new Database(path);
  database.exec(
    "CREATE TABLE host_schema(version INTEGER NOT NULL); INSERT INTO host_schema VALUES (1)",
  );
  database.close();
  const before = readFileSync(path);
  await expect(start(directory)).rejects.toThrow("Missing host-key file");
  expect(readFileSync(path)).toEqual(before);
  expect(existsSync(join(directory, "host-key"))).toBe(false);
});

test("required keys preserve private permissions and reject symbolic and hard links", () => {
  const directory = temporary();
  const path = join(directory, "host-key");
  expect(() => persistentKey(path, false)).toThrow("Missing host-key file");
  expect(existsSync(path)).toBe(false);
  const key = persistentKey(path);
  chmodSync(path, 0o644);
  expect(persistentKey(path, false)).toBe(key);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  const symbolic = join(directory, "symbolic-key");
  symlinkSync(path, symbolic);
  expect(() => persistentKey(symbolic, false)).toThrow();
  const hard = join(directory, "hard-key");
  linkSync(path, hard);
  expect(() => persistentKey(hard, false)).toThrow("Expected a regular private file, not a link.");
  expect(readFileSync(path, "utf8")).toBe(`${key}\n`);
});

test("database recovery checks reject linked databases before key creation", async () => {
  for (const link of [symlinkSync, linkSync]) {
    const directory = temporary();
    const original = join(directory, "original.sqlite");
    writeFileSync(original, "synthetic nonempty state", { mode: 0o600 });
    link(original, join(directory, "hosting.sqlite"));
    await expect(start(directory)).rejects.toThrow("Expected a regular private file, not a link.");
    expect(existsSync(join(directory, "host-key"))).toBe(false);
  }
});
