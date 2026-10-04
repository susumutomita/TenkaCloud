import { Database } from "bun:sqlite";
import { lstatSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { randomToken, sameSecret } from "./auth";
import { hasDatabaseState, prepareDatabase, privateDirectory } from "./files";
import { clearLocalHistory, parseLocalClearOptions } from "./local-clear";
import { runLocalHost } from "./main";
import { parseOptions } from "./options";
import { openOrganizerKeyDisplay } from "./organizer-key-output";
import { HostStore } from "./store";

const sessionSchema = z.object({
  protocol: z.literal(2).optional(),
  pid: z.number().int().positive(),
  port: z.number().int().min(1024).max(65535),
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
});
type LocalSession = z.infer<typeof sessionSchema>;
const SESSION_FILE = "local-session.json";

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function readSession(path: string): LocalSession | undefined {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error("Refusing an unsafe local-session file.");
  return sessionSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

function acquireLocalLock(directory: string): Database {
  const path = join(directory, "local-launcher.sqlite");
  prepareDatabase(path);
  const lock = new Database(path);
  try {
    lock.run(
      "PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner_lock(id INTEGER PRIMARY KEY); COMMIT;",
    );
    return lock;
  } catch (error) {
    lock.close();
    throw new Error("Cannot acquire the local controller lock; another process may own it.", {
      cause: error,
    });
  }
}

function claimSession(path: string, session: LocalSession): void {
  const prior = readSession(path);
  if (prior) {
    if (prior.pid !== process.pid && alive(prior.pid))
      throw new Error("This local host already has a live owner. Use make down first.");
    // Only dead-owner launcher metadata is removed. Event and runtime files are untouched.
    unlinkSync(path);
  }
  writeFileSync(path, `${JSON.stringify(session)}\n`, { flag: "wx", mode: 0o600 });
}

function releaseSession(path: string, sessionId: string): void {
  if (readSession(path)?.sessionId === sessionId) unlinkSync(path);
}

export async function stopManagedLocal(directory: string): Promise<void> {
  const data = realpathSync(privateDirectory(directory));
  const path = join(data, SESSION_FILE);
  const session = readSession(path);
  if (!session) {
    console.log("No managed local host is running; event data is unchanged.");
    return;
  }
  if (!alive(session.pid)) {
    const lock = acquireLocalLock(directory);
    try {
      releaseSession(path, session.sessionId);
    } finally {
      lock.close();
    }
    console.log(
      "The local controller is already stopped. Retained runtimes need recovery on make local.",
    );
    return;
  }
  if (session.protocol !== 2)
    throw new Error(
      "This controller predates directory-bound commands. Stop its original terminal with Ctrl+C, then run make local again; no PID was signalled.",
    );
  // Never signal a PID read from a file: it may now belong to an unrelated process.
  const response = await fetch(`http://127.0.0.1:${String(session.port)}/down`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${session.token}`,
      "x-tenkacloud-data-directory": encodeURIComponent(data),
    },
    signal: AbortSignal.timeout(60_000),
  });
  const result: unknown = await response.json();
  const parsed = z
    .object({
      sessionId: z.string(),
      code: z.number(),
      directory: z.string(),
      error: z.string().optional(),
    })
    .safeParse(result);
  if (
    !parsed.success ||
    !sameSecret(parsed.data.sessionId, session.sessionId) ||
    parsed.data.directory !== data
  )
    throw new Error(
      "The shutdown endpoint does not belong to this local host; no PID was signalled.",
    );
  if (!response.ok || parsed.data.code !== 0) {
    const detail = parsed.data.error ?? "Read the local terminal for details.";
    throw new Error(`Local shutdown reported a failure. Retained data was not reset.\n${detail}`);
  }
  console.log("Local host stopped. Event data and stopped Docker runtime data are retained.");
}

function assertExistingHostDatabase(path: string): void {
  const database = new Database(path, { readonly: true, strict: true });
  try {
    const present = database.query("SELECT name FROM sqlite_master WHERE name='host_schema'").get();
    if (!present) throw new Error("This is not an existing TenkaCloud local-host database.");
    const versions = database.query("SELECT version FROM host_schema").all() as {
      version: number;
    }[];
    if (versions.length !== 1 || ![1, 2, 3, 4, 5].includes(versions[0]?.version ?? 0))
      throw new Error("Unsupported local-host database schema; no key was rotated.");
  } finally {
    database.close();
  }
}

/** Local filesystem ownership authorizes recovery; neither a team key nor the old key does. */
export async function resetLocalOrganizerKey(directory: string): Promise<string> {
  try {
    lstatSync(directory);
  } catch (error) {
    if (missing(error)) throw new Error("No existing local host state. Run make local first.");
    throw error;
  }
  const data = realpathSync(privateDirectory(directory));
  const databasePath = join(data, "hosting.sqlite");
  if (!hasDatabaseState(databasePath))
    throw new Error("No existing local host database. Run make local first.");
  const session = readSession(join(data, SESSION_FILE));
  if (session && alive(session.pid)) {
    if (session.protocol !== 2)
      throw new Error(
        "Stop the previous local host in its original terminal with Ctrl+C before organizer-key recovery. No key was rotated.",
      );
    const response = await fetch(`http://127.0.0.1:${String(session.port)}/reset-organizer-key`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.token}`,
        "x-tenkacloud-data-directory": encodeURIComponent(data),
      },
      signal: AbortSignal.timeout(10_000),
    });
    const parsed = z
      .object({
        sessionId: z.string(),
        directory: z.string(),
        key: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
      })
      .safeParse(await response.json());
    if (
      !response.ok ||
      !parsed.success ||
      !sameSecret(parsed.data.sessionId, session.sessionId) ||
      parsed.data.directory !== data
    )
      throw new Error("Could not confirm organizer-key rotation with this local host.");
    return parsed.data.key;
  }
  // Recovery must not initialize a different application's SQLite file.
  assertExistingHostDatabase(databasePath);
  const lock = acquireLocalLock(data);
  let store: HostStore | undefined;
  try {
    prepareDatabase(databasePath);
    store = new HostStore(new Database(databasePath, { strict: true }));
    return store.rotateLocalOrganizerKey();
  } finally {
    store?.close();
    lock.close();
  }
}

function replyWithRotatedKey(
  response: ServerResponse,
  target: { sessionId: string; directory: string },
  rotate: (() => string) | undefined,
): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "application/json");
  if (!rotate) {
    response.writeHead(503).end(JSON.stringify(target));
    return;
  }
  try {
    response.end(JSON.stringify({ ...target, key: rotate() }));
  } catch {
    response.writeHead(500).end(JSON.stringify(target));
  }
}

export async function runManagedLocal(root: string, args: string[]): Promise<number> {
  const options = parseOptions(args, root);
  if (options.help) {
    await runLocalHost(args);
    return 0;
  }
  process.umask(0o077);
  const directory = realpathSync(privateDirectory(options.dataDirectory));
  const path = join(directory, SESSION_FILE);
  const token = randomToken();
  const sessionId = randomToken();
  const shutdown = new AbortController();
  let lock: Database | undefined;
  let exited: Promise<number> = Promise.resolve(1);
  let rotateOrganizerKey: (() => string) | undefined;
  let shutdownError: string | undefined;
  const control = createServer((request, response) => {
    if (
      request.method !== "POST" ||
      (request.url !== "/down" && request.url !== "/reset-organizer-key") ||
      !sameSecret(request.headers.authorization ?? "", `Bearer ${token}`)
    ) {
      response.writeHead(403).end();
      return;
    }
    if (request.headers["x-tenkacloud-data-directory"] !== encodeURIComponent(directory)) {
      response.writeHead(409, { "content-type": "application/json" });
      response.end(JSON.stringify({ sessionId, directory }));
      return;
    }
    if (request.url === "/reset-organizer-key") {
      replyWithRotatedKey(
        response,
        { sessionId, directory },
        shutdown.signal.aborted ? undefined : rotateOrganizerKey,
      );
      return;
    }
    shutdown.abort();
    void exited.then((code) => {
      response.writeHead(code === 0 ? 200 : 500, { "content-type": "application/json" });
      response.end(JSON.stringify({ sessionId, directory, code, error: shutdownError }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    control.once("error", reject);
    control.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = control.address();
    if (!address || typeof address === "string") throw new Error("No local control address.");
    lock = acquireLocalLock(directory);
    claimSession(path, { protocol: 2, pid: process.pid, port: address.port, token, sessionId });
    exited = runLocalHost(args, {
      signal: shutdown.signal,
      stopLocalEnvironments: true,
      onReady: (host) => {
        rotateOrganizerKey = host.rotateOrganizerKey;
      },
    }).then(
      () => 0,
      (error: unknown) => {
        shutdownError = error instanceof Error ? error.message : "Local host shutdown failed.";
        console.error(shutdownError);
        return 1;
      },
    );
    return await exited;
  } finally {
    await new Promise<void>((resolve) => control.close(() => resolve()));
    if (lock) {
      try {
        releaseSession(path, sessionId);
      } finally {
        lock.close();
      }
    }
  }
}

export async function clearManagedLocal(root: string, args: string[]): Promise<void> {
  const options = parseLocalClearOptions(args, root);
  if (options.help) {
    console.log(
      'make local-clear LOCAL_ARGS="--data <directory> [--plan | --yes]" clears event history and owned Docker work data after confirmation. Stop the host first with make down. Organizer keys and settings are retained.',
    );
    return;
  }
  if (!lstatSync(options.directory, { throwIfNoEntry: false }))
    throw new Error("No existing local host state to clear.");
  const data = realpathSync(privateDirectory(options.directory));
  const session = readSession(join(data, SESSION_FILE));
  if (session && alive(session.pid))
    throw new Error(
      "The local host is running. Run make down with the same --data directory before clearing history.",
    );
  const lock = acquireLocalLock(data);
  try {
    assertExistingHostDatabase(join(data, "hosting.sqlite"));
    await clearLocalHistory(root, data, options);
  } finally {
    lock.close();
  }
}

if (import.meta.main) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === "start") process.exitCode = await runManagedLocal(root, args);
    else if (command === "down")
      await stopManagedLocal(
        // State-only operations never open hosting listeners, including inside the image.
        parseOptions(args, root, { ...process.env, TENKACLOUD_HOST_REQUIRE_PUBLIC: undefined })
          .dataDirectory,
      );
    else if (command === "clear") await clearManagedLocal(root, args);
    else if (command === "reset") {
      const options = parseOptions(args, root, {
        ...process.env,
        TENKACLOUD_HOST_REQUIRE_PUBLIC: undefined,
      });
      if (options.help) {
        console.log(
          'make local-reset LOCAL_ARGS="--data <directory>" rotates only the organizer key and revokes organizer sessions. Events, scores, participant keys and runtime data are retained. An interactive terminal is required to show the new key once.',
        );
      } else {
        // Obtain a private display before mutation: redirecting must not lose the new key.
        const display = openOrganizerKeyDisplay();
        try {
          display.show(await resetLocalOrganizerKey(options.dataDirectory));
          console.log(
            "Organizer key rotated; organizer sessions revoked. Event and participant data are retained.",
          );
        } finally {
          display.close();
        }
      }
    } else
      throw new Error(
        "Use make local, make down, make local-reset or make local-clear; pass options with LOCAL_ARGS.",
      );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
