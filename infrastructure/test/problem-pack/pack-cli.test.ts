/**
 * [Problem Packs / Issue #2088] Tests for the thin `pack validate` CLI layer.
 *
 * The CLI is a pure function over (args, packReader) that returns an exit code
 * plus rendered stdout — no process spawning, so the suite stays deterministic
 * and offline. Exit-code contract: 0 valid, 1 validation failure, 2 tool failure.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPackCli } from "../../lib/problem-pack/pack-cli";

let packRoot: string;

beforeEach(() => {
  packRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tenkacloud-pack-cli-"));
});

afterEach(() => {
  fs.rmSync(packRoot, { recursive: true, force: true });
});

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

function writeValidPack(): void {
  fs.writeFileSync(
    path.join(packRoot, "tenkacloud-pack.json"),
    JSON.stringify(validManifest(), null, 2),
  );
  const dir = path.join(packRoot, "problems", "challenges", "hello-world");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify({ id: "hello-world" }));
  fs.writeFileSync(path.join(dir, "template.yaml"), "Resources: {}\n");
}

describe("runPackCli (#2088)", () => {
  it("should exit 0 and print a success line for a valid pack", () => {
    writeValidPack();
    const out: string[] = [];

    const code = runPackCli(["validate", packRoot], (line) => out.push(line));

    expect(code).toBe(0);
    expect(out.join("\n")).toContain("hello-world");
  });

  it("should print machine-readable JSON when --json is passed", () => {
    writeValidPack();
    const out: string[] = [];

    const code = runPackCli(["validate", packRoot, "--json"], (line) => out.push(line));

    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed.ok).toBe(true);
    expect(parsed.diagnostics).toEqual([]);
  });

  it("should exit 1 on a validation failure", () => {
    fs.writeFileSync(path.join(packRoot, "tenkacloud-pack.json"), JSON.stringify(validManifest()));
    const dir = path.join(packRoot, "problems", "challenges", "a");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "metadata.json"),
      JSON.stringify({ id: "x", cfnTemplate: "../escape" }),
    );
    const out: string[] = [];

    const code = runPackCli(["validate", packRoot, "--json"], (line) => out.push(line));

    expect(code).toBe(1);
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed.ok).toBe(false);
    expect(parsed.diagnostics.map((d: { code: string }) => d.code)).toContain("ARTIFACT_TRAVERSAL");
  });

  it("should exit 2 when the manifest is missing (tool failure)", () => {
    const out: string[] = [];

    const code = runPackCli(["validate", packRoot], (line) => out.push(line));

    expect(code).toBe(2);
    expect(out.join("\n")).toContain("MANIFEST_MISSING");
  });

  it("should exit 2 when no subcommand is given", () => {
    const out: string[] = [];

    const code = runPackCli([], (line) => out.push(line));

    expect(code).toBe(2);
    expect(out.join("\n").toLowerCase()).toContain("usage");
  });

  it("should exit 2 when validate has no directory argument", () => {
    const out: string[] = [];

    const code = runPackCli(["validate"], (line) => out.push(line));

    expect(code).toBe(2);
    expect(out.join("\n").toLowerCase()).toContain("usage");
  });
});
