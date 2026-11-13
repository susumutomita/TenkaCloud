import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, normalize } from "node:path";

export interface OwnedSimulatorLaunchOptions {
  readonly binarySha256: string;
  readonly runtimeConfigPath: string;
  readonly runtimeConfigSha256: string;
}
function canonical(path: string): void {
  if (!isAbsolute(path) || normalize(path) !== path || realpathSync(path) !== path)
    throw new Error("Canonical nonsymlink absolute launch path required.");
}
function openOwned(path: string, executable: boolean): number {
  canonical(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    const prohibited = executable ? 0o022 : 0o077;
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      stat.nlink !== 1 ||
      (stat.mode & prohibited) !== 0 ||
      (executable && (stat.mode & 0o100) === 0)
    )
      throw new Error("Owned safe regular launch file required.");
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
function pinnedBytes(fd: number, expected: string, limit: number): Buffer {
  if (!/^[a-f0-9]{64}$/u.test(expected)) throw new Error("Invalid launch SHA256 pin.");
  const stat = fstatSync(fd);
  if (stat.size < 1 || stat.size > limit) throw new Error("Launch file size outside bounds.");
  const bytes = Buffer.alloc(stat.size);
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
    if (!count) throw new Error("Launch file changed during read.");
    offset += count;
  }
  const after = fstatSync(fd);
  if (
    after.size !== stat.size ||
    after.mtimeMs !== stat.mtimeMs ||
    after.ctimeMs !== stat.ctimeMs ||
    createHash("sha256").update(bytes).digest("hex") !== expected
  )
    throw new Error("Launch file pin mismatch or changed during read.");
  return bytes;
}
/** Same-user trusted boundary: pins opened binary bytes and snapshots private configuration. */
export function prepareOwnedSimulatorFiles(
  binary: string,
  battle: OwnedSimulatorLaunchOptions,
  ownedStateDirectory: string,
) {
  canonical(ownedStateDirectory);
  const state = lstatSync(ownedStateDirectory);
  if (!state.isDirectory() || state.uid !== process.getuid?.() || (state.mode & 0o077) !== 0)
    throw new Error("Owned private launch directory required.");
  let fd: number | undefined = openOwned(binary, true);
  let snapshot: string | undefined;
  const closeDescriptor = () => {
    if (fd === undefined) return;
    const closing = fd;
    fd = undefined;
    closeSync(closing);
  };
  const dispose = () => {
    try {
      closeDescriptor();
    } finally {
      if (snapshot !== undefined) {
        const owned = snapshot;
        snapshot = undefined;
        unlinkSync(owned);
      }
    }
  };
  try {
    pinnedBytes(fd, battle.binarySha256, 256 * 1024 * 1024);
    const config = openOwned(battle.runtimeConfigPath, false);
    let bytes: Buffer;
    try {
      bytes = pinnedBytes(config, battle.runtimeConfigSha256, 65536);
    } finally {
      closeSync(config);
    }
    const path = join(ownedStateDirectory, `battle-runtime-${randomUUID()}.json`);
    // Mark owned only after exclusive creation; never remove a pre-existing path on failure.
    const output = openSync(path, "wx", 0o400);
    snapshot = path;
    try {
      writeFileSync(output, bytes);
    } finally {
      closeSync(output);
    }
    return {
      configPath: path,
      fd,
      closeDescriptor,
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

/** Platform admission remains separate from portable file validation; this is not a Mac launcher. */
export function prepareOwnedSimulatorLaunch(
  binary: string,
  battle: OwnedSimulatorLaunchOptions,
  ownedStateDirectory: string,
) {
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error("Owned Battle launch requires Linux amd64.");
  const files = prepareOwnedSimulatorFiles(binary, battle, ownedStateDirectory);
  return {
    fd: files.fd,
    closeDescriptor: files.closeDescriptor,
    dispose: files.dispose,
    command: "/proc/self/fd/4",
    args: [`--battle-runtime-config=${files.configPath}`, "--battle-clock-proof-fd=3"],
  };
}
