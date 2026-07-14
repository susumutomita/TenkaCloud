import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import type { ProcessResult, ProcessRunner } from "./process";

const TURSO_CLI_VERSION = "1.0.29";
const RELEASE_BASE_URL = "https://github.com/tursodatabase/turso-cli/releases/download";

export interface TursoCliRelease {
  readonly version: string;
  readonly archive: string;
  readonly checksum: string;
}

const RELEASES: Readonly<Record<string, TursoCliRelease>> = {
  "darwin-arm64": {
    version: TURSO_CLI_VERSION,
    archive: "turso-cli_Darwin_arm64.tar.gz",
    checksum: "0fa9d1666101661c267d4959654ed865100f3fcceefb22290de7f0355ce1869c",
  },
  "darwin-x64": {
    version: TURSO_CLI_VERSION,
    archive: "turso-cli_Darwin_x86_64.tar.gz",
    checksum: "0a749e0f0c2186aa02aaaf19c67c0c84e412445b64f44130a7018727ca243878",
  },
  "linux-arm64": {
    version: TURSO_CLI_VERSION,
    archive: "turso-cli_Linux_arm64.tar.gz",
    checksum: "f94fafc61a093f97a609e3ff65313734f2abf3659eed43e4872c52ba3fb82bc5",
  },
  "linux-x64": {
    version: TURSO_CLI_VERSION,
    archive: "turso-cli_Linux_x86_64.tar.gz",
    checksum: "0eae140b030b11ad98540ed85ceb62575100135e51038009064e50675822c0f5",
  },
};

export interface InstallTursoCliOptions {
  readonly architecture: NodeJS.Architecture;
  readonly calculateChecksum?: (path: string) => string;
  readonly homeDirectory: string;
  readonly platform: NodeJS.Platform;
  readonly processRunner: ProcessRunner;
}

export function tursoCliRelease(
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
): TursoCliRelease {
  const release = RELEASES[`${platform}-${architecture}`];
  if (!release) {
    throw new Error(`Unsupported Turso CLI platform: ${platform}/${architecture}`);
  }
  return release;
}

function resultDetail(result: ProcessResult): string {
  return result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
}

function requiredResult(label: string, result: ProcessResult): void {
  if (result.status !== 0) throw new Error(`${label} failed: ${resultDetail(result)}`);
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function removeFileIfPresent(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

function ensureInstallDirectory(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return;
  }
  if (!lstatSync(path).isDirectory()) {
    throw new Error(`Turso CLI installation path must be a regular directory: ${path}`);
  }
}

/** Install only the Turso Cloud CLI binary required by TenkaCloud cloud operations. */
export function installTursoCli(options: InstallTursoCliOptions): string {
  const release = tursoCliRelease(options.platform, options.architecture);
  const installDirectory = join(options.homeDirectory, ".turso");
  const installedExecutable = join(installDirectory, "turso");
  const url = `${RELEASE_BASE_URL}/v${release.version}/${release.archive}`;
  ensureInstallDirectory(installDirectory);
  const temporaryDirectory = mkdtempSync(join(installDirectory, ".tenkacloud-install-"));
  const archivePath = join(temporaryDirectory, release.archive);
  const stagedExecutable = join(temporaryDirectory, "turso");

  try {
    requiredResult(
      "Turso CLI download",
      options.processRunner.run("curl", [
        "--fail",
        "--location",
        "--silent",
        "--show-error",
        url,
        "--output",
        archivePath,
      ]),
    );
    const actualChecksum = (options.calculateChecksum ?? sha256File)(archivePath);
    if (actualChecksum !== release.checksum) {
      throw new Error(
        `Turso CLI checksum mismatch: expected ${release.checksum}, received ${actualChecksum}`,
      );
    }
    requiredResult(
      "Turso CLI extraction",
      options.processRunner.run("tar", ["-xzf", archivePath, "-C", temporaryDirectory, "turso"]),
    );
    if (!existsSync(stagedExecutable) || !lstatSync(stagedExecutable).isFile()) {
      throw new Error("Turso CLI archive did not contain a regular turso executable");
    }
    chmodSync(stagedExecutable, 0o755);
    renameSync(stagedExecutable, installedExecutable);
    return installedExecutable;
  } finally {
    removeFileIfPresent(stagedExecutable);
    removeFileIfPresent(archivePath);
    rmdirSync(temporaryDirectory);
  }
}
