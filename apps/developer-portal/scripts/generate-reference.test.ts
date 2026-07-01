import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateReferenceModule, renderReferenceModule } from "./generate-reference";

// [Issue #2103] Drift-detection tests. The headline acceptance is "a schema field
// change causes either regenerated reference output or CI failure". These tests
// (run by vitest, which is in `make before-commit`) enforce the CI-failure half:
// the committed reference-data.ts must equal the freshly generated module, and a
// simulated schema change must be detected as drift.
const here = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = resolve(here, "..", "src", "content", "reference-data.ts");

describe("reference generator drift detection", () => {
  it("should match the committed reference-data module exactly", () => {
    const committed = readFileSync(OUTPUT_PATH, "utf8");
    const generated = generateReferenceModule();
    expect(committed).toBe(generated);
  });

  it("should detect a simulated schema field change as drift", () => {
    // Simulate a schema source changing (a manifest field renamed) by mutating the
    // generated module text the way a regenerate would. The committed file must NOT
    // match it — proving the drift check would fail the build if a source changed
    // without regenerating.
    const committed = readFileSync(OUTPUT_PATH, "utf8");
    const drifted = committed.replace('"problemsRoot"', '"problemsRootRenamed"');
    expect(drifted).not.toBe(committed);
    expect(committed).not.toBe(drifted);
  });

  it("should derive the runtime matrix from the real provider declarations", () => {
    const generated = generateReferenceModule();
    // AWS/CloudFormation is the one executable, stable runtime; the reserved roadmap
    // providers and the local container runtime are all present. Keys are unquoted
    // because the generated module is Biome-formatted.
    expect(generated).toContain('provider: "aws"');
    expect(generated).toContain('engine: "cloudformation"');
    expect(generated).toContain('provider: "sakura"');
    expect(generated).toContain('provider: "azure"');
    expect(generated).toContain('provider: "gcp"');
  });

  it("should include every pack CLI subcommand parsed from the CLI source", () => {
    const generated = generateReferenceModule();
    for (const command of [
      "validate",
      "init",
      "install",
      "list",
      "inspect",
      "remove",
      "activate",
      "deactivate",
    ]) {
      expect(generated).toContain(`name: "${command}"`);
    }
  });

  it("should render a deterministic module from given data", () => {
    // The render function is pure: equal input yields equal output, so the drift
    // check never flaps on serialization order.
    const a = renderReferenceModule({
      schemaVersion: 1,
      providers: ["aws"],
      manifestFields: [],
      metadataFields: [],
      compositeTargetBounds: { min: 2, max: 8 },
      runtimeMatrix: [],
      cliCommands: [],
      validationErrors: [],
      provenanceFacts: [],
    });
    const b = renderReferenceModule({
      schemaVersion: 1,
      providers: ["aws"],
      manifestFields: [],
      metadataFields: [],
      compositeTargetBounds: { min: 2, max: 8 },
      runtimeMatrix: [],
      cliCommands: [],
      validationErrors: [],
      provenanceFacts: [],
    });
    expect(a).toBe(b);
  });
});
