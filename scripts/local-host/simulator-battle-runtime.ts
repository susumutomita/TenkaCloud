import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";

/**
 * Same-machine Battle VM runtime for the managed Simulator.
 *
 * The bundle is built on this machine by TenkaCloudSimulator's
 * `test/battle/image/build_bundle.py` (pinned QEMU, firmware and prepared Amazon Linux disk). The
 * host writes the Simulator's private runtime configuration next to its state and gives the guests
 * a short private directory: guest control sockets live below it and Unix socket paths are limited
 * to 103 bytes on macOS (107 on Linux).
 *
 * The clock domain is this machine's wall clock, which both this host (probe deadlines) and the
 * Simulator (protocol 1) read. A wall-clock step can make one probe miss its deadline; that probe
 * is reported as an error and retried, never scored.
 */
export interface BattleRuntime {
  readonly configPath: string;
  readonly runtimeDirectory: string;
}

const EMULATOR = "bin/qemu-system-x86_64";
const FIRMWARE = "firmware/bios-256k.bin";
const BASE_DISK = "images/al2023-battle.qcow2";
/** Template AMI aliases resolve to this local image (an alias, not a download request). */
const IMAGE_ID = "ami-0a1b2c3d4e5f60718";
const CLOCK_DOMAIN = "tenkacloud-host-wallclock-1";
/** The Simulator bounds a runtime to 24 hours from its startup. */
const LIFETIME_MS = 23 * 60 * 60_000;
/** Room for `/guest-<10 digits>/session.sock` below the runtime directory on macOS. */
const MAX_RUNTIME_DIRECTORY = 70;
const MAX_MANIFEST_BYTES = 1024 * 1024;

const manifestSchema = z.object({
  os: z.string(),
  arch: z.string(),
  archiveSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  files: z
    .array(
      z.object({
        path: z.string(),
        size: z.number().int().nonnegative(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/u),
        executable: z.boolean().optional(),
      }),
    )
    .min(3),
});

const bundleError = (path: string) =>
  `The Battle bundle at ${path} must be a directory holding manifest.json and guest-bundle.tar.gz from TenkaCloudSimulator test/battle/image/build_bundle.py, built on this machine.`;

function hostPlatform(): { os: string; arch: string } {
  const arch = { x64: "amd64", arm64: "arm64" }[process.arch as "x64" | "arm64"];
  if ((process.platform !== "linux" && process.platform !== "darwin") || !arch)
    throw new Error(
      "The Battle VM runtime runs on Linux or macOS (amd64 or arm64); on Windows use WSL2.",
    );
  return { os: process.platform, arch };
}

function regularFile(path: string, bundle: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new Error(bundleError(bundle));
}

function readBounded(path: string, bundle: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const size = fstatSync(fd).size;
    if (size > MAX_MANIFEST_BYTES) throw new Error(bundleError(bundle));
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const read = readSync(fd, buffer, offset, size - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return buffer.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}

/** Validate the bundle, then write a fresh private runtime configuration and directory. */
export function prepareBattleRuntime(
  bundleDirectory: string,
  simulatorDirectory: string,
  now: () => number = Date.now,
  temporaryRoot = "/tmp",
): BattleRuntime {
  const platform = hostPlatform();
  const bundle = resolve(bundleDirectory);
  if (!lstatSync(bundle, { throwIfNoEntry: false }))
    throw new Error(`Battle bundle not found: ${bundle}`);
  const manifestPath = join(bundle, "manifest.json");
  const archivePath = join(bundle, "guest-bundle.tar.gz");
  regularFile(manifestPath, bundle);
  regularFile(archivePath, bundle);
  const raw = readBounded(manifestPath, bundle);
  let manifest: z.infer<typeof manifestSchema>;
  try {
    manifest = manifestSchema.parse(JSON.parse(raw.toString("utf8")));
  } catch {
    throw new Error(bundleError(bundle));
  }
  if (manifest.os !== platform.os || manifest.arch !== platform.arch)
    throw new Error(
      `This Battle bundle was built for ${manifest.os}/${manifest.arch}, not this ${platform.os}/${platform.arch} machine. Build it here with build_bundle.py.`,
    );
  const file = (path: string) => manifest.files.find((entry) => entry.path === path);
  const disk = file(BASE_DISK);
  if (!file(EMULATOR)?.executable || !file(FIRMWARE) || !disk || disk.executable)
    throw new Error(bundleError(bundle));

  // A short, private, non-symlinked directory (macOS /tmp is a symlink to /private/tmp).
  const runtimeDirectory = mkdtempSync(join(realpathSync(temporaryRoot), "tcb-"));
  if (runtimeDirectory.length > MAX_RUNTIME_DIRECTORY) {
    rmSync(runtimeDirectory, { recursive: true, force: true });
    throw new Error("The temporary directory path is too long for guest control sockets.");
  }
  const started = now();
  const lifetimeUntilMs = started + LIFETIME_MS;
  const config = {
    bundleManifest: manifestPath,
    bundleArchive: archivePath,
    manifestSha256: createHash("sha256").update(raw).digest("hex"),
    sessionImageSha256: disk.sha256,
    runtimeDirectory,
    layout: { emulator: EMULATOR, firmware: FIRMWARE, baseDisk: BASE_DISK },
    imageIds: [IMAGE_ID],
    lifetimeUntilMs,
    clock: { domain: CLOCK_DOMAIN, validFromMs: started - 1000, validUntilMs: lifetimeUntilMs },
  };
  const configPath = join(simulatorDirectory, "battle-runtime.json");
  // Replace only a previous private regular file; never follow or overwrite a link.
  const existing = lstatSync(configPath, { throwIfNoEntry: false });
  if (existing && !existing.isFile()) {
    rmSync(runtimeDirectory, { recursive: true, force: true });
    throw new Error("The Battle runtime configuration path is not a regular file.");
  }
  if (existing) unlinkSync(configPath);
  writeFileSync(configPath, `${JSON.stringify(config, null, 1)}\n`, { flag: "wx", mode: 0o600 });
  return { configPath, runtimeDirectory };
}

/**
 * The Simulator keeps each guest's disk copy until it exits. Remove the directory only after a
 * clean exit; otherwise the Simulator could not confirm cleanup and the files are evidence.
 */
export function releaseBattleRuntime(runtime: BattleRuntime, exitCode: number | null): void {
  if (exitCode === 0) {
    rmSync(runtime.runtimeDirectory, { recursive: true, force: true });
    return;
  }
  console.warn(
    `Simulator Battle runtime files were kept at ${runtime.runtimeDirectory} because the Simulator did not exit cleanly. Remove them after checking that no qemu-system-x86_64 process remains.`,
  );
}
