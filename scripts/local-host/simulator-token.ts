import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

export const TOKEN_FORMAT_ERROR =
  "Simulator input must contain a valid local operator token (32-256 URL-safe characters, optionally followed by one newline in a file). Do not paste its contents into logs.";

class SimulatorTokenFileError extends Error {}

function tokenFileReadError(error: unknown): Error {
  if (error instanceof SimulatorTokenFileError) return error;
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  if (code === "ENOENT" || code === "ENOTDIR")
    return new Error(
      "Simulator token file was not found. --simulator-token-file is relative to the host working directory, not the Simulator checkout. Start the Simulator, then pass the absolute path to its existing simulator-token file. No token was created or changed.",
    );
  if (code === "EACCES" || code === "EPERM")
    return new Error(
      "Simulator token file is not readable by this user. Use the private file owned by the user running both the Simulator and host; do not make it public or run the host with sudo.",
    );
  return new Error(
    "Simulator token file must be a readable, owner-only regular file owned by this user containing a valid local operator token; symlinks are not accepted.",
  );
}

/** Bound the read and reject symlinks, devices, shared files and another user's credentials. */
export function readSimulatorToken(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile())
      throw new SimulatorTokenFileError("Simulator token file must be a regular file.");
    if (stat.nlink !== 1 || (stat.mode & 0o077) !== 0)
      throw new SimulatorTokenFileError(
        "Simulator token file must be owner-only (for example mode 0600), with no hard links. Check the existing Simulator file's metadata; do not copy or recreate its token.",
      );
    if (stat.uid !== process.getuid?.())
      throw new SimulatorTokenFileError(
        "Simulator token file must be owned by this user. Run the Simulator and host as the same user, without sudo.",
      );
    if (stat.size > 257) throw new SimulatorTokenFileError(TOKEN_FORMAT_ERROR);
    const buffer = Buffer.alloc(258);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    const token = buffer.subarray(0, size).toString("utf8").replace(/\n$/u, "");
    if (!/^[A-Za-z0-9_-]{32,256}$/u.test(token))
      throw new SimulatorTokenFileError(TOKEN_FORMAT_ERROR);
    return token;
  } catch (error) {
    throw tokenFileReadError(error);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
