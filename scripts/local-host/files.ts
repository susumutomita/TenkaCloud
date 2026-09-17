import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { randomToken } from "./auth";

function assertOwner(uid: number): void {
  if (process.getuid && process.getuid() !== uid)
    throw new Error("Local-host files must belong to the current user.");
}

/**
 * Create the private state directory, or accept an existing one only when it is already
 * private. The mode of an existing directory is never changed: `--data` may point at any
 * directory the organizer owns, and silently applying 0700 to a shared project directory or a
 * home directory would lock other users and services out of unrelated files.
 */
export function privateDirectory(path: string): string {
  const absolute = resolve(path);
  let created = false;
  try {
    mkdirSync(absolute, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
      mkdirSync(absolute, { recursive: true, mode: 0o700 });
      created = true;
    }
  }
  const stat = lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Local-host state directory must not be a symlink.");
  assertOwner(stat.uid);
  if (created) {
    // Our own fresh directory: pin the mode regardless of the process umask.
    const descriptor = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      fchmodSync(descriptor, 0o700);
    } finally {
      closeSync(descriptor);
    }
  } else if ((stat.mode & 0o077) !== 0) {
    throw new Error(
      `Refusing to use ${absolute}: it is readable by other users. Run chmod 700 on it, or pass a dedicated --data directory.`,
    );
  }
  return absolute;
}

function openPrivate(path: string, flags: number): number {
  const descriptor = openSync(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1)
      throw new Error("Expected a regular private file, not a link.");
    assertOwner(stat.uid);
    fchmodSync(descriptor, 0o600);
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

export function prepareDatabase(path: string): void {
  closeSync(openPrivate(path, constants.O_RDWR | constants.O_CREAT));
}

export function persistentKey(path: string): string {
  let created = false;
  let descriptor: number;
  try {
    descriptor = openPrivate(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL);
    created = true;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    descriptor = openPrivate(path, constants.O_RDONLY);
  }
  try {
    const value = created ? randomToken() : readFileSync(descriptor, "utf8").trim();
    if (!/^[A-Za-z0-9_-]{43}$/u.test(value))
      throw new Error("Invalid host-key file; refusing to replace it.");
    if (created) {
      writeFileSync(descriptor, `${value}\n`);
      fsyncSync(descriptor);
    }
    return value;
  } finally {
    closeSync(descriptor);
  }
}
