import type { Client } from "@libsql/client";
import { type LocalPlayStateStore, parseLocalPlaySnapshot } from "./state-store";

export interface TursoLocalPlayStateStoreOptions {
  readonly url: string;
  readonly authToken: string;
}

function validateOptions(options: TursoLocalPlayStateStoreOptions): void {
  let url: URL;
  try {
    url = new URL(options.url);
  } catch {
    throw new Error("TENKACLOUD_LOCAL_TURSO_URL must be a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "libsql:") {
    throw new Error("TENKACLOUD_LOCAL_TURSO_URL must use https:// or libsql://");
  }
  if (url.username || url.password) {
    throw new Error("TENKACLOUD_LOCAL_TURSO_URL must not contain credentials");
  }
  if (!options.authToken.trim()) {
    throw new Error("TENKACLOUD_LOCAL_TURSO_AUTH_TOKEN is required for the Turso backend");
  }
}

/** Optional remote libSQL adapter. The default local path never imports this module. */
export async function openTursoLocalPlayStateStore(
  options: TursoLocalPlayStateStoreOptions,
): Promise<LocalPlayStateStore> {
  validateOptions(options);
  const { createClient } = await import("@libsql/client/http");
  const client: Client = createClient({ url: options.url, authToken: options.authToken });
  await client.execute(`
    CREATE TABLE IF NOT EXISTS local_play_state (
      session_id TEXT PRIMARY KEY CHECK (session_id = 'default'),
      snapshot_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT
  `);
  return {
    description: `Turso ${new URL(options.url).host}`,
    load: async () => {
      const result = await client.execute({
        sql: "SELECT snapshot_json FROM local_play_state WHERE session_id = 'default'",
        args: [],
      });
      const serialized = result.rows[0]?.snapshot_json;
      if (serialized === undefined) return undefined;
      if (typeof serialized !== "string") {
        throw new Error("Turso local-play snapshot_json is not a string");
      }
      return parseLocalPlaySnapshot(serialized);
    },
    save: async (snapshot) => {
      await client.execute({
        sql: `
          INSERT INTO local_play_state (session_id, snapshot_json, updated_at)
          VALUES ('default', ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET
            snapshot_json = excluded.snapshot_json,
            updated_at = excluded.updated_at
        `,
        args: [JSON.stringify(snapshot), new Date().toISOString()],
      });
    },
    close: async () => {
      client.close();
    },
  };
}
