import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { composeCloudHosting } from "../../lib/cloud-hosting/compose.js";

describe("configured cloud source pipeline", () => {
  it("requires immutable source location/version through the full stack composition", () => {
    const root = mkdtempSync(join(tmpdir(), "pinned-cloud-pipeline-"));
    const problemDir = "problems/challenges/fixture";
    mkdirSync(join(root, problemDir), { recursive: true });
    writeFileSync(join(root, problemDir, "metadata.json"), "{}");
    writeFileSync(join(root, problemDir, "template.yaml"), "Resources: {}");
    try {
      const { backend } = composeCloudHosting(
        new App(),
        {
          ACCOUNT_ID: "123456789012",
          REGION: "us-east-1",
          CDK_PARAM_ENVIRONMENT: "pin-pipeline",
        },
        {
          sourceBucketName: "source-bucket",
          sourceObjectKey: "source.zip.executions/a.zip",
          problemsCatalog: { fixture: problemDir },
          problemsScoring: {},
          problemsEndpoints: {},
          deployViaLambda: false,
          executionArtifacts: {
            repositoryRoot: root,
            sourceArchive: {
              bucket: "source-bucket",
              key: "source.zip.executions/a.zip",
              versionId: "version-a",
            },
            bundle: {
              catalog: { fixture: problemDir },
              scoring: {},
              endpoints: {},
              phases: {},
              visibility: {},
              runtimes: {},
              disruptions: {},
              coordination: {},
              coordinationBundles: {},
            },
          },
        },
      );
      const machines = Template.fromStack(backend).findResources(
        "AWS::StepFunctions::StateMachine",
      );
      const create = Object.entries(machines).find(([id]) =>
        id.startsWith("DeployCreateStateMachine"),
      );
      expect(create).toBeDefined();
      const definition = JSON.stringify(create?.[1]);
      expect(definition).toContain("SourceVersion.$");
      expect(definition).toContain("SourceLocationOverride.$");
      expect(definition).toContain("InvalidCapturedSource");
      expect(definition).not.toContain("RouteCreateInput");
      const policies = Template.fromStack(backend).findResources("AWS::IAM::Policy");
      const codeBuildPolicies = Object.entries(policies)
        .filter(([id]) => id.startsWith("DeployCodeBuildProjectRole"))
        .map(([, policy]) => policy);
      const sourceGrants = JSON.stringify(codeBuildPolicies);
      expect(sourceGrants).toContain("source.zip.executions/*");
      expect(sourceGrants).toContain("source.zip");
      expect(sourceGrants).toContain("s3:GetObject*");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
