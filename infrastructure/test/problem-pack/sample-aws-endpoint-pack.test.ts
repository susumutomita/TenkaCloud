/**
 * The shipped minimal *reachable-endpoint* sample pack must validate and score.
 *
 * `sample-aws-endpoint` lives at the repo top-level `packs/` directory — outside
 * the core `problems/` catalog — so it is consumed as an external pack. Its deploy
 * body stands up a real, public Lambda Function URL (cfn-lint clean) and is scored
 * by `uptime-flat`, making it the smallest end-to-end deploy -> reachable-endpoint
 * -> uptime-score example and the verified AWS anchor for a future cross-cloud
 * composite. This test runs the real validator + the pack test-runner over the
 * checked-in directory so the example never drifts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { buildPackReport } from "@tenkacloud/problem-sdk";
import { runPackTests } from "@tenkacloud/problem-test";
import { describe, expect, it } from "vitest";
import { validatePackDirectory } from "../../lib/problem-pack/validate-pack";

/** Repo root is two levels up from `infrastructure/test`. */
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SAMPLE_PACK_DIR = path.join(REPO_ROOT, "packs", "sample-aws-endpoint");

describe("sample AWS reachable-endpoint pack", () => {
  it("should live outside the core problems/ directory", () => {
    expect(fs.existsSync(SAMPLE_PACK_DIR)).toBe(true);
    expect(SAMPLE_PACK_DIR).not.toContain(`${path.sep}problems${path.sep}`);
  });

  it("should validate with zero diagnostics", () => {
    const result = validatePackDirectory(SAMPLE_PACK_DIR);

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.problemIds).toEqual(["sample-uptime"]);
  });

  it("should produce a passing report through the reusable-workflow CLI contract", () => {
    const report = buildPackReport(SAMPLE_PACK_DIR);

    expect(report.result).toBe("passed");
    expect(report.diagnostics).toEqual([]);
    expect(report.packId).toBe("com.tenkacloud.sample-aws-endpoint");
    expect(report.packVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(report.contentDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("should pass its uptime scoring cases (200 -> success, unreachable -> failure)", () => {
    const result = runPackTests(SAMPLE_PACK_DIR);

    const failing = result.results.filter((r) => !r.passed);
    expect(failing, JSON.stringify(failing)).toEqual([]);
    expect(result.results.length).toBeGreaterThan(0);
  });
});
