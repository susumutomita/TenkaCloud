import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { type FileHandle, link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export type SimulatorReleaseAsset =
  `tenkacloud-simulator_${"linux" | "darwin"}_${"amd64" | "arm64"}`;
export interface SimulatorRelease {
  version: string;
  checksums: Record<SimulatorReleaseAsset, string>;
}
interface Dependencies {
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  platform?: string;
  arch?: string;
  maxBytes?: number;
  timeoutMs?: number;
}
const MAX_BYTES = 256 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const RELEASE_URL = "https://github.com/susumutomita/TenkaCloudSimulator/releases/download";

function assetFor(platform: string, arch: string): SimulatorReleaseAsset {
  if ((platform !== "linux" && platform !== "darwin") || (arch !== "x64" && arch !== "arm64"))
    throw new Error(
      "Simulator release binaries support only Linux/macOS on x64/arm64. Supply an explicit simulator binary for this platform.",
    );
  return `tenkacloud-simulator_${platform}_${arch === "x64" ? "amd64" : arch}`;
}
function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function privateCache(directory: string): Promise<void> {
  // Check every existing component before mkdir: recursive mkdir alone follows symlinks.
  const parent = dirname(directory);
  if (parent !== directory) await checkParents(parent);
  await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    throw new Error(
      "Simulator cache must be a private directory owned by the current user (mode 0700), without symlinks.",
    );
}
async function checkParents(directory: string): Promise<void> {
  const parent = dirname(directory);
  if (parent !== directory) await checkParents(parent);
  let stat: Stats;
  try {
    stat = await lstat(directory);
  } catch (error) {
    if (!missing(error)) throw error;
    await mkdir(directory, { mode: 0o700 });
    stat = await lstat(directory);
  }
  if (!stat.isDirectory())
    throw new Error("Simulator cache path must not contain symlinks or non-directories.");
  // Shared writable ancestors must have sticky-bit protection (e.g. /tmp).
  if ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)
    throw new Error("Simulator cache path contains an unsafe writable directory.");
}
async function verifyCached(path: string, checksum: string, maxBytes: number): Promise<boolean> {
  let stat: Stats;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o7777) !== 0o700 ||
    stat.size > maxBytes
  )
    throw new Error(
      "Unsafe simulator cache file. Remove it manually and retry; it will not be executed or replaced.",
    );
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat();
    if (opened.ino !== stat.ino || opened.dev !== stat.dev)
      throw new Error("Simulator cache changed during verification.");
    const hash = createHash("sha256");
    let bytes = 0;
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > maxBytes) throw new Error("Simulator cache exceeds the binary size limit.");
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (hash.digest("hex") !== checksum)
      throw new Error(
        "Simulator cache checksum mismatch. Remove the cached binary manually and retry; it will not be executed.",
      );
    return true;
  } finally {
    await file.close();
  }
}

async function releaseResponse(
  url: string,
  fetcher: (url: string, init: RequestInit) => Promise<Response>,
  signal: AbortSignal,
): Promise<Response> {
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetcher(url, { signal, redirect: "manual", credentials: "omit" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    await response.body?.cancel();
    const location = response.headers.get("location");
    if (!location) throw new Error("Simulator release returned an invalid redirect.");
    const target = new URL(location, url);
    if (
      target.protocol !== "https:" ||
      target.username ||
      target.password ||
      target.port ||
      ![
        "github.com",
        "release-assets.githubusercontent.com",
        "objects.githubusercontent.com",
      ].includes(target.hostname)
    )
      throw new Error("Simulator release redirected outside the trusted GitHub download hosts.");
    url = target.href;
  }
  throw new Error("Simulator release exceeded the redirect limit.");
}

/** Installs only the official, checksum-pinned release. Never builds source or executes downloads. */
export async function ensureSimulatorBinary(
  options: { cacheDirectory: string; release: SimulatorRelease; signal?: AbortSignal },
  dependencies: Dependencies = {},
): Promise<string> {
  const { release } = options;
  if (!/^v\d+\.\d+\.\d+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/.test(release.version))
    throw new Error("Simulator release must have a pinned semantic version tag.");
  const asset = assetFor(
    dependencies.platform ?? process.platform,
    dependencies.arch ?? process.arch,
  );
  const checksum = release.checksums[asset];
  if (!/^[a-f0-9]{64}$/.test(checksum ?? ""))
    throw new Error("Simulator release is missing a trusted SHA-256 checksum for this platform.");
  const maxBytes = dependencies.maxBytes ?? MAX_BYTES;
  const directory = resolve(options.cacheDirectory);
  await privateCache(directory);
  const destination = join(directory, `${release.version}-${asset}`);
  options.signal?.throwIfAborted();
  if (await verifyCached(destination, checksum, maxBytes)) return destination;
  return downloadBinary(options, dependencies, asset, checksum, directory, destination, maxBytes);
}

async function downloadBinary(
  options: { release: SimulatorRelease; signal?: AbortSignal },
  dependencies: Dependencies,
  asset: SimulatorReleaseAsset,
  checksum: string,
  directory: string,
  destination: string,
  maxBytes: number,
): Promise<string> {
  const { release } = options;
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(abort, dependencies.timeoutMs ?? DOWNLOAD_TIMEOUT_MS);
  const temporary = join(directory, `.download-${randomUUID()}`);
  let created = false;
  try {
    const response = await releaseResponse(
      `${RELEASE_URL}/${release.version}/${asset}`,
      dependencies.fetch ?? globalThis.fetch,
      controller.signal,
    );
    const body = await validatedBody(response, maxBytes);
    const file = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    await writeVerifiedBinary(file, body, checksum, maxBytes, controller.signal);
    // link is an atomic no-clobber publication; never overwrite an existing executable.
    try {
      await link(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await unlink(temporary);
    created = false;
    await verifyCached(destination, checksum, maxBytes);
    return destination;
  } catch (error) {
    if (controller.signal.aborted)
      throw new Error("Simulator download cancelled or timed out; retry when ready.");
    if (error instanceof Error && error.message.startsWith("Simulator")) throw error;
    throw new Error(
      "Simulator release download failed; check connectivity and cache permissions, then retry.",
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    if (created)
      await unlink(temporary).catch(() => {
        /* Preserve the original download error. */
      });
  }
}

async function validatedBody(
  response: Response,
  maxBytes: number,
): Promise<ReadableStream<Uint8Array>> {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(
      "Simulator release is unavailable. Check connectivity and that the pinned official release is published, or supply an explicit simulator binary.",
    );
  }
  const length = response.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    await response.body.cancel();
    throw new Error("Simulator release exceeds the binary size limit.");
  }
  return response.body;
}

async function writeVerifiedBinary(
  file: FileHandle,
  body: ReadableStream<Uint8Array>,
  checksum: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const hash = createHash("sha256");
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("Simulator release exceeds the binary size limit.");
      hash.update(value);
      await file.writeFile(value);
    }
    signal.throwIfAborted();
    if (size === 0 || hash.digest("hex") !== checksum)
      throw new Error("Simulator release checksum mismatch; download discarded.");
    await file.sync();
    await file.chmod(0o700);
  } finally {
    await reader.cancel().catch(() => {
      /* Preserve the original download error. */
    });
    reader.releaseLock();
    await file.close();
  }
}
