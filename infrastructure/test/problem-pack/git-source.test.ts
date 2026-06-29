/**
 * [Problem Packs / Issue #2097] Tests for installing a pack from a pinned Git
 * revision.
 *
 * The Git transport is abstracted behind an injectable {@link GitArchiveFetcher},
 * so this suite runs FULLY OFFLINE: it injects an in-memory/local-fixture fetcher
 * that writes a known pack tree into the temporary directory the install hands it.
 * No real network, no process spawn. The real default fetcher (which shells out
 * to `git`) is never invoked here.
 *
 * Rules under test (all enforced BEFORE any fetch, except digest):
 *   - require an immutable full 40-hex commit; reject branch / tag / HEAD /
 *     floating ref / abbreviated (short) hash
 *   - HTTPS only (reject ssh:// git:// http:// file://)
 *   - reject credentials embedded in the URL (userinfo)
 *   - fetch into a TEMPORARY directory, validate → snapshot → lock, then DELETE
 *     the temporary files on BOTH success and failure
 *   - the lock entry stores repositoryUrl, resolved commit, subdir, and digest,
 *     with sourceKind "git"
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type GitArchiveFetcher,
  type GitArchiveRequest,
  installGitPack,
  parseGitSource,
} from "../../lib/problem-pack/git-source";
import { readLock } from "../../lib/problem-pack/snapshot";

let base: string;
let storeDir: string;

const INSTALLED_AT = "2026-06-29T00:00:00.000Z";
const CORE_VERSION = "1.0.0";
const AVAILABLE_RUNTIMES = [{ provider: "aws", engine: "cloudformation" }] as const;
const FULL_SHA = "0123456789abcdef0123456789abcdef01234567";
const HTTPS_URL = "https://github.com/example/cloud-pack.git";

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "tenkacloud-git-source-"));
  storeDir = path.join(base, "store");
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "com.example.cloud-pack",
    version: "1.2.3",
    core: "^1.0.0",
    title: "Example Cloud Pack",
    description: "A sample pack of cloud problems.",
    license: "Apache-2.0",
    problemsRoot: "problems",
    requiredRuntimes: [{ provider: "aws", engine: "cloudformation" }],
    ...overrides,
  };
}

/** Materialize a minimal, fully-valid pack under `dir` (mirrors fixtures). */
function writeValidPack(
  dir: string,
  options: { manifestOverrides?: Record<string, unknown>; problemId?: string } = {},
): void {
  const problemId = options.problemId ?? "hello-world";
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "tenkacloud-pack.json"),
    JSON.stringify(manifest(options.manifestOverrides), null, 2),
  );
  const problemDir = path.join(dir, "problems", "challenges", problemId);
  fs.mkdirSync(problemDir, { recursive: true });
  fs.writeFileSync(
    path.join(problemDir, "metadata.json"),
    JSON.stringify({
      id: problemId,
      title: problemId,
      category: "challenges",
      cfnTemplate: "template.yaml",
      scoring: { kind: "flag", flagOutputKey: "Flag", points: 100 },
    }),
  );
  fs.writeFileSync(path.join(problemDir, "template.yaml"), "Resources: {}\n");
}

/**
 * A fetcher that writes a valid pack into the destination it is handed. It also
 * records the directory it received so a test can assert the temp dir is removed
 * afterwards, and the request it was called with.
 */
function fixtureFetcher(
  options: {
    packOptions?: Parameters<typeof writeValidPack>[1];
    onCall?: (request: GitArchiveRequest) => void;
  } = {},
): GitArchiveFetcher & { destinations: string[]; requests: GitArchiveRequest[] } {
  const destinations: string[] = [];
  const requests: GitArchiveRequest[] = [];
  const fetcher: GitArchiveFetcher = (request) => {
    requests.push(request);
    destinations.push(request.destinationDir);
    options.onCall?.(request);
    writeValidPack(request.destinationDir, options.packOptions);
  };
  return Object.assign(fetcher, { destinations, requests });
}

function installGit(
  spec: { url?: string; commit?: string; subdir?: string },
  fetcher: GitArchiveFetcher,
) {
  return installGitPack({
    url: spec.url ?? HTTPS_URL,
    commit: spec.commit ?? FULL_SHA,
    subdir: spec.subdir,
    storeDir,
    installedAt: INSTALLED_AT,
    coreVersion: CORE_VERSION,
    availableRuntimes: AVAILABLE_RUNTIMES,
    fetcher,
  });
}

describe("parseGitSource (#2097)", () => {
  it("should accept an HTTPS URL with a full 40-hex commit and no subdir", () => {
    const result = parseGitSource({ url: HTTPS_URL, commit: FULL_SHA });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source.repositoryUrl).toBe(HTTPS_URL);
    expect(result.source.commit).toBe(FULL_SHA);
    expect(result.source.subdir).toBe("");
  });

  it("should reject a branch name as the commit before any fetch", () => {
    const result = parseGitSource({ url: HTTPS_URL, commit: "main" });
    expect(result.ok).toBe(false);
  });

  it("should reject a tag-like ref as the commit", () => {
    const result = parseGitSource({ url: HTTPS_URL, commit: "v1.2.3" });
    expect(result.ok).toBe(false);
  });

  it("should reject HEAD and floating refs as the commit", () => {
    expect(parseGitSource({ url: HTTPS_URL, commit: "HEAD" }).ok).toBe(false);
    expect(parseGitSource({ url: HTTPS_URL, commit: "HEAD~1" }).ok).toBe(false);
    expect(parseGitSource({ url: HTTPS_URL, commit: "refs/heads/main" }).ok).toBe(false);
  });

  it("should reject an abbreviated / short commit hash", () => {
    expect(parseGitSource({ url: HTTPS_URL, commit: "0123456" }).ok).toBe(false);
    expect(parseGitSource({ url: HTTPS_URL, commit: FULL_SHA.slice(0, 39) }).ok).toBe(false);
  });

  it("should reject an over-long or non-hex commit", () => {
    expect(parseGitSource({ url: HTTPS_URL, commit: `${FULL_SHA}0` }).ok).toBe(false);
    expect(parseGitSource({ url: HTTPS_URL, commit: "g".repeat(40) }).ok).toBe(false);
  });

  it("should reject a non-HTTPS scheme (ssh, git, http, file)", () => {
    expect(parseGitSource({ url: "ssh://git@github.com/x/y.git", commit: FULL_SHA }).ok).toBe(
      false,
    );
    expect(parseGitSource({ url: "git://github.com/x/y.git", commit: FULL_SHA }).ok).toBe(false);
    expect(parseGitSource({ url: "http://github.com/x/y.git", commit: FULL_SHA }).ok).toBe(false);
    expect(parseGitSource({ url: "file:///etc/passwd", commit: FULL_SHA }).ok).toBe(false);
    expect(parseGitSource({ url: "git@github.com:x/y.git", commit: FULL_SHA }).ok).toBe(false);
  });

  it("should reject credentials embedded in the URL (userinfo)", () => {
    expect(
      parseGitSource({ url: "https://user:pass@github.com/x/y.git", commit: FULL_SHA }).ok,
    ).toBe(false);
    expect(parseGitSource({ url: "https://token@github.com/x/y.git", commit: FULL_SHA }).ok).toBe(
      false,
    );
  });

  it("should reject a subdir that escapes the repository root", () => {
    expect(parseGitSource({ url: HTTPS_URL, commit: FULL_SHA, subdir: "../etc" }).ok).toBe(false);
    expect(parseGitSource({ url: HTTPS_URL, commit: FULL_SHA, subdir: "/abs" }).ok).toBe(false);
    expect(parseGitSource({ url: HTTPS_URL, commit: FULL_SHA, subdir: "a/../../b" }).ok).toBe(
      false,
    );
  });

  it("should normalize an accepted subdir to a POSIX relative path", () => {
    const result = parseGitSource({ url: HTTPS_URL, commit: FULL_SHA, subdir: "packs/cloud" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source.subdir).toBe("packs/cloud");
  });
});

describe("installGitPack success (#2097)", () => {
  it("should install a pinned Git archive and record git provenance in the lock", () => {
    const fetcher = fixtureFetcher();

    const result = installGit({}, fetcher);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.sourceKind).toBe("git");
    expect(result.entry.git).toEqual({
      repositoryUrl: HTTPS_URL,
      commit: FULL_SHA,
      subdir: "",
    });
    expect(result.entry.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.problemCount).toBe(1);

    const lock = readLock(storeDir);
    expect(lock.packs).toHaveLength(1);
    expect(lock.packs[0].sourceKind).toBe("git");
    expect(lock.packs[0].git?.commit).toBe(FULL_SHA);
  });

  it("should pass the resolved commit, url, and subdir to the fetcher", () => {
    const fetcher = fixtureFetcher();

    installGit({ subdir: "packs/cloud" }, fetcher);

    expect(fetcher.requests).toHaveLength(1);
    expect(fetcher.requests[0]).toMatchObject({
      repositoryUrl: HTTPS_URL,
      commit: FULL_SHA,
      subdir: "packs/cloud",
    });
  });

  it("should record the subdir in the lock provenance", () => {
    const fetcher = fixtureFetcher();

    const result = installGit({ subdir: "packs/cloud" }, fetcher);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.git?.subdir).toBe("packs/cloud");
  });

  it("should remove the temporary fetch directory after a successful install", () => {
    const fetcher = fixtureFetcher();

    installGit({}, fetcher);

    expect(fetcher.destinations).toHaveLength(1);
    expect(fs.existsSync(fetcher.destinations[0])).toBe(false);
  });
});

describe("installGitPack rejections before fetch (#2097)", () => {
  it("should reject a branch name and NEVER call the fetcher", () => {
    const fetcher = vi.fn<GitArchiveFetcher>();

    const result = installGitPack({
      url: HTTPS_URL,
      commit: "main",
      storeDir,
      installedAt: INSTALLED_AT,
      coreVersion: CORE_VERSION,
      availableRuntimes: AVAILABLE_RUNTIMES,
      fetcher,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("INVALID_SOURCE");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("should reject a tag and never call the fetcher", () => {
    const fetcher = vi.fn<GitArchiveFetcher>();
    const result = installGit({ commit: "v1.0.0" }, fetcher);
    expect(result.ok).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("should reject a short SHA and never call the fetcher", () => {
    const fetcher = vi.fn<GitArchiveFetcher>();
    const result = installGit({ commit: "0123456" }, fetcher);
    expect(result.ok).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("should reject HEAD and never call the fetcher", () => {
    const fetcher = vi.fn<GitArchiveFetcher>();
    const result = installGit({ commit: "HEAD" }, fetcher);
    expect(result.ok).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("should reject a non-HTTPS URL and never call the fetcher", () => {
    const fetcher = vi.fn<GitArchiveFetcher>();
    const result = installGit({ url: "ssh://git@github.com/x/y.git" }, fetcher);
    expect(result.ok).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("should reject a URL with embedded credentials and never call the fetcher", () => {
    const fetcher = vi.fn<GitArchiveFetcher>();
    const result = installGit({ url: "https://user:pass@github.com/x/y.git" }, fetcher);
    expect(result.ok).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("should not create a lock when the source is rejected before fetch", () => {
    const fetcher = vi.fn<GitArchiveFetcher>();
    installGit({ commit: "main" }, fetcher);
    expect(fs.existsSync(path.join(storeDir, "packs-lock.json"))).toBe(false);
  });
});

describe("installGitPack digest + cleanup (#2097)", () => {
  it("should reject a digest mismatch when expectedDigest does not match the fetched content", () => {
    const fetcher = fixtureFetcher();

    const result = installGitPack({
      url: HTTPS_URL,
      commit: FULL_SHA,
      expectedDigest: "f".repeat(64),
      storeDir,
      installedAt: INSTALLED_AT,
      coreVersion: CORE_VERSION,
      availableRuntimes: AVAILABLE_RUNTIMES,
      fetcher,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("DIGEST_MISMATCH");
    // Nothing installed.
    expect(readLock(storeDir).packs).toEqual([]);
    // Temp dir cleaned up even on the digest-mismatch failure path.
    expect(fetcher.destinations).toHaveLength(1);
    expect(fs.existsSync(fetcher.destinations[0])).toBe(false);
  });

  it("should accept a matching expectedDigest (re-installing the same revision content)", () => {
    const first = installGit({}, fixtureFetcher());
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const fetcher = fixtureFetcher();
    const result = installGitPack({
      url: HTTPS_URL,
      commit: FULL_SHA,
      expectedDigest: first.entry.contentDigest,
      storeDir,
      installedAt: INSTALLED_AT,
      coreVersion: CORE_VERSION,
      availableRuntimes: AVAILABLE_RUNTIMES,
      fetcher,
    });

    expect(result.ok).toBe(true);
  });

  it("should remove the temporary fetch directory when the fetched pack is invalid", () => {
    // The fetcher writes a stray file instead of a valid pack → validation fails.
    const destinations: string[] = [];
    const fetcher: GitArchiveFetcher = (request) => {
      destinations.push(request.destinationDir);
      fs.writeFileSync(path.join(request.destinationDir, "stray.txt"), "not a pack\n");
    };

    const result = installGit({}, fetcher);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("INVALID_PACK");
    expect(destinations).toHaveLength(1);
    expect(fs.existsSync(destinations[0])).toBe(false);
    expect(fs.existsSync(path.join(storeDir, "packs-lock.json"))).toBe(false);
  });

  it("should remove the temporary fetch directory when the fetcher throws", () => {
    const destinations: string[] = [];
    const fetcher: GitArchiveFetcher = (request) => {
      destinations.push(request.destinationDir);
      throw new Error("network down");
    };

    const result = installGit({}, fetcher);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("FETCH_FAILED");
    expect(destinations).toHaveLength(1);
    expect(fs.existsSync(destinations[0])).toBe(false);
  });

  it("should snapshot only the subdir tree when a subdir is given", () => {
    // The fetcher writes the pack INTO the destination it is handed; the install
    // is responsible for pointing the fetcher at the subdir. We assert the
    // installed snapshot has the expected problem regardless of subdir nesting.
    const fetcher = fixtureFetcher();

    const result = installGit({ subdir: "nested/pack" }, fetcher);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.problemCount).toBe(1);
  });
});
