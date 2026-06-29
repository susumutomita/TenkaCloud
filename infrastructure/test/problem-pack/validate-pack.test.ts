/**
 * [Problem Packs / Issue #2088] Tests for the standalone, offline pack validator.
 *
 * These tests drive the REAL validator over temp fixture directories created on
 * the actual filesystem (no FS mocks). The validator does NO CDK synth, no cloud
 * credentials, and no network — so the suite is deterministic and self-contained.
 *
 * A fixture pack is built into an OS temp dir (NOT inside the core repo) so the
 * "runs from outside the core repo" guarantee is exercised by construction.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validatePackDirectory } from "../../lib/problem-pack/validate-pack";

let packRoot: string;

beforeEach(() => {
  // mkdtemp under the OS temp dir guarantees the pack lives outside the core repo.
  packRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tenkacloud-pack-validate-"));
});

afterEach(() => {
  fs.rmSync(packRoot, { recursive: true, force: true });
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

function writeManifest(manifest: unknown): void {
  fs.writeFileSync(path.join(packRoot, "tenkacloud-pack.json"), JSON.stringify(manifest, null, 2));
}

/** Sentinel: pass this as `template` to suppress writing any deploy body. */
const NO_TEMPLATE = Symbol("no-template");

/** Resolve the deploy-body entry filename a problem references (runtime.entry / cfnTemplate / default). */
function entryFilenameOf(metadata: Record<string, unknown>): string {
  const runtime = metadata.runtime;
  if (
    runtime &&
    typeof runtime === "object" &&
    typeof (runtime as { entry?: unknown }).entry === "string"
  ) {
    return (runtime as { entry: string }).entry;
  }
  return typeof metadata.cfnTemplate === "string" ? metadata.cfnTemplate : "template.yaml";
}

/**
 * Write a problem under `<problemsRoot>/<category>/<dir>/`. By default an actual
 * deploy-body file is written at the referenced entry path so artifact-existence
 * checks pass for valid fixtures. Pass `NO_TEMPLATE` to skip writing the body
 * (used to exercise traversal / missing-artifact cases).
 */
function writeProblem(
  problemsRoot: string,
  category: string,
  dir: string,
  metadata: Record<string, unknown>,
  template: string | typeof NO_TEMPLATE = "# CFn deploy body\nResources: {}\n",
): void {
  const target = path.join(packRoot, problemsRoot, category, dir);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "metadata.json"), JSON.stringify(metadata, null, 2));
  if (template !== NO_TEMPLATE) {
    fs.writeFileSync(path.join(target, entryFilenameOf(metadata)), template);
  }
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

describe("validatePackDirectory (#2088)", () => {
  it("should accept a valid minimal pack and report ok", () => {
    writeManifest(validManifest());
    writeProblem("problems", "challenges", "hello-world", awsProblem("hello-world"));

    const result = validatePackDirectory(packRoot);

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.problemIds).toEqual(["hello-world"]);
  });

  it("should accept a four-provider pack (aws/gcp/azure/sakura)", () => {
    const manifest = validManifest();
    manifest.requiredRuntimes = [
      { provider: "aws", engine: "cloudformation" },
      { provider: "gcp", engine: "infra-manager" },
      { provider: "azure", engine: "bicep" },
      { provider: "sakura", engine: "apprun" },
    ];
    writeManifest(manifest);
    writeProblem("problems", "challenges", "aws-p", {
      id: "aws-p",
      runtime: { provider: "aws", engine: "cloudformation", entry: "template.yaml" },
    });
    writeProblem("problems", "challenges", "gcp-p", {
      id: "gcp-p",
      runtime: { provider: "gcp", engine: "infra-manager", entry: "main.yaml" },
    });
    writeProblem("problems", "challenges", "azure-p", {
      id: "azure-p",
      runtime: { provider: "azure", engine: "bicep", entry: "main.bicep" },
    });
    writeProblem("problems", "challenges", "sakura-p", {
      id: "sakura-p",
      runtime: { provider: "sakura", engine: "apprun", entry: "apprun.yaml" },
    });

    const result = validatePackDirectory(packRoot);

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.problemIds).toEqual(["aws-p", "azure-p", "gcp-p", "sakura-p"]);
  });

  it("should reject a missing manifest as a tool failure", () => {
    // No manifest written.
    const result = validatePackDirectory(packRoot);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain("MANIFEST_MISSING");
  });

  it("should reject a missing pack directory as a tool failure", () => {
    const result = validatePackDirectory(path.join(packRoot, "does-not-exist"));

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain("PACK_DIR_MISSING");
  });

  it("should report MANIFEST_INVALID for a manifest that fails the schema", () => {
    const manifest = validManifest();
    manifest.id = "NotReverseDNS";
    writeManifest(manifest);
    writeProblem("problems", "challenges", "hello-world", awsProblem("hello-world"));

    const result = validatePackDirectory(packRoot);

    expect(result.ok).toBe(false);
    const invalid = result.diagnostics.filter((d) => d.code === "MANIFEST_INVALID");
    expect(invalid.length).toBeGreaterThan(0);
    expect(invalid[0]?.file).toBe("tenkacloud-pack.json");
    expect(invalid.map((d) => d.path)).toContain("id");
  });

  it("should report DUPLICATE_PROBLEM_ID when two problems share an id", () => {
    writeManifest(validManifest());
    writeProblem("problems", "challenges", "dir-a", awsProblem("dupe"));
    writeProblem("problems", "challenges", "dir-b", awsProblem("dupe"));

    const result = validatePackDirectory(packRoot);

    expect(result.ok).toBe(false);
    const dupes = result.diagnostics.filter((d) => d.code === "DUPLICATE_PROBLEM_ID");
    expect(dupes.length).toBeGreaterThan(0);
  });

  it("should report METADATA_INVALID for malformed metadata json", () => {
    writeManifest(validManifest());
    const target = path.join(packRoot, "problems", "challenges", "broken");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "metadata.json"), "{ not valid json");

    const result = validatePackDirectory(packRoot);

    expect(result.ok).toBe(false);
    const bad = result.diagnostics.filter((d) => d.code === "METADATA_INVALID");
    expect(bad.length).toBeGreaterThan(0);
    expect(bad[0]?.file).toBe(path.join("problems", "challenges", "broken", "metadata.json"));
  });

  it("should report METADATA_INVALID when the metadata id is missing", () => {
    writeManifest(validManifest());
    writeProblem("problems", "challenges", "noid", { title: "no id here" });

    const result = validatePackDirectory(packRoot);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain("METADATA_INVALID");
  });

  it("should report ARTIFACT_TRAVERSAL when cfnTemplate escapes the pack root", () => {
    writeManifest(validManifest());
    writeProblem(
      "problems",
      "challenges",
      "evil",
      { id: "evil", cfnTemplate: "../../etc/passwd" },
      NO_TEMPLATE,
    );

    const result = validatePackDirectory(packRoot);

    expect(result.ok).toBe(false);
    const traversal = result.diagnostics.filter((d) => d.code === "ARTIFACT_TRAVERSAL");
    expect(traversal.length).toBeGreaterThan(0);
    expect(traversal[0]?.path).toBe("cfnTemplate");
  });

  it("should report ARTIFACT_TRAVERSAL when cfnTemplate is an absolute path", () => {
    writeManifest(validManifest());
    writeProblem(
      "problems",
      "challenges",
      "abs",
      { id: "abs", cfnTemplate: "/etc/passwd" },
      NO_TEMPLATE,
    );

    const result = validatePackDirectory(packRoot);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain("ARTIFACT_TRAVERSAL");
  });

  it("should report ARTIFACT_TRAVERSAL when a symlink escapes the pack root", () => {
    writeManifest(validManifest());
    const target = path.join(packRoot, "problems", "challenges", "linky");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(
      path.join(target, "metadata.json"),
      JSON.stringify({ id: "linky", cfnTemplate: "template.yaml" }),
    );
    // The deploy body is a symlink pointing outside the pack root.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
    const secret = path.join(outside, "secret.yaml");
    fs.writeFileSync(secret, "secret");
    fs.symlinkSync(secret, path.join(target, "template.yaml"));

    const result = validatePackDirectory(packRoot);

    fs.rmSync(outside, { recursive: true, force: true });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain("ARTIFACT_TRAVERSAL");
  });

  it("should report RUNTIME_MISMATCH when a problem uses an undeclared runtime", () => {
    // Manifest declares only aws/cloudformation, but the problem uses gcp.
    writeManifest(validManifest());
    writeProblem("problems", "challenges", "gcp-p", {
      id: "gcp-p",
      runtime: { provider: "gcp", engine: "infra-manager", entry: "main.yaml" },
    });

    const result = validatePackDirectory(packRoot);

    expect(result.ok).toBe(false);
    const mismatch = result.diagnostics.filter((d) => d.code === "RUNTIME_MISMATCH");
    expect(mismatch.length).toBeGreaterThan(0);
    expect(mismatch[0]?.message).toContain("gcp");
  });

  it("should produce byte-identical sorted JSON for the same input", () => {
    const build = (): string => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenkacloud-pack-stable-"));
      const manifestPath = path.join(dir, "tenkacloud-pack.json");
      const manifest = validManifest();
      manifest.id = "NotReverseDNS"; // force several deterministic diagnostics
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      // Two duplicate-id problems written in a fixed order.
      for (const [cat, name] of [
        ["challenges", "b-dir"],
        ["challenges", "a-dir"],
      ]) {
        const t = path.join(dir, "problems", cat, name);
        fs.mkdirSync(t, { recursive: true });
        fs.writeFileSync(path.join(t, "metadata.json"), JSON.stringify({ id: "dupe" }));
        fs.writeFileSync(path.join(t, "template.yaml"), "Resources: {}\n");
      }
      const result = validatePackDirectory(dir);
      fs.rmSync(dir, { recursive: true, force: true });
      return JSON.stringify(result.diagnostics);
    };

    expect(build()).toBe(build());
  });

  it("should run from a pack directory outside the core repo", () => {
    // packRoot is already under os.tmpdir(); assert that explicitly.
    expect(packRoot.startsWith(os.tmpdir())).toBe(true);
    writeManifest(validManifest());
    writeProblem("problems", "challenges", "hello-world", awsProblem("hello-world"));

    const result = validatePackDirectory(packRoot);

    expect(result.ok).toBe(true);
  });
});
