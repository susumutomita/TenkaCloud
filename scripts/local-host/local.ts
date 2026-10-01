import { Database } from "bun:sqlite";
import { lstatSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { randomToken, sameSecret } from "./auth";
import { prepareDatabase, privateDirectory } from "./files";
import { runLocalHost } from "./main";
import { parseOptions } from "./options";

const sessionSchema = z.object({
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
    if (alive(prior.pid))
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
  const path = join(privateDirectory(directory), SESSION_FILE);
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
  // Never signal a PID read from a file: it may now belong to an unrelated process.
  const response = await fetch(`http://127.0.0.1:${String(session.port)}/down`, {
    method: "POST",
    headers: { authorization: `Bearer ${session.token}` },
    signal: AbortSignal.timeout(60_000),
  });
  const result: unknown = await response.json();
  const parsed = z.object({ sessionId: z.string(), code: z.number() }).safeParse(result);
  if (!parsed.success || !sameSecret(parsed.data.sessionId, session.sessionId))
    throw new Error(
      "The shutdown endpoint does not belong to this local host; no PID was signalled.",
    );
  if (!response.ok || parsed.data.code !== 0)
    throw new Error(
      "Local shutdown reported a failure. Read the local terminal; retained data was not reset.",
    );
  console.log("Local host stopped. Event data and stopped Docker runtime data are retained.");
}

export async function runManagedLocal(root: string, args: string[]): Promise<number> {
  const options = parseOptions(args, root);
  if (options.help) {
    await runLocalHost(args);
    return 0;
  }
  process.umask(0o077);
  const directory = privateDirectory(options.dataDirectory);
  const path = join(directory, SESSION_FILE);
  const token = randomToken();
  const sessionId = randomToken();
  const shutdown = new AbortController();
  let lock: Database | undefined;
  let exited: Promise<number> = Promise.resolve(1);
  const control = createServer((request, response) => {
    if (
      request.method !== "POST" ||
      request.url !== "/down" ||
      !sameSecret(request.headers.authorization ?? "", `Bearer ${token}`)
    ) {
      response.writeHead(403).end();
      return;
    }
    shutdown.abort();
    void exited.then((code) => {
      response.writeHead(code === 0 ? 200 : 500, { "content-type": "application/json" });
      response.end(JSON.stringify({ sessionId, code }));
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
    claimSession(path, { pid: process.pid, port: address.port, token, sessionId });
    exited = runLocalHost(args, {
      signal: shutdown.signal,
      stopLocalEnvironments: true,
    }).then(
      () => 0,
      (error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
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

if (import.meta.main) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === "start") process.exitCode = await runManagedLocal(root, args);
    else if (command === "down") await stopManagedLocal(parseOptions(args, root).dataDirectory);
    else throw new Error("Use make local or make down; pass runtime options with LOCAL_ARGS.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
