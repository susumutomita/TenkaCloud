import type { SqlDatabase } from "./model";

/** Local persistence adapter only. Cloud requests must use external durable repositories. */
export async function localDatabaseOpener(): Promise<(path: string) => SqlDatabase> {
  if (typeof Bun !== "undefined") {
    const { Database } = await import("bun:sqlite");
    return (path) => new Database(path, { create: true, strict: true });
  }
  const { DatabaseSync } = await import("node:sqlite");
  return (path) => new DatabaseSync(path);
}

export async function openLocalDatabase(path: string): Promise<SqlDatabase> {
  return (await localDatabaseOpener())(path);
}
