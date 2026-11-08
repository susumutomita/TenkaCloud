import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, rename, rmdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  ensureSimulatorBinary,
  prepareSimulatorCache,
  simulatorReleaseResponse,
} from "./simulator-release";
import { consumeSimulatorStream } from "./simulator-release-stream";

const REPOSITORY = "https://github.com/susumutomita/TenkaCloudSimulator";
const RELEASES =
  "https://api.github.com/repos/susumutomita/TenkaCloudSimulator/releases?per_page=100";
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const version = z.string().regex(/^v(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})$/u);
const lockSchema = z
  .object({
    schemaVersion: z.literal(1),
    hostProtocol: z.literal(1),
    version,
    buildInfoSha256: digest,
    checksums: z
      .object({
        "tenkacloud-simulator_linux_amd64": digest,
        "tenkacloud-simulator_linux_arm64": digest,
        "tenkacloud-simulator_darwin_amd64": digest,
        "tenkacloud-simulator_darwin_arm64": digest,
      })
      .strict(),
  })
  .strict();
type ReleaseLock = z.infer<typeof lockSchema>;
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
interface Dependencies {
  fetch?: Fetcher;
  platform?: string;
  arch?: string;
  timeoutMs?: number;
}
interface Options {
  cacheDirectory: string;
  update?: boolean;
  signal?: AbortSignal;
}

function absent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
function compareVersions(a: string, b: string): number {
  const left = a.slice(1).split(".").map(Number);
  const right = b.slice(1).split(".").map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return (left[i] ?? 0) - (right[i] ?? 0);
  return 0;
}

/** Publisher checksums establish consistency, not independent protection against publisher compromise. */
export async function ensureOfficialSimulatorBinary(
  options: Options,
  dependencies: Dependencies = {},
): Promise<string> {
  options.signal?.throwIfAborted();
  const directory = resolve(options.cacheDirectory);
  await prepareSimulatorCache(directory);
  const mutex = join(directory, ".release-operation");
  try {
    await mkdir(mutex, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        "Simulator release operation is already active. If a previous process was interrupted, confirm it has stopped before removing simulator-binaries/.release-operation and retrying.",
      );
    throw error;
  }
  try {
    return await useLockedRelease({ ...options, cacheDirectory: directory }, dependencies);
  } finally {
    await rmdir(mutex);
  }
}

async function useLockedRelease(options: Options, dependencies: Dependencies): Promise<string> {
  const path = join(options.cacheDirectory, "release-lock.json");
  const current = await readLock(path);
  const selected =
    current && !options.update ? current : await resolveRelease(options.signal, dependencies);
  if (current && options.update) assertUpdate(current, selected);
  options.signal?.throwIfAborted();
  const binary = await ensureSimulatorBinary(
    { cacheDirectory: options.cacheDirectory, release: selected, signal: options.signal },
    dependencies,
  );
  options.signal?.throwIfAborted();
  if (!current || options.update) await writeLock(path, selected, Boolean(current));
  console.log(
    `Simulator ${selected.version}: verified local release lock${options.update ? " updated" : ""}.`,
  );
  return binary;
}

function assertUpdate(current: ReleaseLock, selected: ReleaseLock): void {
  if (compareVersions(selected.version, current.version) < 0)
    throw new Error(
      "Simulator update would downgrade the locked release; the existing lock was retained.",
    );
  if (current.version === selected.version && JSON.stringify(current) !== JSON.stringify(selected))
    throw new Error(
      "Simulator release contents changed for the same version; the existing lock was retained. Use a new immutable release version.",
    );
}

async function readLock(path: string): Promise<ReleaseLock | undefined> {
  let entry: Stats;
  try {
    entry = await lstat(path);
  } catch (error) {
    if (absent(error)) return undefined;
    throw error;
  }
  if (
    !entry.isFile() ||
    entry.nlink !== 1 ||
    entry.uid !== process.getuid?.() ||
    (entry.mode & 0o7777) !== 0o600 ||
    entry.size > 16_384
  )
    throw new Error(
      "Unsafe Simulator release lock: use an owner-only regular file without links; it will not be overwritten.",
    );
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await file.stat();
    if (opened.ino !== entry.ino || opened.dev !== entry.dev)
      throw new Error("Simulator release lock changed during verification.");
    const bytes = Buffer.alloc(16_385);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 16_384) throw new Error("Simulator release lock is invalid or oversized.");
    const parsed = lockSchema.safeParse(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")));
    if (!parsed.success) throw new Error("Simulator release lock is invalid; it was not changed.");
    return parsed.data;
  } catch {
    throw new Error("Simulator release lock is invalid; it was not changed.");
  } finally {
    await file.close();
  }
}

async function writeLock(path: string, selected: ReleaseLock, replace: boolean): Promise<void> {
  const temporary = `${path}.lock-${randomUUID()}`;
  const file = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(`${JSON.stringify(selected, null, 2)}\n`);
    await file.sync();
    await file.close();
    if (replace) await rename(temporary, path);
    else await link(temporary, path);
  } finally {
    await file.close();
    await unlink(temporary).catch((error) => {
      if (!absent(error)) throw error;
    });
  }
}

async function resolveRelease(
  parent: AbortSignal | undefined,
  dependencies: Dependencies,
): Promise<ReleaseLock> {
  const timeout = AbortSignal.timeout(dependencies.timeoutMs ?? 120_000);
  const signal = parent ? AbortSignal.any([parent, timeout]) : timeout;
  try {
    const fetcher = dependencies.fetch ?? globalThis.fetch;
    const raw = parseMetadata(await metadata(RELEASES, fetcher, signal, 2 * 1024 * 1024));
    const releaseList = z
      .array(z.object({ tag_name: z.string(), draft: z.boolean(), prerelease: z.boolean() }))
      .max(100)
      .safeParse(raw);
    if (!releaseList.success)
      throw new Error("Simulator release list is invalid; no lock was changed.");
    const releases = releaseList.data;
    const versions = [
      ...new Set(
        releases
          .filter(
            (release) =>
              !release.draft && !release.prerelease && version.safeParse(release.tag_name).success,
          )
          .map((release) => release.tag_name),
      ),
    ]
      .sort(compareVersions)
      .reverse();
    for (const candidate of versions) {
      const release = await resolveCandidate(candidate, fetcher, signal);
      if (release) return release;
    }
    throw new Error(
      "No compatible official Simulator release is published among the newest 100 releases. Retry after publication or use --simulator-binary / --no-simulator. No source build or AWS fallback was attempted.",
    );
  } catch (error) {
    if (signal.aborted)
      throw new Error(
        "Simulator release resolution cancelled or timed out; the existing lock was retained.",
      );
    if (
      (error instanceof Error && error.message.startsWith("Simulator")) ||
      (error instanceof Error && error.message.startsWith("No compatible"))
    )
      throw error;
    throw new Error(
      "Simulator release resolution failed; check connectivity and GitHub availability. Existing locked bytes were not changed. Offline first use and explicit updates need network access.",
    );
  }
}

async function resolveCandidate(
  tag: string,
  fetcher: Fetcher,
  signal: AbortSignal,
): Promise<ReleaseLock | undefined> {
  const base = `${REPOSITORY}/releases/download/${tag}`;
  const sums = await metadata(`${base}/SHA256SUMS`, fetcher, signal, 65_536, true);
  if (sums === "") return undefined;
  const checksums: Record<string, string> = {};
  for (const line of sums.trimEnd().split("\n")) {
    const match = /^([a-f0-9]{64}) {2}([A-Za-z0-9._-]+)$/u.exec(line);
    const name = match?.[2];
    const checksum = match?.[1];
    if (!name || !checksum || Object.hasOwn(checksums, name))
      throw new Error("Simulator release checksum manifest is invalid or duplicated.");
    checksums[name] = checksum;
  }
  const build = await metadata(`${base}/BUILDINFO.json`, fetcher, signal, 65_536);
  if (createHash("sha256").update(build).digest("hex") !== checksums["BUILDINFO.json"])
    throw new Error("Simulator BUILDINFO checksum mismatch; release rejected.");
  const info = z
    .object({
      version: z.literal(tag),
      host_protocol: z.number().int().optional(),
      source_repository: z.literal(REPOSITORY),
      source_commit: z.string().regex(/^[a-f0-9]{40}$/u),
    })
    .safeParse(parseMetadata(build));
  if (!info.success) throw new Error("Simulator BUILDINFO metadata is invalid; release rejected.");
  if (info.data.host_protocol !== 1) return undefined;
  const { "BUILDINFO.json": buildInfoSha256, ...binaries } = checksums;
  const parsed = lockSchema.safeParse({
    schemaVersion: 1,
    hostProtocol: 1,
    version: tag,
    buildInfoSha256,
    checksums: binaries,
  });
  if (!parsed.success)
    throw new Error("Simulator release checksum manifest does not match supported assets.");
  return parsed.data;
}

async function metadata(
  url: string,
  fetcher: Fetcher,
  signal: AbortSignal,
  limit: number,
  missingAllowed = false,
): Promise<string> {
  const response = await simulatorReleaseResponse(url, fetcher, signal);
  if (missingAllowed && response.status === 404) {
    await response.body?.cancel();
    return "";
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(
      "Simulator release metadata unavailable; check connectivity or GitHub rate limits. The existing lock was retained.",
    );
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  await consumeSimulatorStream(response.body, signal, (value) => {
    size += value.byteLength;
    if (size > limit) throw new Error("Simulator release metadata exceeds the size limit.");
    chunks.push(value);
  });
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

function parseMetadata(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Simulator release metadata is invalid JSON; no lock was changed.");
  }
}
