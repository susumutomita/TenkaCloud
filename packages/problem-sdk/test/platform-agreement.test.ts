/**
 * [Problem SDK / Issue #2106] One source of validation truth.
 *
 * `validateProblemMetadata` (the per-problem public entrypoint) and
 * `validatePackDirectory` (the offline pack validator the platform re-exports)
 * must agree on whether a given metadata object is accepted or rejected. They
 * share the same pure parsers, so any divergence here means the single source
 * fractured.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StatusCodes } from "http-status-codes";
import { afterEach, describe, expect, it } from "vitest";
import { validatePackDirectory, validateProblemMetadata } from "../src/index.js";
import {
  INVALID_METADATA_BAD_RUNTIME,
  INVALID_METADATA_BAD_SCORING,
  VALID_METADATA,
} from "./fixtures.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Build a minimal single-problem pack on disk around one metadata object. */
function makePackDir(metadata: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tenkacloud-pack-"));
  tempDirs.push(root);
  fs.writeFileSync(
    path.join(root, "tenkacloud-pack.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "com.example.agreement",
      version: "1.0.0",
      core: "^1.0.0",
      title: "Agreement Pack",
      description: "Agreement test pack.",
      license: "Apache-2.0",
      problemsRoot: "problems",
      requiredRuntimes: [{ provider: "aws", engine: "cloudformation" }],
    }),
  );
  const problemDir = path.join(root, "problems", "challenge", String(metadata.id ?? "problem"));
  fs.mkdirSync(problemDir, { recursive: true });
  fs.writeFileSync(path.join(problemDir, "metadata.json"), JSON.stringify(metadata));
  // The default runtime references template.yaml; provide it so artifact checks pass.
  fs.writeFileSync(path.join(problemDir, "template.yaml"), "Resources: {}\n");
  return root;
}

/** Does the pack validator flag a problem-metadata problem for this metadata? */
function packRejectsMetadata(metadata: Record<string, unknown>): boolean {
  const result = validatePackDirectory(makePackDir(metadata));
  return result.diagnostics.some(
    (d) => d.code === "METADATA_INVALID" || d.code === "RUNTIME_MISMATCH",
  );
}

/** Does the public per-problem validator reject this metadata? */
function sdkRejectsMetadata(metadata: Record<string, unknown>): boolean {
  return validateProblemMetadata(metadata).length > 0;
}

describe("SDK and platform pack validation agree", () => {
  it("should validate the same valid and invalid metadata fixtures as platform validation", () => {
    const cases: Record<string, unknown>[] = [
      { ...VALID_METADATA },
      { ...INVALID_METADATA_BAD_SCORING },
      { ...INVALID_METADATA_BAD_RUNTIME },
    ];
    for (const metadata of cases) {
      expect(sdkRejectsMetadata(metadata)).toBe(packRejectsMetadata(metadata));
    }
  });

  it("should preserve legacy core metadata validation behavior", () => {
    // A legacy `kind: "uptime"` scoring section (Phase 1 alias) is still accepted.
    const legacy = {
      id: "legacy-uptime",
      scoring: {
        kind: "uptime",
        pointsPerSuccess: 10,
        endpoints: [{ slot: "web", path: "/health", expectStatus: [StatusCodes.OK] }],
      },
    };
    expect(validateProblemMetadata(legacy)).toEqual([]);
    expect(packRejectsMetadata(legacy)).toBe(false);
  });

  it("should accept a valid pack directory with no diagnostics", () => {
    const result = validatePackDirectory(makePackDir({ ...VALID_METADATA }));
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.problemIds).toContain("hello-world");
  });
});
