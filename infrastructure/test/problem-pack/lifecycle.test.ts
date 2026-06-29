/**
 * [Problem Packs / Issue #2094] Tests for the local pack lifecycle core.
 *
 * `installPack` / `listInstalledPacks` / `inspectPack` / `removePack` are the
 * offline engine behind the `pack install|list|inspect|remove` CLI. These tests
 * drive the REAL engine over temp directories on the actual filesystem (no FS
 * mocks): validation, snapshot, and lock are genuinely exercised. `installedAt` /
 * `coreVersion` and the pin predicate are INJECTED so the suite is deterministic
 * and free of wall-clock / cloud dependence. No network, no CDK synth.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  inspectPack,
  installPack,
  listInstalledPacks,
  removePack,
} from "../../lib/problem-pack/lifecycle";
import { LOCK_FILENAME, readLock } from "../../lib/problem-pack/snapshot";

let base: string;
let sourceDir: string;
let storeDir: string;

const INSTALLED_AT = "2026-06-29T00:00:00.000Z";
const CORE_VERSION = "1.0.0";
const AVAILABLE_RUNTIMES = [{ provider: "aws", engine: "cloudformation" }] as const;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "tenkacloud-pack-lifecycle-"));
  sourceDir = path.join(base, "source");
  storeDir = path.join(base, "store");
  fs.mkdirSync(sourceDir, { recursive: true });
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

function awsProblem(id: string): Record<string, unknown> {
  return {
    id,
    title: id,
    category: "challenges",
    cfnTemplate: "template.yaml",
    scoring: { kind: "flag", flagOutputKey: "Flag", points: 100 },
  };
}

/** Build a minimal, fully-valid pack under `dir`. Returns `dir`. */
function writeValidPack(
  dir: string,
  options: { manifestOverrides?: Record<string, unknown>; problemId?: string } = {},
): string {
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
    JSON.stringify(awsProblem(problemId), null, 2),
  );
  fs.writeFileSync(path.join(problemDir, "template.yaml"), "# CFn deploy body\nResources: {}\n");
  return dir;
}

function install(overrides: Partial<Parameters<typeof installPack>[0]> = {}) {
  return installPack({
    sourceDir,
    storeDir,
    installedAt: INSTALLED_AT,
    coreVersion: CORE_VERSION,
    availableRuntimes: AVAILABLE_RUNTIMES,
    ...overrides,
  });
}

describe("installPack (#2094)", () => {
  it("should validate, snapshot, lock, and dry-run compose a valid pack", () => {
    writeValidPack(sourceDir);

    const result = install();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alreadyInstalled).toBe(false);
    expect(result.entry).toMatchObject({
      packId: "com.example.cloud-pack",
      version: "1.2.3",
      sourceKind: "local",
    });
    expect(result.problemCount).toBe(1);

    // Snapshot + lock are persisted.
    expect(fs.existsSync(path.join(storeDir, LOCK_FILENAME))).toBe(true);
    expect(readLock(storeDir).packs).toHaveLength(1);
    expect(fs.existsSync(path.join(storeDir, result.entry.snapshotPath))).toBe(true);
  });

  it("should be idempotent when the identical digest is installed twice", () => {
    writeValidPack(sourceDir);

    const first = install();
    const second = install();

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.alreadyInstalled).toBe(false);
    expect(second.alreadyInstalled).toBe(true);
    expect(readLock(storeDir).packs).toHaveLength(1);
  });

  it("should reject the same id+version with a different digest", () => {
    writeValidPack(sourceDir);
    install();
    fs.writeFileSync(
      path.join(sourceDir, "problems", "challenges", "hello-world", "template.yaml"),
      "# mutated\nResources: { Changed: true }\n",
    );

    const result = install();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("DIGEST_CONFLICT");
    expect(readLock(storeDir).packs).toHaveLength(1);
  });

  it("should leave no snapshot or lock residue when the pack is invalid", () => {
    // No manifest → the #2088 validator rejects it before any write.
    fs.writeFileSync(path.join(sourceDir, "stray.txt"), "not a pack\n");

    const result = install();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("INVALID_PACK");
    expect(fs.existsSync(path.join(storeDir, LOCK_FILENAME))).toBe(false);
    expect(fs.existsSync(path.join(storeDir, "snapshots"))).toBe(false);
  });

  it("should refuse and roll back when a second pack duplicates an installed problem id", () => {
    // First pack installs "shared".
    writeValidPack(sourceDir, { problemId: "shared" });
    const first = install();
    expect(first.ok).toBe(true);

    // Second pack (different id) also declares "shared" → effective-catalog clash.
    const secondSource = path.join(base, "source2");
    writeValidPack(secondSource, {
      manifestOverrides: { id: "com.example.other-pack", version: "1.0.0" },
      problemId: "shared",
    });

    const lockBefore = JSON.stringify(readLock(storeDir));
    const result = install({ sourceDir: secondSource });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("COMPOSE_CONFLICT");
    // Atomic rollback: the lock is byte-identical and the second snapshot is gone.
    expect(JSON.stringify(readLock(storeDir))).toBe(lockBefore);
    expect(fs.existsSync(path.join(storeDir, "snapshots", "com.example.other-pack"))).toBe(false);
  });

  it("should reject a pack whose required runtime is unavailable on the platform, leaving no residue", () => {
    writeValidPack(sourceDir, {
      manifestOverrides: { requiredRuntimes: [{ provider: "gcp", engine: "infra-manager" }] },
    });

    const result = install();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // A required runtime the platform cannot satisfy is rejected before activation.
    expect(["COMPOSE_CONFLICT", "INVALID_PACK"]).toContain(result.reason);
    expect(readLock(storeDir).packs).toEqual([]);
  });
});

describe("listInstalledPacks (#2094)", () => {
  it("should read pack id, version, digest, source kind, and problem count from lock+snapshot", () => {
    writeValidPack(sourceDir);
    const installed = install();
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;

    const list = listInstalledPacks(storeDir);

    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({
      packId: "com.example.cloud-pack",
      version: "1.2.3",
      contentDigest: installed.entry.contentDigest,
      sourceKind: "local",
      problemCount: 1,
    });
  });

  it("should never expose snapshot filesystem paths", () => {
    writeValidPack(sourceDir);
    install();

    const list = listInstalledPacks(storeDir);

    const serialized = JSON.stringify(list);
    expect(serialized).not.toContain("snapshot");
    expect(serialized).not.toContain(storeDir);
    expect(serialized).not.toContain(path.sep === "/" ? "/store" : "store");
  });

  it("should return an empty list for a fresh store", () => {
    expect(listInstalledPacks(storeDir)).toEqual([]);
  });
});

describe("inspectPack (#2094)", () => {
  it("should show manifest, digest, problem ids, required runtimes, and dependency status", () => {
    writeValidPack(sourceDir, {
      manifestOverrides: {
        dependencies: [{ id: "com.example.base", range: "^1.0.0" }],
      },
    });
    const installed = install();
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;

    const inspection = inspectPack(storeDir, "com.example.cloud-pack", "1.2.3");

    expect(inspection).toBeDefined();
    if (!inspection) return;
    expect(inspection.packId).toBe("com.example.cloud-pack");
    expect(inspection.version).toBe("1.2.3");
    expect(inspection.contentDigest).toBe(installed.entry.contentDigest);
    expect(inspection.sourceKind).toBe("local");
    expect(inspection.core).toBe("^1.0.0");
    expect(inspection.requiredRuntimes).toEqual([{ provider: "aws", engine: "cloudformation" }]);
    expect(inspection.problemIds).toEqual(["hello-world"]);
    // The declared dependency is unmet (not installed in this store).
    expect(inspection.dependencies).toEqual([
      { id: "com.example.base", range: "^1.0.0", satisfied: false },
    ]);
  });

  it("should mark a dependency satisfied when a matching pack is installed", () => {
    // Install the dependency target first.
    writeValidPack(sourceDir, {
      manifestOverrides: { id: "com.example.base", version: "1.4.0" },
      problemId: "base-problem",
    });
    install();

    // Install the dependent pack from a second source.
    const dependentSource = path.join(base, "dependent");
    writeValidPack(dependentSource, {
      manifestOverrides: {
        id: "com.example.app",
        version: "2.0.0",
        dependencies: [{ id: "com.example.base", range: "^1.0.0" }],
      },
      problemId: "app-problem",
    });
    install({ sourceDir: dependentSource });

    const inspection = inspectPack(storeDir, "com.example.app", "2.0.0");

    expect(inspection?.dependencies).toEqual([
      { id: "com.example.base", range: "^1.0.0", satisfied: true },
    ]);
  });

  it("should never expose snapshot filesystem paths", () => {
    writeValidPack(sourceDir);
    install();

    const inspection = inspectPack(storeDir, "com.example.cloud-pack", "1.2.3");

    const serialized = JSON.stringify(inspection);
    expect(serialized).not.toContain("snapshot");
    expect(serialized).not.toContain(storeDir);
  });

  it("should return undefined for an unknown pack", () => {
    writeValidPack(sourceDir);
    install();

    expect(inspectPack(storeDir, "com.example.cloud-pack", "9.9.9")).toBeUndefined();
    expect(inspectPack(storeDir, "com.example.nope", "1.2.3")).toBeUndefined();
  });
});

describe("removePack (#2094)", () => {
  it("should remove an unused revision and its lock entry atomically", () => {
    writeValidPack(sourceDir);
    const installed = install();
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    const snapshotAbs = path.join(storeDir, installed.entry.snapshotPath);
    expect(fs.existsSync(snapshotAbs)).toBe(true);

    const result = removePack(storeDir, "com.example.cloud-pack", "1.2.3", () => false);

    expect(result.ok).toBe(true);
    expect(readLock(storeDir).packs).toEqual([]);
    expect(fs.existsSync(snapshotAbs)).toBe(false);
  });

  it("should refuse to remove a revision that is pinned by an event/deployment/activation", () => {
    writeValidPack(sourceDir);
    const installed = install();
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    const snapshotAbs = path.join(storeDir, installed.entry.snapshotPath);

    // The pin predicate reports the revision is referenced.
    const result = removePack(storeDir, "com.example.cloud-pack", "1.2.3", () => true);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("PINNED");
    // Nothing was deleted: lock entry and snapshot survive.
    expect(readLock(storeDir).packs).toHaveLength(1);
    expect(fs.existsSync(snapshotAbs)).toBe(true);
  });

  it("should report NOT_FOUND for a revision that is not installed", () => {
    writeValidPack(sourceDir);
    install();

    const result = removePack(storeDir, "com.example.cloud-pack", "9.9.9", () => false);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("NOT_FOUND");
    expect(readLock(storeDir).packs).toHaveLength(1);
  });

  it("should pass the matching lock entry to the pin predicate", () => {
    writeValidPack(sourceDir);
    install();
    let seen: { packId: string; version: string } | undefined;

    removePack(storeDir, "com.example.cloud-pack", "1.2.3", (entry) => {
      seen = { packId: entry.packId, version: entry.version };
      return false;
    });

    expect(seen).toEqual({ packId: "com.example.cloud-pack", version: "1.2.3" });
  });
});
