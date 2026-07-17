import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LITE_DRILL_CHECKPOINTS } from "@tenkacloud/portal-contracts";
import { describe, expect, it } from "vitest";

/**
 * Issue #2696: the "Deploy your own TenkaCloud Lite" onboarding drill scores its first
 * step ("launcher created") with a fixed checkpoint code the learner copies from the
 * launcher stack's CloudFormation Outputs tab. The submission side (the landing demo
 * portal fixture) validates against the lite-drill contract in
 * `packages/portal-contracts`, so the emitted value here must stay byte-identical to
 * that contract — this suite fails on any drift in either direction.
 *
 * Assertion style follows lite-pipeline-interface.test.ts: block extraction over the
 * raw file text (the template's CFn intrinsic tags rule out a plain YAML.parse).
 */
const template = readFileSync(
  join(__dirname, "..", "..", "templates", "lite-pipeline.yaml"),
  "utf8",
);

function outputsBlock(): string {
  const block = template.match(/\nOutputs:\n([\s\S]*)$/)?.[1];
  if (!block) throw new Error("Outputs block not found in lite-pipeline.yaml");
  return block;
}

describe("lite-pipeline onboarding drill checkpoint (#2696)", () => {
  it("should expose the launcher-created checkpoint code as a stack output", () => {
    const outputs = outputsBlock();
    expect(outputs).toContain("OnboardingDrillCheckpoint:");
    expect(outputs).toContain(`Value: ${LITE_DRILL_CHECKPOINTS.launcherCreated.code}`);
  });

  it("should tell the learner where to submit the code in the output description", () => {
    const outputs = outputsBlock();
    const description = outputs.match(
      /OnboardingDrillCheckpoint:\n\s+Description: >-\n([\s\S]*?)\n\s+Value:/,
    )?.[1];
    expect(description).toBeTruthy();
    expect(description).toContain("Deploy your own TenkaCloud");
    expect(description).toContain("demo portal");
  });
});
