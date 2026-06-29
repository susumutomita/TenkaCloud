/**
 * [Problem Packs / Issue #2097] Install a pack from a PINNED Git revision.
 *
 * This is the only network-touching pack source, and it is deliberately the
 * narrowest possible one: an immutable, fully-qualified commit fetched over
 * HTTPS, with NO dynamic branch loading, NO mutable reference, and NO code
 * execution. Every guard below runs BEFORE any fetch so a floating or unsafe
 * source is refused without ever reaching out to the network.
 *
 * The contract (CLI: `pack install git <https-url> --commit <full-sha> [--subdir <path>]`):
 *   - the commit MUST be an immutable full 40-hex SHA-1. Branch names, tags,
 *     `HEAD`, any floating ref, and abbreviated/short hashes are REJECTED.
 *   - HTTPS only in v1: `ssh://`, `git://`, `http://`, `file://`, and scp-style
 *     `git@host:path` are rejected.
 *   - credentials embedded in the URL (`user:pass@` / `token@` userinfo) are
 *     rejected — secrets must never travel in a pack source.
 *   - the optional subdir must stay strictly inside the repository root.
 *
 * Transport is abstracted behind {@link GitArchiveFetcher} (injected, with a real
 * default that shells out to `git`), so the install flow is fully testable
 * offline. The fetcher materializes the pack root into a caller-provided
 * TEMPORARY directory; this module then validates → snapshots → locks and DELETES
 * the temporary tree on BOTH success and failure. The real fetcher uses `git`
 * plumbing that cannot run hooks (clone with hooks disabled + archive extraction)
 * and never runs package-manager lifecycle scripts.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import {
  type ComposeEffectiveCatalogResult,
  composeEffectiveCatalog,
  type PackProblemInput,
  type PackSnapshotInput,
} from "./effective-catalog.js";
import { realGitArchiveFetcher } from "./git-fetcher.js";
import type { ProviderEngineCapability } from "./manifest.js";
import {
  computeContentDigest,
  type GitProvenance,
  installSnapshotFromDirectory,
  type PackLockEntry,
  readLock,
  SNAPSHOTS_DIRNAME,
  writeLock,
} from "./snapshot.js";
import { validatePackDirectory } from "./validate-pack.js";

/** A full, immutable Git commit: exactly 40 lowercase or uppercase hex chars. */
const FULL_COMMIT_PATTERN = /^[0-9a-fA-F]{40}$/;

/**
 * The validated, normalized Git source. `subdir` is a POSIX relative path or the
 * empty string for the repository root. This is the only shape the install flow
 * trusts — it is produced exclusively by {@link parseGitSource}.
 */
export interface GitSource {
  /** The HTTPS repository URL (credentials already proven absent). */
  readonly repositoryUrl: string;
  /** The resolved immutable commit (full 40-hex SHA-1). */
  readonly commit: string;
  /** Subdir within the repository holding the pack root (POSIX, "" for root). */
  readonly subdir: string;
}

/** Discriminated result of {@link parseGitSource}. Never throws on bad input. */
export type ParseGitSourceResult =
  | { readonly ok: true; readonly source: GitSource }
  | { readonly ok: false; readonly message: string };

/**
 * Zod schema for the raw `(url, commit, subdir)` boundary. It enforces the
 * immutability + HTTPS + no-credentials rules at the type boundary so malformed
 * input fails loudly rather than reaching the fetcher. Path-safety of `subdir` is
 * checked separately (it needs filesystem-relative reasoning, not just a regex).
 */
const GitSourceInputSchema = z
  .object({
    url: z
      .string()
      .min(1)
      .refine((value) => isHttpsUrl(value), {
        message:
          "Repository URL must be HTTPS (https://...). ssh://, git://, http://, file://, and scp-style git@host:path are not supported.",
      })
      .refine((value) => !hasEmbeddedCredentials(value), {
        message:
          "Repository URL must not embed credentials. Remove the 'user:pass@' / 'token@' userinfo from the URL.",
      })
      .refine((value) => !hasQueryOrFragment(value), {
        message:
          "Repository URL must not contain a query string or fragment (e.g. '?token=...' / '#frag'). Pass a clean https://host/path repository URL.",
      }),
    commit: z.string().regex(FULL_COMMIT_PATTERN, {
      message:
        "--commit must be an immutable full 40-character commit hash. Branch names, tags, HEAD, floating refs, and abbreviated hashes are rejected.",
    }),
    subdir: z.string().optional(),
  })
  .strict();

/** The raw, untrusted input accepted by {@link parseGitSource}. */
export interface GitSourceInput {
  readonly url: string;
  readonly commit: string;
  readonly subdir?: string;
}

/**
 * Validate + normalize a raw Git source spec. Returns a refusal (never throws)
 * for a non-HTTPS scheme, embedded credentials, a non-immutable / abbreviated
 * commit, or a subdir that escapes the repository root. The returned
 * {@link GitSource} is the only thing the install flow will fetch.
 */
export function parseGitSource(input: GitSourceInput): ParseGitSourceResult {
  const parsed = GitSourceInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues.map((issue) => issue.message).join("; ") };
  }
  const subdir = normalizeSubdir(parsed.data.subdir);
  if (subdir === undefined) {
    return {
      ok: false,
      message:
        "--subdir must be a relative path inside the repository (no '..', absolute paths, or leading slash).",
    };
  }
  return {
    ok: true,
    source: {
      repositoryUrl: parsed.data.url,
      commit: parsed.data.commit.toLowerCase(),
      subdir,
    },
  };
}

/** True only for a well-formed `https://` URL (rejects every other scheme). */
function isHttpsUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:";
}

/** True when the URL carries any userinfo (`user:pass@` or `token@`). */
function hasEmbeddedCredentials(value: string): boolean {
  try {
    const url = new URL(value);
    return url.username.length > 0 || url.password.length > 0;
  } catch {
    // A URL we cannot parse is rejected by the HTTPS check anyway; treat the
    // credential check as "no opinion" here so the HTTPS message wins.
    return false;
  }
}

/**
 * True when the URL carries a query string or fragment. A `?token=...` query is
 * another way to smuggle a credential into a repository URL, and a fragment has
 * no meaning for a Git remote — both are rejected so the source ref stays a clean
 * `https://host/path` URL.
 */
function hasQueryOrFragment(value: string): boolean {
  try {
    const url = new URL(value);
    return url.search.length > 0 || url.hash.length > 0;
  } catch {
    // Unparseable URLs are caught by the HTTPS check; no opinion here.
    return false;
  }
}

/**
 * Normalize an optional subdir to a POSIX relative path strictly inside the
 * repository root. Returns "" for the root (absent / "." / empty) and undefined
 * when the value escapes via `..`, is absolute, or is otherwise unsafe.
 */
function normalizeSubdir(subdir: string | undefined): string | undefined {
  if (subdir === undefined || subdir === "" || subdir === ".") return "";
  if (path.isAbsolute(subdir)) return undefined;
  const segments = subdir.split(/[\\/]/);
  if (segments.some((segment) => segment === "..")) return undefined;
  // Collapse "." segments and rejoin as POSIX. Reject if nothing remains.
  const clean = segments.filter((segment) => segment.length > 0 && segment !== ".");
  if (clean.length === 0) return "";
  // A normalized path that climbs out (defense in depth) is rejected.
  const joined = clean.join("/");
  if (joined.startsWith("/") || joined.includes("..")) return undefined;
  return joined;
}

/**
 * The transport boundary. A fetcher materializes the pack root for a pinned Git
 * revision into `request.destinationDir` (a fresh empty temporary directory the
 * caller created). After it returns, `destinationDir` must contain the pack as if
 * it were a local pack directory (i.e. `tenkacloud-pack.json` at its top level
 * when no subdir, or the subdir contents promoted to the top level when a subdir
 * is given). It must NOT run Git hooks or any package-manager lifecycle script.
 *
 * Injected so unit tests run offline; {@link realGitArchiveFetcher} is the default.
 */
export type GitArchiveFetcher = (request: GitArchiveRequest) => void;

/** The fetch request handed to a {@link GitArchiveFetcher}. */
export interface GitArchiveRequest {
  /** Validated HTTPS repository URL. */
  readonly repositoryUrl: string;
  /** Resolved immutable full 40-hex commit. */
  readonly commit: string;
  /** Subdir within the repository ("" for the root). */
  readonly subdir: string;
  /** Empty temporary directory the fetcher must materialize the pack root into. */
  readonly destinationDir: string;
}

/** Options for {@link installGitPack}. */
export interface InstallGitPackOptions {
  /** The HTTPS repository URL (validated before any fetch). */
  readonly url: string;
  /** The pinned commit (must be a full 40-hex SHA). */
  readonly commit: string;
  /** Optional subdir within the repository holding the pack root. */
  readonly subdir?: string;
  /** Root of the snapshot store (lock file + snapshots/ live under here). */
  readonly storeDir: string;
  /** Caller-injected install timestamp (ISO-8601). Keeps the engine deterministic. */
  readonly installedAt: string;
  /** Caller-injected core (platform) version the pack is installed against. */
  readonly coreVersion: string;
  /** Provider/engine capabilities the platform can satisfy (for the dry-run compose). */
  readonly availableRuntimes: readonly ProviderEngineCapability[];
  /**
   * Optional expected content digest. When provided, the fetched content must
   * hash to exactly this digest or the install is refused (defense against a
   * tampered mirror). Independent of the immutable-commit guarantee.
   */
  readonly expectedDigest?: string;
  /** Injected transport. Defaults to {@link realGitArchiveFetcher}. */
  readonly fetcher?: GitArchiveFetcher;
}

/** Stable failure reasons so callers / CLIs can switch on the outcome. */
export type InstallGitPackFailureReason =
  | "INVALID_SOURCE"
  | "FETCH_FAILED"
  | "DIGEST_MISMATCH"
  | "INVALID_PACK"
  | "DIGEST_CONFLICT"
  | "COMPOSE_CONFLICT";

/** Discriminated result of {@link installGitPack}. Never throws on a known failure. */
export type InstallGitPackResult =
  | {
      readonly ok: true;
      /** The lock entry for this pack (newly created or the pre-existing identical one). */
      readonly entry: PackLockEntry;
      /** True when the identical content was already installed (no filesystem change). */
      readonly alreadyInstalled: boolean;
      /** Number of problems discovered in the installed pack. */
      readonly problemCount: number;
    }
  | {
      readonly ok: false;
      readonly reason: InstallGitPackFailureReason;
      readonly message: string;
    };

/**
 * Install a pack from a pinned Git revision: validate the source (HTTPS, full
 * immutable commit, no credentials, safe subdir) BEFORE any fetch → fetch the
 * archive into a temporary directory → optionally verify the content digest →
 * validate → snapshot → lock → dry-run compose to prove no duplicate-id conflict.
 * The temporary directory is ALWAYS deleted (success and every failure path). On
 * a compose conflict the just-written snapshot + lock entry are rolled back so an
 * unusable pack leaves no residue. The local install path is untouched.
 */
export function installGitPack(options: InstallGitPackOptions): InstallGitPackResult {
  const parsed = parseGitSource({
    url: options.url,
    commit: options.commit,
    subdir: options.subdir,
  });
  if (!parsed.ok) {
    // Refused BEFORE any fetch: the fetcher is never called.
    return { ok: false, reason: "INVALID_SOURCE", message: parsed.message };
  }
  const source = parsed.source;
  const fetcher = options.fetcher ?? realGitArchiveFetcher;
  const storeDir = path.resolve(options.storeDir);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tenkacloud-git-pack-"));
  try {
    // ONLY the fetch maps to FETCH_FAILED. A later digest / snapshot failure must
    // surface with its own reason (DIGEST_MISMATCH / INVALID_PACK / ...), not be
    // mislabeled as a transport error.
    const fetched = fetchOrThrow(fetcher, source, tempDir);
    if (!fetched.ok) {
      return { ok: false, reason: "FETCH_FAILED", message: fetched.message };
    }

    if (options.expectedDigest !== undefined) {
      const actual = computeContentDigest(tempDir);
      if (actual !== options.expectedDigest) {
        return {
          ok: false,
          reason: "DIGEST_MISMATCH",
          message: `Fetched content digest ${actual} does not match the expected digest ${options.expectedDigest}. The source may have been tampered with; refusing to install.`,
        };
      }
    }

    return snapshotFetched(tempDir, source, storeDir, options);
  } finally {
    // ALWAYS remove the temporary tree — on success and on every failure path.
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Run the injected fetcher, converting any throw into a discriminated failure so
 * the caller can map ONLY a transport error to FETCH_FAILED (digest / snapshot
 * errors are handled separately).
 */
function fetchOrThrow(
  fetcher: GitArchiveFetcher,
  source: GitSource,
  destinationDir: string,
): { ok: true } | { ok: false; message: string } {
  try {
    fetcher({
      repositoryUrl: source.repositoryUrl,
      commit: source.commit,
      subdir: source.subdir,
      destinationDir,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

/**
 * Snapshot the fetched pack tree (validate → snapshot → lock → dry-run compose),
 * recording Git provenance. Rolls the just-written snapshot + lock entry back on
 * a compose conflict so an unusable pack leaves no residue.
 */
function snapshotFetched(
  tempDir: string,
  source: GitSource,
  storeDir: string,
  options: InstallGitPackOptions,
): InstallGitPackResult {
  const git: GitProvenance = {
    repositoryUrl: source.repositoryUrl,
    commit: source.commit,
    subdir: source.subdir,
  };
  const lockBefore = readLock(storeDir);

  const installed = installSnapshotFromDirectory({
    sourceDir: tempDir,
    storeDir,
    sourceKind: "git",
    sourceRef: `${source.repositoryUrl}@${source.commit}`,
    installedAt: options.installedAt,
    coreVersion: options.coreVersion,
    git,
  });
  if (!installed.ok) {
    return { ok: false, reason: installed.reason, message: installed.message };
  }

  if (installed.alreadyInstalled) {
    return {
      ok: true,
      entry: installed.entry,
      alreadyInstalled: true,
      problemCount: countProblems(storeDir, installed.entry),
    };
  }

  const compose = dryRunCompose(storeDir, options.coreVersion, options.availableRuntimes);
  if (!compose.ok) {
    rollbackInstall(storeDir, lockBefore, installed.entry);
    return { ok: false, reason: "COMPOSE_CONFLICT", message: compose.message };
  }

  return {
    ok: true,
    entry: installed.entry,
    alreadyInstalled: false,
    problemCount: countProblems(storeDir, installed.entry),
  };
}

/** Compose the effective catalog over EVERY installed pack as a dry run. */
function dryRunCompose(
  storeDir: string,
  coreVersion: string,
  availableRuntimes: readonly ProviderEngineCapability[],
): ComposeEffectiveCatalogResult {
  const lock = readLock(storeDir);
  const packs: PackSnapshotInput[] = [];
  for (const entry of lock.packs) {
    const snapshotAbs = path.join(storeDir, entry.snapshotPath);
    const validation = validatePackDirectory(snapshotAbs);
    if (!validation.manifest) continue;
    const root = validation.manifest.problemsRoot ?? "problems";
    const problems: PackProblemInput[] = validation.problemIds.map((problemId) => ({
      problemId,
      directory: root,
      projections: {},
    }));
    packs.push({ manifest: validation.manifest, contentDigest: entry.contentDigest, problems });
  }
  return composeEffectiveCatalog({
    core: [],
    packs,
    platform: { coreVersion, availableRuntimes },
  });
}

/** Count the problems discovered in a pack's immutable snapshot. */
function countProblems(storeDir: string, entry: PackLockEntry): number {
  const snapshotAbs = path.join(storeDir, entry.snapshotPath);
  return validatePackDirectory(snapshotAbs).problemIds.length;
}

/** Roll a just-installed pack back: delete its snapshot tree, restore the lock. */
function rollbackInstall(
  storeDir: string,
  lockBefore: ReturnType<typeof readLock>,
  entry: PackLockEntry,
): void {
  const snapshotAbs = path.join(storeDir, entry.snapshotPath);
  if (fs.existsSync(snapshotAbs)) {
    fs.rmSync(snapshotAbs, { recursive: true, force: true });
  }
  pruneEmptyDir(path.dirname(snapshotAbs));
  pruneEmptyDir(path.join(storeDir, SNAPSHOTS_DIRNAME));
  if (lockBefore.packs.length === 0) {
    const lockPath = path.join(storeDir, "packs-lock.json");
    if (fs.existsSync(lockPath)) fs.rmSync(lockPath);
  } else {
    writeLock(storeDir, lockBefore);
  }
}

/** Remove a directory only when it exists and is empty. Best-effort, never throws. */
function pruneEmptyDir(dir: string): void {
  if (!fs.existsSync(dir)) return;
  if (fs.readdirSync(dir).length === 0) {
    fs.rmdirSync(dir);
  }
}
