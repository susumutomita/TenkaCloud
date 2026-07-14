import type { LocalPaths } from "./session-state";
import { openSqliteLocalPlayStateStore } from "./sqlite-state-store";
import type { LocalPlayStateStore } from "./state-store";

export type LocalPlayDatabaseBackend = "sqlite" | "turso";

export function localPlayDatabaseBackend(env: NodeJS.ProcessEnv): LocalPlayDatabaseBackend {
  const value = env.TENKACLOUD_LOCAL_DATABASE?.trim() || "sqlite";
  if (value !== "sqlite" && value !== "turso") {
    throw new Error("TENKACLOUD_LOCAL_DATABASE must be sqlite or turso");
  }
  return value;
}

export interface LocalPlayStateStoreOpeners {
  readonly sqlite: (path: string) => Promise<LocalPlayStateStore>;
  readonly turso: (options: {
    readonly url: string;
    readonly authToken: string;
  }) => Promise<LocalPlayStateStore>;
}

const defaultOpeners: LocalPlayStateStoreOpeners = {
  sqlite: openSqliteLocalPlayStateStore,
  turso: async (options) => {
    const { openTursoLocalPlayStateStore } = await import("./turso-state-store");
    return openTursoLocalPlayStateStore(options);
  },
};

export async function openLocalPlayStateStore(
  paths: LocalPaths,
  env: NodeJS.ProcessEnv = process.env,
  openers: LocalPlayStateStoreOpeners = defaultOpeners,
): Promise<LocalPlayStateStore> {
  if (localPlayDatabaseBackend(env) === "sqlite") {
    return openers.sqlite(paths.databasePath);
  }
  return openers.turso({
    url: env.TENKACLOUD_LOCAL_TURSO_URL ?? "",
    authToken: env.TENKACLOUD_LOCAL_TURSO_AUTH_TOKEN ?? "",
  });
}
