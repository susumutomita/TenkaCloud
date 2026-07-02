/**
 * The shipped hello-multicloud sample pack must validate and score.
 *
 * `hello-multicloud` is the hello-world of Composite Runtime: one Challenge
 * with an AWS (cloudformation) target and a GCP (infra-manager) target, scored
 * by composite-probe against both. This test runs the real pack validator, the
 * reusable-workflow report CLI contract, and the declarative scoring cases over
 * the checked-in directory so the smallest composite example never drifts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { buildPackReport } from "@tenkacloud/problem-sdk";
import { runPackTests } from "@tenkacloud/problem-test";
import { describe, expect, it } from "vitest";
import { validatePackDirectory } from "../../lib/problem-pack/validate-pack";

/** Repo root is two levels up from `infrastructure/test`. */
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const PACK_DIR = path.join(REPO_ROOT, "packs", "hello-multicloud");
const PROBLEM_DIR = path.join(PACK_DIR, "problems", "challenges", "hello-multicloud");

describe("hello-multicloud sample pack", () => {
  it("should live outside the core problems/ directory", () => {
    expect(fs.existsSync(PACK_DIR)).toBe(true);
    expect(PACK_DIR).not.toContain(`${path.sep}problems${path.sep}`);
  });

  it("should validate with zero diagnostics", () => {
    const result = validatePackDirectory(PACK_DIR);

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.problemIds).toEqual(["hello-multicloud"]);
  });

  it("should produce a passing report through the reusable-workflow CLI contract", () => {
    const report = buildPackReport(PACK_DIR);

    expect(report.result).toBe("passed");
    expect(report.diagnostics).toEqual([]);
    expect(report.packId).toBe("com.tenkacloud.hello-multicloud");
    expect(report.packVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(report.contentDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("should pass its composite scoring cases (both up -> success, one down -> failure)", () => {
    const result = runPackTests(PACK_DIR);

    const failing = result.results.filter((r) => !r.passed);
    expect(failing, JSON.stringify(failing)).toEqual([]);
    expect(result.results.length).toBeGreaterThan(0);
  });

  it("should keep the AWS body at the problem root for the live CFn path", () => {
    // deploy-battles.sh always deploys `<problemDir>/template.yaml` and ignores
    // the composite target's entry, so the aws-hello entry must stay `template.yaml`
    // at the problem root (see the pack README's known-gaps section).
    expect(fs.existsSync(path.join(PROBLEM_DIR, "template.yaml"))).toBe(true);

    const metadata = JSON.parse(fs.readFileSync(path.join(PROBLEM_DIR, "metadata.json"), "utf-8"));
    const awsTarget = metadata.runtime.targets.find((t: { id: string }) => t.id === "aws-hello");
    expect(awsTarget?.entry).toBe("template.yaml");
  });

  it("should declare exactly the adapter-injected terraform variables without defaults", () => {
    // The GCP adapter injects tenkacloud_name_prefix / tenkacloud_problem_id /
    // tenkacloud_team on every deploy; the module must declare them, and any
    // other variable must carry a default or Infra Manager cannot apply it.
    const tf = fs.readFileSync(path.join(PROBLEM_DIR, "gcp", "terraform", "main.tf"), "utf-8");
    for (const name of ["tenkacloud_name_prefix", "tenkacloud_problem_id", "tenkacloud_team"]) {
      expect(tf).toContain(`variable "${name}"`);
    }
    // Every non-injected variable block must have a default.
    const variableBlocks = tf.match(/variable "([a-z0-9_]+)" \{[\s\S]*?\n\}/g) ?? [];
    for (const block of variableBlocks) {
      const name = block.match(/variable "([a-z0-9_]+)"/)?.[1] ?? "";
      if (name.startsWith("tenkacloud_")) continue;
      expect(block, `variable ${name} must have a default`).toContain("default");
    }
  });
});
