/**
 * [#2195] The reference coordination Battle pack must validate.
 *
 * Companion to `reference-pack.test.ts`: the coordination reference pack lives at
 * the repo top-level `packs/` directory — OUTSIDE the core `problems/` catalog —
 * and opts into inter-team coordination via `interTeamCoordination`.
 * This runs the REAL #2088 validator over the checked-in directory and asserts
 * zero diagnostics, guarding the worked example against silent drift as the
 * manifest / metadata contracts evolve.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { buildPackReport } from "@tenkacloud/problem-sdk";
import { describe, expect, it } from "vitest";
import { validatePackDirectory } from "../../lib/problem-pack/validate-pack";

/** Repo root is two levels up from `infrastructure/test`. */
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const PACK_DIR = path.join(REPO_ROOT, "packs", "reference-coordination-battle");

describe("reference coordination Battle pack (#2195)", () => {
  it("should live outside the core problems/ directory", () => {
    expect(fs.existsSync(PACK_DIR)).toBe(true);
    expect(PACK_DIR).not.toContain(`${path.sep}problems${path.sep}`);
  });

  it("should validate with zero diagnostics", () => {
    const result = validatePackDirectory(PACK_DIR);

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.problemIds).toContain("cross-account-capture");
  });

  it("should declare its coordination plugin file on disk", () => {
    const pluginPath = path.join(
      PACK_DIR,
      "problems",
      "battles",
      "cross-account-capture",
      "coordination",
      "sector-control.ts",
    );
    expect(fs.existsSync(pluginPath)).toBe(true);

    const metadata = JSON.parse(
      fs.readFileSync(
        path.join(PACK_DIR, "problems", "battles", "cross-account-capture", "metadata.json"),
        "utf8",
      ),
    );
    expect(metadata.interTeamCoordination.plugin).toBe("coordination/sector-control.ts");
  });

  it("should produce a passing report through the pack report contract", () => {
    const report = buildPackReport(PACK_DIR);

    expect(report.result).toBe("passed");
    expect(report.diagnostics).toEqual([]);
    expect(report.packId).toBe("com.tenkacloud.reference-coordination-battle");
    expect(report.contentDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});
