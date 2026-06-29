/**
 * [Problem Packs / Issue #2089] The shipped minimal reference pack must validate.
 *
 * The reference pack lives at the repo top-level `packs/` directory — deliberately
 * OUTSIDE the core `problems/` catalog — so it is consumed as an external pack,
 * not imported from core. This test runs the REAL #2088 validator over the
 * checked-in directory and asserts zero diagnostics, guarding the example against
 * silent drift as the manifest / metadata contracts evolve.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { validatePackDirectory } from "../../lib/problem-pack/validate-pack";

/** Repo root is two levels up from `infrastructure/test`. */
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const REFERENCE_PACK_DIR = path.join(REPO_ROOT, "packs", "reference-aws-hello");

describe("reference pack (#2089)", () => {
  it("should live outside the core problems/ directory", () => {
    expect(fs.existsSync(REFERENCE_PACK_DIR)).toBe(true);
    expect(REFERENCE_PACK_DIR).not.toContain(`${path.sep}problems${path.sep}`);
  });

  it("should validate with zero diagnostics", () => {
    const result = validatePackDirectory(REFERENCE_PACK_DIR);

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.problemIds.length).toBeGreaterThan(0);
  });
});
