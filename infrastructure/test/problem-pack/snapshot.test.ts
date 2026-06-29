/**
 * [Problem Packs / Issue #2090] Tests for immutable local pack snapshots + lock.
 *
 * These drive the REAL installer over temp directories on the actual filesystem
 * (no FS mocks). Validation is delegated to the #2088 validator, so an invalid
 * pack is genuinely rejected. `installedAt` / `coreVersion` are injected so the
 * suite is deterministic and free of wall-clock dependence. No network, no CDK
 * synth, no runtime code execution.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeContentDigest,
  installLocalPack,
  LOCK_FILENAME,
  readLock,
} from "../../lib/problem-pack/snapshot";

let sourceDir: string;
let storeDir: string;

const INSTALLED_AT = "2026-06-29T00:00:00.000Z";
const CORE_VERSION = "0.1.0";

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tenkacloud-pack-snapshot-"));
  sourceDir = path.join(base, "source");
  storeDir = path.join(base, "store");
  fs.mkdirSync(sourceDir, { recursive: true });
});

afterEach(() => {
  for (const dir of [sourceDir, storeDir]) {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

/** A minimal, fully-valid manifest. Tests clone + mutate this. */
function validManifest(): Record<string, unknown> {
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
  };
}

function awsProblem(id: string): Record<string, unknown> {
  return {
    id,
    title: id,
    category: "challenges",
    cfnTemplate: "template.yaml",
    scoring: { kind: "flag", flagOutputKey: "Flag", points: 100 },
  };
}

/** Build a minimal valid pack under `dir`. Returns `dir` for chaining. */
function writeValidPack(dir: string, manifest = validManifest()): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "tenkacloud-pack.json"), JSON.stringify(manifest, null, 2));
  const problemDir = path.join(dir, "problems", "challenges", "hello-world");
  fs.mkdirSync(problemDir, { recursive: true });
  fs.writeFileSync(
    path.join(problemDir, "metadata.json"),
    JSON.stringify(awsProblem("hello-world"), null, 2),
  );
  fs.writeFileSync(path.join(problemDir, "template.yaml"), "# CFn deploy body\nResources: {}\n");
  return dir;
}

function install(overrides: Partial<Parameters<typeof installLocalPack>[0]> = {}) {
  return installLocalPack({
    sourceDir,
    storeDir,
    installedAt: INSTALLED_AT,
    coreVersion: CORE_VERSION,
    ...overrides,
  });
}

describe("installLocalPack (#2090)", () => {
  it("should create a snapshot and lock entry for a validated local pack", () => {
    writeValidPack(sourceDir);

    const result = install();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alreadyInstalled).toBe(false);
    expect(result.entry).toMatchObject({
      packId: "com.example.cloud-pack",
      version: "1.2.3",
      sourceKind: "local",
      sourceRef: path.resolve(sourceDir),
      installedAt: INSTALLED_AT,
      coreVersion: CORE_VERSION,
    });
    expect(result.entry.contentDigest).toMatch(/^[0-9a-f]{64}$/);

    // The lock file exists and contains exactly the one entry.
    const lock = readLock(storeDir);
    expect(lock.packs).toHaveLength(1);
    expect(lock.packs[0]).toEqual(result.entry);
    expect(fs.existsSync(path.join(storeDir, LOCK_FILENAME))).toBe(true);

    // The snapshot tree mirrors the source content.
    const snapshotAbs = path.join(storeDir, result.entry.snapshotPath);
    expect(fs.existsSync(path.join(snapshotAbs, "tenkacloud-pack.json"))).toBe(true);
    expect(
      fs.existsSync(
        path.join(snapshotAbs, "problems", "challenges", "hello-world", "template.yaml"),
      ),
    ).toBe(true);
  });

  it("should compute a deterministic digest over canonical sorted files excluding .git/node_modules/dist/hidden/symlinks", () => {
    writeValidPack(sourceDir);
    const baseline = computeContentDigest(sourceDir);

    // Adding excluded content must NOT change the digest.
    fs.mkdirSync(path.join(sourceDir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.mkdirSync(path.join(sourceDir, "node_modules", "left-pad"), { recursive: true });
    fs.writeFileSync(
      path.join(sourceDir, "node_modules", "left-pad", "index.js"),
      "module.exports={}\n",
    );
    fs.mkdirSync(path.join(sourceDir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "dist", "bundle.js"), "console.log(1)\n");
    fs.writeFileSync(path.join(sourceDir, ".DS_Store"), "junk");
    fs.symlinkSync(path.join(sourceDir, "tenkacloud-pack.json"), path.join(sourceDir, "link.json"));

    expect(computeContentDigest(sourceDir)).toBe(baseline);

    // An identical-content copy in a different directory yields the same digest.
    const twin = path.join(path.dirname(sourceDir), "twin");
    writeValidPack(twin);
    expect(computeContentDigest(twin)).toBe(baseline);

    // Changing real included content DOES change the digest.
    fs.writeFileSync(
      path.join(sourceDir, "problems", "challenges", "hello-world", "template.yaml"),
      "# changed\n",
    );
    expect(computeContentDigest(sourceDir)).not.toBe(baseline);
  });

  it("should be idempotent when the same content is installed twice", () => {
    writeValidPack(sourceDir);

    const first = install();
    const second = install();

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.alreadyInstalled).toBe(false);
    expect(second.alreadyInstalled).toBe(true);
    expect(second.entry).toEqual(first.entry);

    // No duplicate / changed lock entry.
    const lock = readLock(storeDir);
    expect(lock.packs).toHaveLength(1);
  });

  it("should fail closed when the same id+version has a different digest", () => {
    writeValidPack(sourceDir);
    const first = install();
    expect(first.ok).toBe(true);

    // Mutate included content WITHOUT bumping the version → conflicting digest.
    fs.writeFileSync(
      path.join(sourceDir, "problems", "challenges", "hello-world", "template.yaml"),
      "# mutated body\nResources: { Changed: true }\n",
    );

    const second = install();

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe("DIGEST_CONFLICT");

    // The original lock entry is untouched (still the first digest, one entry).
    const lock = readLock(storeDir);
    expect(lock.packs).toHaveLength(1);
    if (first.ok) expect(lock.packs[0]).toEqual(first.entry);
  });

  it("should leave the snapshot usable after the source directory is deleted", () => {
    writeValidPack(sourceDir);
    const result = install();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const snapshotAbs = path.join(storeDir, result.entry.snapshotPath);
    fs.rmSync(sourceDir, { recursive: true, force: true });

    // Snapshot content survives and is self-contained.
    expect(fs.existsSync(snapshotAbs)).toBe(true);
    const manifestRaw = fs.readFileSync(path.join(snapshotAbs, "tenkacloud-pack.json"), "utf-8");
    expect(JSON.parse(manifestRaw)).toMatchObject({
      id: "com.example.cloud-pack",
      version: "1.2.3",
    });
    // The digest of the snapshot tree matches what was recorded in the lock.
    expect(computeContentDigest(snapshotAbs)).toBe(result.entry.contentDigest);
  });

  it("should refuse to snapshot an invalid pack", () => {
    // No manifest at all → the #2088 validator reports it as invalid.
    fs.writeFileSync(path.join(sourceDir, "stray.txt"), "not a pack\n");

    const result = install();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("INVALID_PACK");
    // Nothing was written: no lock file, no snapshots dir.
    expect(fs.existsSync(path.join(storeDir, LOCK_FILENAME))).toBe(false);
    expect(readLock(storeDir).packs).toEqual([]);
  });
});

describe("readLock legacy compatibility (#2097)", () => {
  it("should backfill sourceKind to 'local' for a legacy lock entry without it", () => {
    // A lock written before #2097 added `sourceKind`.
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(
      path.join(storeDir, LOCK_FILENAME),
      JSON.stringify({
        schemaVersion: 1,
        packs: [
          {
            packId: "com.example.legacy",
            version: "1.0.0",
            sourceRef: "/some/old/path",
            contentDigest: "a".repeat(64),
            installedAt: INSTALLED_AT,
            coreVersion: CORE_VERSION,
            snapshotPath: "snapshots/com.example.legacy/1.0.0",
          },
        ],
      }),
    );

    const lock = readLock(storeDir);

    expect(lock.packs).toHaveLength(1);
    expect(lock.packs[0].sourceKind).toBe("local");
  });

  it("should preserve an explicit sourceKind (an explicit value wins over the default)", () => {
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(
      path.join(storeDir, LOCK_FILENAME),
      JSON.stringify({
        schemaVersion: 1,
        packs: [
          {
            packId: "com.example.git-pack",
            version: "2.0.0",
            sourceKind: "git",
            sourceRef: `https://github.com/example/x.git@${"0".repeat(40)}`,
            contentDigest: "b".repeat(64),
            installedAt: INSTALLED_AT,
            coreVersion: CORE_VERSION,
            snapshotPath: "snapshots/com.example.git-pack/2.0.0",
            git: {
              repositoryUrl: "https://github.com/example/x.git",
              commit: "0".repeat(40),
              subdir: "",
            },
          },
        ],
      }),
    );

    const lock = readLock(storeDir);

    expect(lock.packs[0].sourceKind).toBe("git");
    expect(lock.packs[0].git?.commit).toBe("0".repeat(40));
  });
});
