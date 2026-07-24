import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LITE_CLEANUP_DRILL_CHECKPOINT,
  LITE_DRILL_CHECKPOINTS,
} from "@tenkacloud/portal-contracts";
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

  it("should print the cleanup checkpoint only after complete teardown succeeds", () => {
    const destroyAllAt = template.indexOf(
      `TENKACLOUD_LITE_DOWN_YES=1 make destroy-all ENV="\${ENVIRONMENT}"`,
    );
    const checkpointAt = template.indexOf(LITE_CLEANUP_DRILL_CHECKPOINT.code);
    const deployBranchAt = template.indexOf("make deploy ENV");

    expect(destroyAllAt).toBeGreaterThan(-1);
    expect(checkpointAt).toBeGreaterThan(destroyAllAt);
    expect(checkpointAt).toBeLessThan(deployBranchAt);
  });

  it("should expose destroy-all as an explicit non-default action", () => {
    const actionBlock = template.match(/ {2}Action:\n[\s\S]*?\n\n/)?.[0];
    expect(actionBlock).toBeTruthy();
    expect(actionBlock).toContain("Default: deploy");
    expect(actionBlock).toContain("- destroy");
    expect(actionBlock).toContain("- destroy-all");
  });

  it("should fail closed when a CodeBuild override supplies an unsupported action", () => {
    expect(template).toContain(`elif [ "\${ACTION}" = "deploy" ]; then`);
    expect(template).toContain(`echo "Unsupported ACTION: \${ACTION}"`);
    expect(template).not.toMatch(/else\n\s+# `make deploy`/);
  });

  it("should manage the launcher CodeBuild log group with delete-on-stack-removal", () => {
    expect(template).toMatch(
      /LauncherLogGroup:\n\s+Type: AWS::Logs::LogGroup\n\s+DeletionPolicy: Delete\n\s+UpdateReplacePolicy: Delete/,
    );
    expect(template).toMatch(
      /LogGroupName: !Sub \/tenkacloud\/codebuild\/lite-launcher-\$\{Environment\}/,
    );
    const logsConfig = template.match(/ {6}LogsConfig:\n[\s\S]*?TimeoutInMinutes:/)?.[0];
    expect(logsConfig).toBeTruthy();
    expect(logsConfig).toMatch(/GroupName: !Ref LauncherLogGroup/);
    expect(logsConfig).not.toMatch(
      /GroupName: !Sub \/aws\/codebuild\/tenkacloud-lite-\$\{Environment\}/,
    );
    expect(template).toMatch(/Name: TENKACLOUD_LITE_MANAGED_LAUNCHER_LOG_GROUP\s+Value: "1"/);
  });
});
