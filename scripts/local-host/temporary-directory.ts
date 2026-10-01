import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { privateDirectory } from "./files";

const OWNER_FILE = ".tenkacloud-temporary-owner.json";
const PROCESS_SESSION = randomUUID();
const ownerSchema = z.object({
  kind: z.literal("tenkacloud-temporary-v1"),
  root: z.string(),
  name: z.string(),
  pid: z.number().int().positive(),
  session: z.string().uuid(),
  createdAt: z.number().int().nonnegative(),
});

/** A single private location for disposable work; event state never belongs here. */
function temporaryRoot(repositoryRoot: string): string {
  const root = realpathSync(repositoryRoot);
  const local = join(root, ".tenkacloud");
  mkdirSync(local, { recursive: true, mode: 0o700 });
  const stat = lstatSync(local);
  if (
    !stat.isDirectory() ||
    (stat.mode & 0o022) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error("Unsafe local generated-file directory.");
  const cache = privateDirectory(join(local, "cache"));
  return privateDirectory(join(cache, "tmp"));
}

export function createTemporaryDirectory(repositoryRoot: string, prefix: string): string {
  if (!/^[a-z0-9][a-z0-9-]*-$/u.test(prefix)) throw new Error("Unsafe temporary directory prefix.");
  const root = temporaryRoot(repositoryRoot);
  const directory = mkdtempSync(join(root, prefix));
  writeFileSync(
    join(directory, OWNER_FILE),
    `${JSON.stringify({
      kind: "tenkacloud-temporary-v1",
      root,
      name: basename(directory),
      pid: process.pid,
      session: PROCESS_SESSION,
      createdAt: Date.now(),
    })}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return directory;
}

function readOwner(root: string, directory: string) {
  if (dirname(resolve(directory)) !== root)
    throw new Error("Temporary cleanup path is outside its root.");
  privateDirectory(directory);
  const descriptor = openSync(
    join(directory, OWNER_FILE),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > 2048 ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error("Unsafe temporary ownership marker.");
    const owner = ownerSchema.parse(JSON.parse(readFileSync(descriptor, "utf8")));
    if (owner.root !== root || owner.name !== basename(directory))
      throw new Error("Temporary directory ownership mismatch.");
    return owner;
  } finally {
    closeSync(descriptor);
  }
}

function assertDisposableTree(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const stat = lstatSync(path);
    if (
      stat.isSymbolicLink() ||
      (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error("Unsafe file in temporary directory; refusing cleanup.");
    if (stat.isDirectory()) assertDisposableTree(path);
  }
}

/** Call only after this run's listeners, children and owned external resources are closed. */
export function removeTemporaryDirectory(repositoryRoot: string, directory: string): void {
  const root = temporaryRoot(repositoryRoot);
  if (dirname(resolve(directory)) !== root)
    throw new Error("Temporary cleanup path is outside its root.");
  if (!lstatSync(directory, { throwIfNoEntry: false })) return;
  const owner = readOwner(root, directory);
  if (owner.pid !== process.pid || owner.session !== PROCESS_SESSION)
    throw new Error("Temporary directory belongs to another process.");
  assertDisposableTree(directory);
  rmSync(directory, { recursive: true });
}

/** Inventory only: age/dead PID alone never proves a retained runtime can be deleted. */
export function inspectTemporaryDirectories(repositoryRoot: string): {
  directory: string;
  owned: boolean;
  ownerRunning?: boolean;
  ownerPid?: number;
  createdAt?: number;
}[] {
  const root = temporaryRoot(repositoryRoot);
  return readdirSync(root).map((name) => {
    const directory = join(root, name);
    try {
      const owner = readOwner(root, directory);
      let ownerRunning = true;
      try {
        process.kill(owner.pid, 0);
      } catch (error) {
        ownerRunning = !(error instanceof Error && "code" in error && error.code === "ESRCH");
      }
      return {
        directory,
        owned: true,
        ownerRunning,
        ownerPid: owner.pid,
        createdAt: owner.createdAt,
      };
    } catch {
      return { directory, owned: false };
    }
  });
}
