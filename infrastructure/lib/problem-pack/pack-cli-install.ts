/**
 * [Problem Packs / Issue #2094, #2097] The `pack install` subcommand handlers,
 * split out of the CLI dispatcher (`pack-cli.ts`) so that file stays a thin
 * router (SRP — Issue #986).
 *
 * Two install sources share one summary renderer and one exit-code contract:
 *   - `install <dir> [--store <dir>]` (#2094) → a LOCAL pack directory.
 *   - `install git <https-url> --commit <full-sha> [--subdir <path>] [--store
 *     <dir>]` (#2097) → a PINNED, immutable Git revision over HTTPS. Source
 *     validation (HTTPS / full commit / no credentials / safe subdir) is a
 *     lifecycle refusal; a missing URL / commit flag is a usage error.
 *
 * Exit codes (shared with the rest of the CLI): 0 success, 1 lifecycle refusal,
 * 2 tool failure (bad usage / missing flag value). The Git transport is injected
 * via `deps.gitFetcher`, so the CLI runs fully offline in tests.
 */

import type { GitArchiveFetcher } from "./git-source.js";
import { installGitPack, installPack } from "./lifecycle.js";
import type { ProviderEngineCapability } from "./manifest.js";

/** Sink for a single line of output (no trailing newline). Mirrors `pack-cli.ts`. */
export type LineWriter = (line: string) => void;

/** Injectable dependencies threaded from {@link runPackCli}. */
export interface PackCliDeps {
  /** Git archive transport for `install git ...`. Defaults to the real fetcher. */
  readonly gitFetcher?: GitArchiveFetcher;
}

const EXIT_OK = 0;
const EXIT_VALIDATION_FAILURE = 1;
const EXIT_TOOL_FAILURE = 2;

/** Usage banner for the install subcommand. Re-exported for the CLI's full USAGE. */
export const INSTALL_USAGE =
  "Usage: tenkacloud pack install <dir> [--store <dir>]\n" +
  "       tenkacloud pack install git <https-url> --commit <full-sha> [--subdir <path>] [--store <dir>]";

/** Default snapshot store, relative to the CWD. Mirrors `pack-cli.ts`. */
const DEFAULT_STORE_DIR = ".tenkacloud/pack-store";

/**
 * Platform context the dry-run compose validates packs against. Inert defaults so
 * the offline CLI never reaches a running platform; they satisfy the reference
 * pack (`core ^1.0.0`, `aws/cloudformation`). Mirrors `pack-cli.ts`.
 */
const PLATFORM_CORE_VERSION = "1.0.0";
const PLATFORM_AVAILABLE_RUNTIMES: readonly ProviderEngineCapability[] = [
  { provider: "aws", engine: "cloudformation" },
  { provider: "gcp", engine: "infra-manager" },
  { provider: "azure", engine: "bicep" },
  { provider: "sakura", engine: "terraform" },
];

/**
 * Extract a single-value flag (`--name value`) from an argv tail. Returns the
 * value, the surviving args, and whether the flag was malformed (present with no
 * value). A malformed flag is a hard error so the CLI never silently substitutes
 * a default. Mirrors the same helper in `pack-cli.ts`.
 */
function takeFlag(
  args: readonly string[],
  name: string,
): { value?: string; rest: string[]; malformed: boolean } {
  const index = args.indexOf(name);
  if (index < 0) return { rest: [...args], malformed: false };
  const next = args[index + 1];
  if (next === undefined || next.startsWith("--")) {
    return { rest: [...args], malformed: true };
  }
  const rest = args.filter((_, i) => i !== index && i !== index + 1);
  return { value: next, rest, malformed: false };
}

/**
 * Run `pack install ...`. Dispatches to the Git source when the first token is
 * `git`; otherwise installs a local pack directory. The local path is byte-for-
 * byte the #2094 behavior.
 */
export function runInstall(rest: readonly string[], write: LineWriter, deps: PackCliDeps): number {
  // `install git <url> ...` is the pinned-Git source (#2097); everything else is
  // the unchanged local-directory install (#2094).
  if (rest[0] === "git") {
    return runInstallGit(rest.slice(1), write, deps);
  }

  const store = takeFlag(rest, "--store");
  if (store.malformed) {
    write(INSTALL_USAGE);
    return EXIT_TOOL_FAILURE;
  }
  const dir = store.rest.filter((arg) => !arg.startsWith("--"))[0];
  if (!dir) {
    write(INSTALL_USAGE);
    return EXIT_TOOL_FAILURE;
  }

  const result = installPack({
    sourceDir: dir,
    storeDir: store.value ?? DEFAULT_STORE_DIR,
    installedAt: new Date().toISOString(),
    coreVersion: PLATFORM_CORE_VERSION,
    availableRuntimes: PLATFORM_AVAILABLE_RUNTIMES,
  });
  if (!result.ok) {
    write(result.message);
    return EXIT_VALIDATION_FAILURE;
  }
  reportInstalled(result, write);
  return EXIT_OK;
}

/**
 * `pack install git <https-url> --commit <full-sha> [--subdir <path>] [--store
 * <dir>]`. Source validation (HTTPS / immutable full commit / no credentials /
 * safe subdir) is a lifecycle refusal (exit 1); a missing URL / commit flag is a
 * usage error (exit 2). The Git transport is injected so the CLI stays offline.
 */
function runInstallGit(rest: readonly string[], write: LineWriter, deps: PackCliDeps): number {
  const store = takeFlag(rest, "--store");
  if (store.malformed) {
    write(INSTALL_USAGE);
    return EXIT_TOOL_FAILURE;
  }
  const commit = takeFlag(store.rest, "--commit");
  if (commit.malformed || commit.value === undefined) {
    write(INSTALL_USAGE);
    return EXIT_TOOL_FAILURE;
  }
  const subdir = takeFlag(commit.rest, "--subdir");
  if (subdir.malformed) {
    write(INSTALL_USAGE);
    return EXIT_TOOL_FAILURE;
  }
  const url = subdir.rest.filter((arg) => !arg.startsWith("--"))[0];
  if (!url) {
    write(INSTALL_USAGE);
    return EXIT_TOOL_FAILURE;
  }

  const result = installGitPack({
    url,
    commit: commit.value,
    subdir: subdir.value,
    storeDir: store.value ?? DEFAULT_STORE_DIR,
    installedAt: new Date().toISOString(),
    coreVersion: PLATFORM_CORE_VERSION,
    availableRuntimes: PLATFORM_AVAILABLE_RUNTIMES,
    fetcher: deps.gitFetcher,
  });
  if (!result.ok) {
    write(result.message);
    return EXIT_VALIDATION_FAILURE;
  }
  reportInstalled(result, write);
  return EXIT_OK;
}

/** A successful install result shared by both sources (local and git). */
interface InstallSummary {
  readonly alreadyInstalled: boolean;
  readonly entry: {
    readonly packId: string;
    readonly version: string;
    /** Always set for new installs; optional here to guard a legacy/hand-edited lock. */
    readonly sourceKind?: string;
    readonly contentDigest: string;
  };
  readonly problemCount: number;
}

/** Render the shared "installed / already installed" summary for both sources. */
function reportInstalled(result: InstallSummary, write: LineWriter): void {
  const verb = result.alreadyInstalled ? "already installed" : "installed";
  write(`Pack ${verb}: ${result.entry.packId}@${result.entry.version}`);
  // `sourceKind` is set on every fresh install (and backfilled to "local" when
  // reading legacy locks); render the line only when present so a malformed entry
  // never prints "source: undefined".
  if (result.entry.sourceKind) {
    write(`  source: ${result.entry.sourceKind}`);
  }
  write(`  digest: ${result.entry.contentDigest}`);
  write(`  problems: ${result.problemCount}`);
}
