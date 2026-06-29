/**
 * [Problem SDK / Issue #2106] Direct unit tests for the offline pack validator
 * and the safe-path boundary check — the durable public failure-branch contract.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isExistingDirectory, isInside, readDirNames, resolveInside } from "../src/safe-path.js";
import { PACK_MANIFEST_FILENAME, validatePackDirectory } from "../src/validate-pack.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function mkTemp(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tenkacloud-vp-"));
  tempDirs.push(root);
  return root;
}

const VALID_MANIFEST = {
  schemaVersion: 1,
  id: "com.example.pack",
  version: "1.0.0",
  core: "^1.0.0",
  title: "Pack",
  description: "A pack.",
  license: "Apache-2.0",
  problemsRoot: "problems",
  requiredRuntimes: [{ provider: "aws", engine: "cloudformation" }],
};

function writeManifest(root: string, overrides: Record<string, unknown> = {}): void {
  fs.writeFileSync(
    path.join(root, PACK_MANIFEST_FILENAME),
    JSON.stringify({ ...VALID_MANIFEST, ...overrides }),
  );
}

function writeProblem(root: string, id: string, metadata: Record<string, unknown>): string {
  const dir = path.join(root, "problems", "challenge", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify({ id, ...metadata }));
  return dir;
}

function codes(dir: string): string[] {
  return validatePackDirectory(dir).diagnostics.map((d) => d.code);
}

describe("validatePackDirectory: happy path", () => {
  it("should validate a well-formed single-problem pack with no diagnostics", () => {
    const root = mkTemp();
    writeManifest(root);
    const dir = writeProblem(root, "hello", {});
    fs.writeFileSync(path.join(dir, "template.yaml"), "Resources: {}\n");
    const result = validatePackDirectory(root);
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.problemIds).toEqual(["hello"]);
    expect(result.manifest?.id).toBe("com.example.pack");
  });
});

describe("validatePackDirectory: failure branches", () => {
  it("should report a missing pack directory", () => {
    expect(codes(path.join(os.tmpdir(), "does-not-exist-xyz"))).toContain("PACK_DIR_MISSING");
  });

  it("should report a missing manifest", () => {
    expect(codes(mkTemp())).toContain("MANIFEST_MISSING");
  });

  it("should report invalid manifest JSON", () => {
    const root = mkTemp();
    fs.writeFileSync(path.join(root, PACK_MANIFEST_FILENAME), "{ not json");
    expect(codes(root)).toContain("MANIFEST_INVALID");
  });

  it("should report a schema-invalid manifest", () => {
    const root = mkTemp();
    writeManifest(root, { version: "not-semver" });
    expect(codes(root)).toContain("MANIFEST_INVALID");
  });

  it("should report a problemsRoot traversal", () => {
    const root = mkTemp();
    writeManifest(root, { problemsRoot: "../escape" });
    expect(codes(root)).toContain("MANIFEST_INVALID");
  });

  it("should report a missing problemsRoot directory", () => {
    const root = mkTemp();
    writeManifest(root, { problemsRoot: "nonexistent" });
    expect(codes(root)).toContain("PROBLEMS_ROOT_MISSING");
  });

  it("should report invalid problem metadata JSON", () => {
    const root = mkTemp();
    writeManifest(root);
    const dir = path.join(root, "problems", "challenge", "broken");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "metadata.json"), "{ broken");
    expect(codes(root)).toContain("METADATA_INVALID");
  });

  it("should report duplicate problem ids", () => {
    const root = mkTemp();
    writeManifest(root);
    const a = path.join(root, "problems", "challenge", "a");
    const b = path.join(root, "problems", "challenge", "b");
    for (const dir of [a, b]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify({ id: "dup" }));
      fs.writeFileSync(path.join(dir, "template.yaml"), "Resources: {}\n");
    }
    expect(codes(root)).toContain("DUPLICATE_PROBLEM_ID");
  });

  it("should report a missing referenced artifact", () => {
    const root = mkTemp();
    writeManifest(root);
    writeProblem(root, "hello", {}); // no template.yaml written
    expect(codes(root)).toContain("ARTIFACT_MISSING");
  });

  it("should report a runtime not declared in requiredRuntimes", () => {
    const root = mkTemp();
    writeManifest(root);
    const dir = writeProblem(root, "azure-one", {
      runtime: { provider: "azure", engine: "bicep", entry: "main.bicep" },
    });
    fs.writeFileSync(path.join(dir, "main.bicep"), "// bicep\n");
    expect(codes(root)).toContain("RUNTIME_MISMATCH");
  });

  it("should report a malformed runtime declaration", () => {
    const root = mkTemp();
    writeManifest(root);
    writeProblem(root, "bad", { runtime: { provider: 1, engine: "x", entry: "y" } });
    expect(codes(root)).toContain("METADATA_INVALID");
  });
});

describe("safe-path", () => {
  it("should accept a relative path that stays inside the base", () => {
    const root = mkTemp();
    const resolved = resolveInside(root, "problems/challenge");
    expect(resolved).toBe(path.resolve(root, "problems/challenge"));
  });

  it("should reject an empty, absolute, or traversing path", () => {
    const root = mkTemp();
    expect(resolveInside(root, "")).toBeUndefined();
    expect(resolveInside(root, path.resolve("/etc/passwd"))).toBeUndefined();
    expect(resolveInside(root, "../escape")).toBeUndefined();
  });

  it("should reject a symlink that escapes the boundary", () => {
    const root = mkTemp();
    const outside = mkTemp();
    const linkPath = path.join(root, "link");
    try {
      fs.symlinkSync(outside, linkPath, "dir");
    } catch {
      return; // symlinks unsupported on this platform — skip
    }
    expect(resolveInside(root, "link/file.txt")).toBeUndefined();
  });

  it("should report directory containment, existence, and entries", () => {
    const root = mkTemp();
    fs.mkdirSync(path.join(root, "a"));
    fs.mkdirSync(path.join(root, "b"));
    fs.writeFileSync(path.join(root, "file.txt"), "x");
    expect(isInside(root, path.join(root, "a"))).toBe(true);
    expect(isInside(root, path.resolve(root, ".."))).toBe(false);
    expect(isExistingDirectory(path.join(root, "a"))).toBe(true);
    expect(isExistingDirectory(path.join(root, "file.txt"))).toBe(false);
    expect(readDirNames(root)).toEqual(["a", "b"]);
    expect(readDirNames(path.join(root, "missing"))).toEqual([]);
  });
});
