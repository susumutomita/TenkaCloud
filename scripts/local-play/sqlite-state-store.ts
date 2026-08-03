import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type LocalPlayStateStore, parseLocalPlaySnapshot } from "./state-store";

function assertSafeDatabasePath(path: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink()) {
    throw new Error(`Local SQLite directory must not be a symbolic link: ${directory}`);
  }
  if (!existsSync(path)) return;
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Local SQLite database must be a regular file: ${path}`);
  }
}

/** Embedded SQLite adapter. Loaded only by Bun's local CLI, never by Lambda. */
export async function openSqliteLocalPlayStateStore(path: string): Promise<LocalPlayStateStore> {
  assertSafeDatabasePath(path);
  const { Database } = await import("bun:sqlite");
  const database = new Database(path, { create: true, strict: true });
  chmodSync(path, 0o600);
  database.run("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
  database.run(`
    CREATE TABLE IF NOT EXISTS local_play_state (
      session_id TEXT PRIMARY KEY CHECK (session_id = 'default'),
      snapshot_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
  `);
  const select = database.query(
    "SELECT snapshot_json FROM local_play_state WHERE session_id = 'default'",
  );
  const upsert = database.query(`
    INSERT INTO local_play_state (session_id, snapshot_json, updated_at)
    VALUES ('default', ?1, ?2)
    ON CONFLICT(session_id) DO UPDATE SET
      snapshot_json = excluded.snapshot_json,
      updated_at = excluded.updated_at
  `);
  const clear = database.query("DELETE FROM local_play_state WHERE session_id = 'default'");
  return {
    description: `SQLite ${path}`,
    load: async () => {
      const row = select.get() as { snapshot_json?: unknown } | null;
      if (!row) return undefined;
      if (typeof row.snapshot_json !== "string") {
        throw new Error("Local SQLite snapshot_json is not a string");
      }
      return parseLocalPlaySnapshot(row.snapshot_json);
    },
    save: async (snapshot) => {
      upsert.run(JSON.stringify(snapshot), new Date().toISOString());
    },
    clear: async () => {
      clear.run();
    },
    close: async () => {
      database.close();
    },
  };
}
