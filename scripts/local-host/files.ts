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
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import { secret } from "./auth";

function assertOwner(uid: number): void {
  if (process.getuid && process.getuid() !== uid) throw new Error("Local-host files must belong to the current user.");
}

export function privateDirectory(path: string): string {
  const absolute = resolve(path);
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  const stat = lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Local-host state directory must not be a symlink.");
  assertOwner(stat.uid);
  const descriptor = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fchmodSync(descriptor, 0o700);
  } finally {
    closeSync(descriptor);
  }
  return absolute;
}

function openPrivate(path: string, flags: number): number {
  const descriptor = openSync(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("Expected a regular private file, not a link.");
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
    const value = created ? secret() : readFileSync(descriptor, "utf8").trim();
    if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) throw new Error("Invalid host-key file; refusing to replace it.");
    if (created) {
      writeFileSync(descriptor, `${value}\n`);
      fsyncSync(descriptor);
    }
    return value;
  } finally {
    closeSync(descriptor);
  }
}
