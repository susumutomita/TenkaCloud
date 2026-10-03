import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { PROBLEM_SECRET_FILE } from "./container/problem-secrets";
import { privateDirectory } from "./files";

const OWNER_FILE = ".tenkacloud-runtime-owner";

function owner(jobId: string): string {
  return `tenkacloud-runtime-v1:${jobId}\n`;
}

/** A job ID is a path segment, never an arbitrary relative or absolute path. */
function directoryPath(dataDirectory: string, jobId: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(jobId)) throw new Error("Unsafe runtime job ID.");
  privateDirectory(dataDirectory);
  const parent = privateDirectory(join(dataDirectory, "runtimes"));
  return join(parent, jobId);
}

/** Only a directory created by this call gets a deletion ownership marker. */
export function prepareRuntimeDirectory(
  dataDirectory: string,
  jobId: string,
  claimNew: boolean,
): string {
  const directory = directoryPath(dataDirectory, jobId);
  const existed = existsSync(directory);
  privateDirectory(directory);
  if (claimNew && !existed)
    writeFileSync(join(directory, OWNER_FILE), owner(jobId), { flag: "wx", mode: 0o600 });
  return directory;
}

function regularOwnedFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid()))
    throw new Error("Refusing to remove an unsafe runtime file.");
}

/**
 * Called only after the exact owned Compose project has been physically torn down.
 * A normal pause/down never calls this. No recursive deletion or legacy-directory adoption.
 */
export function removeRuntimeFiles(
  dataDirectory: string,
  jobId: string,
  composePath: string,
): void {
  const directory = privateDirectory(directoryPath(dataDirectory, jobId));
  const expected = join(directory, `tch-${jobId.toLowerCase()}.compose.yml`);
  if (resolve(composePath) !== expected) throw new Error("Runtime cleanup path mismatch.");
  const marker = join(directory, OWNER_FILE);
  if (!lstatSync(marker, { throwIfNoEntry: false })) {
    // Old jobs have durable Compose ownership, but no ownership of the rest of this directory.
    regularOwnedFile(expected);
    unlinkSync(expected);
    return;
  }
  regularOwnedFile(marker);
  if (readFileSync(marker, "utf8") !== owner(jobId))
    throw new Error("Runtime directory ownership changed; refusing cleanup.");
  const allowed = new Set([basename(expected), PROBLEM_SECRET_FILE, OWNER_FILE]);
  const files = readdirSync(directory);
  for (const name of files) {
    if (!allowed.has(name)) throw new Error("Runtime contains unknown files; refusing cleanup.");
    regularOwnedFile(join(directory, name));
  }
  // Keep the marker until every known payload has gone, so a failed unlink stays retryable.
  for (const name of files.filter((name) => name !== OWNER_FILE)) unlinkSync(join(directory, name));
  unlinkSync(marker);
  rmdirSync(directory);
}
