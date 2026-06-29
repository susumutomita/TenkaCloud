/**
 * [Problem Packs / Issue #2089] Tests for `tenkacloud pack init`.
 *
 * `init` scaffolds a fresh, validator-passing problem pack into an empty target
 * directory. The suite drives the REAL scaffolder over OS temp dirs (no FS
 * mocks) and then runs the REAL #2088 validator over the result, so the
 * "generated pack validates with zero diagnostics" guarantee is exercised
 * end-to-end. Output must be deterministic: no timestamp, no random bytes, no
 * `generatedAt` field — re-running into a fresh dir yields byte-identical files.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildPackScaffold,
  type PackInitRuntime,
  SCAFFOLD_RUNTIMES,
  writePackScaffold,
} from "../../lib/problem-pack/init-pack";
import {
  PACK_MANIFEST_FILENAME,
  validatePackDirectory,
} from "../../lib/problem-pack/validate-pack";

let targetRoot: string;

beforeEach(() => {
  // mkdtemp under the OS temp dir guarantees the scaffold target lives outside the core repo.
  targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tenkacloud-pack-init-"));
});

afterEach(() => {
  fs.rmSync(targetRoot, { recursive: true, force: true });
});

/** Read every file the scaffolder produced under `dir`, keyed by pack-relative POSIX path. */
function readTree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else {
        const rel = path.relative(dir, abs).split(path.sep).join("/");
        out.set(rel, fs.readFileSync(abs, "utf-8"));
      }
    }
  };
  walk(dir);
  return out;
}

describe("buildPackScaffold (#2089)", () => {
  it("should default to the aws/cloudformation runtime when none is given", () => {
    const files = buildPackScaffold({ packId: "com.example.starter" });

    const manifest = JSON.parse(files.get(PACK_MANIFEST_FILENAME) as string);
    expect(manifest.requiredRuntimes).toEqual([{ provider: "aws", engine: "cloudformation" }]);
  });

  it("should produce byte-identical files for identical options (no timestamp / random)", () => {
    const first = buildPackScaffold({ packId: "com.example.starter" });
    const second = buildPackScaffold({ packId: "com.example.starter" });

    expect([...second.entries()]).toEqual([...first.entries()]);
  });

  it("should never emit a generatedAt field or an ISO timestamp anywhere", () => {
    const files = buildPackScaffold({
      packId: "com.example.starter",
      runtime: "gcp/infra-manager",
    });

    for (const content of files.values()) {
      expect(content).not.toContain("generatedAt");
      // No ISO-8601 timestamp (e.g. 2026-06-29T...): the scaffold must be time-free.
      expect(content).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    }
  });

  it("should reject a pack id that is not reverse-DNS style", () => {
    expect(() => buildPackScaffold({ packId: "NotADnsId" })).toThrow(/reverse-DNS/i);
  });

  it("should reject an unsupported runtime", () => {
    expect(() =>
      buildPackScaffold({ packId: "com.example.starter", runtime: "aws/sam" as PackInitRuntime }),
    ).toThrow(/unsupported runtime/i);
  });
});

describe("writePackScaffold (#2089) — validator-passing output", () => {
  it("should scaffold an aws pack that validates with zero diagnostics", () => {
    writePackScaffold(targetRoot, { packId: "com.example.starter" });

    const result = validatePackDirectory(targetRoot);

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.problemIds.length).toBe(1);
  });

  it.each(
    SCAFFOLD_RUNTIMES,
  )("should scaffold a %s pack that validates with zero diagnostics", (runtime) => {
    writePackScaffold(targetRoot, { packId: "com.example.starter", runtime });

    const result = validatePackDirectory(targetRoot);

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it.each(
    SCAFFOLD_RUNTIMES,
  )("should write the right provider artifact placeholder for %s", (runtime) => {
    writePackScaffold(targetRoot, { packId: "com.example.starter", runtime });

    const tree = readTree(targetRoot);
    const artifact = ARTIFACT_BY_RUNTIME[runtime];
    const hasArtifact = [...tree.keys()].some((rel) => rel.endsWith(`/${artifact}`));
    expect(hasArtifact).toBe(true);
  });

  it("should declare the chosen runtime in both the manifest and the problem metadata", () => {
    writePackScaffold(targetRoot, { packId: "com.example.starter", runtime: "azure/bicep" });

    const tree = readTree(targetRoot);
    const manifest = JSON.parse(tree.get(PACK_MANIFEST_FILENAME) as string);
    expect(manifest.requiredRuntimes).toEqual([{ provider: "azure", engine: "bicep" }]);
    const metadataEntry = [...tree.entries()].find(([rel]) => rel.endsWith("metadata.json"));
    const metadata = JSON.parse(metadataEntry?.[1] as string);
    expect(metadata.runtime).toMatchObject({ provider: "azure", engine: "bicep" });
  });

  it("should ship a README covering validate, test, version, and publish steps", () => {
    writePackScaffold(targetRoot, { packId: "com.example.starter" });

    const readme = fs.readFileSync(path.join(targetRoot, "README.md"), "utf-8").toLowerCase();
    expect(readme).toContain("validate");
    expect(readme).toContain("test");
    expect(readme).toContain("version");
    expect(readme).toContain("publish");
  });

  it("should not write any cloud credentials or generated secrets", () => {
    writePackScaffold(targetRoot, { packId: "com.example.starter" });

    for (const content of readTree(targetRoot).values()) {
      expect(content).not.toMatch(/AKIA[0-9A-Z]{16}/); // AWS access key id
      expect(content).not.toMatch(/aws_secret_access_key/i);
      expect(content).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
    }
  });

  it("should refuse to scaffold into a non-empty directory", () => {
    fs.writeFileSync(path.join(targetRoot, "existing.txt"), "do not clobber me");

    expect(() => writePackScaffold(targetRoot, { packId: "com.example.starter" })).toThrow(
      /not empty/i,
    );
    // The pre-existing file must be left untouched.
    expect(fs.readFileSync(path.join(targetRoot, "existing.txt"), "utf-8")).toBe(
      "do not clobber me",
    );
  });

  it("should refuse an unsafe target whose path contains a parent-traversal segment", () => {
    // Pass the raw, un-normalized string a user would type: the '..' segment is
    // literally present and must be rejected before any write.
    expect(() =>
      writePackScaffold(`${targetRoot}/../escape`, { packId: "com.example.starter" }),
    ).toThrow(/unsafe|traversal/i);
  });

  it("should create the target directory when it does not yet exist", () => {
    const nested = path.join(targetRoot, "fresh-pack");

    writePackScaffold(nested, { packId: "com.example.starter" });

    expect(validatePackDirectory(nested).ok).toBe(true);
  });
});

/** Expected provider artifact placeholder filename per supported runtime. */
const ARTIFACT_BY_RUNTIME: Record<PackInitRuntime, string> = {
  "aws/cloudformation": "template.yaml",
  "gcp/infra-manager": "main.tf",
  "azure/bicep": "main.bicep",
  "sakura/apprun": "apprun.yaml",
};
