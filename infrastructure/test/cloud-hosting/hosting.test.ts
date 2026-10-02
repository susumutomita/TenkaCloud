import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { afterAll, describe, expect, it } from "vitest";
import { CompetitorBootstrapHosting } from "../../lib/cloud-hosting/competitor-accounts.js";
import { cloudExecutionArtifacts } from "../../lib/cloud-hosting/execution-artifacts.js";
import { CloudHosting } from "../../lib/cloud-hosting/hosting.js";

const assets = mkdtempSync(join(tmpdir(), "tenkacloud-hosting-rollback-"));
writeFileSync(join(assets, "index.html"), "<!doctype html><title>Hosting test</title>");
afterAll(() => rmSync(assets, { recursive: true, force: true }));

function hostingTemplate(): Template {
  const app = new App();
  const stack = new Stack(app, "Hosting", {
    env: { account: "123456789012", region: "us-east-1" },
  });
  const hosting = new CloudHosting(stack, "OrganizerConsole", assets);
  return Template.fromStack(Stack.of(hosting));
}

describe("owned hosting bucket rollback", () => {
  it("requires successful cleanup creation before uploading, and deletes uploads before cleanup", () => {
    const template = hostingTemplate();
    const [cleanupId, cleanup] =
      Object.entries(template.findResources("Custom::S3AutoDeleteObjects"))[0] ?? [];
    const [deployment] = Object.values(template.findResources("Custom::CDKBucketDeployment"));
    const [policyId] = Object.keys(template.findResources("AWS::S3::BucketPolicy"));
    expect(cleanupId).toBeDefined();
    expect(policyId).toBeDefined();
    // A Ref to the bucket alone does not wait for this child custom resource.
    // If its CREATE fails/cancels, CFN must never have started an asset upload.
    // CFN reverses DependsOn for rollback/delete, keeping cleanup and its policy
    // alive until upload teardown has finished (including failed upload CREATE).
    expect(deployment?.DependsOn).toContain(cleanupId);
    expect(deployment?.DependsOn).toContain(policyId);
    expect(cleanup?.DependsOn).toContain(policyId);
  });

  it("keeps whole-bucket object/version cleanup and Delete policies", () => {
    const template = hostingTemplate();
    expect(Object.keys(template.findResources("AWS::S3::Bucket"))).toHaveLength(1);
    template.resourceCountIs("Custom::S3AutoDeleteObjects", 1);
    template.hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "Delete",
      UpdateReplacePolicy: "Delete",
      Properties: {
        Tags: Match.arrayWith([{ Key: "aws-cdk:auto-delete-objects", Value: "true" }]),
      },
    });
    template.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ["s3:PutBucketPolicy", "s3:GetBucket*", "s3:List*", "s3:DeleteObject*"],
            Effect: "Allow",
          }),
        ]),
      },
    });
    template.hasResourceProperties("Custom::CDKBucketDeployment", {
      RetainOnDelete: false,
      Prune: false,
    });
  });

  it("also arms cleanup before bootstrap and versioned execution-artifact uploads", () => {
    const root = join(assets, "repository");
    const files: Record<string, string> = {
      "infrastructure/templates/competitor-bootstrap.yaml": "Resources: {}",
      "problems/challenges/hello-world/template.yaml": "Resources: {}",
      "problems/challenges/hello-world/metadata.json": JSON.stringify({
        id: "hello-world",
        cfnParameters: { NamePrefix: "synthetic" },
        scoring: { kind: "flag", points: 100, flagOutputKey: "Flag", wrongAnswerPenalty: 5 },
      }),
      "problems/battles/ac26-crypto-battle/metadata.json": JSON.stringify({
        id: "ac26-crypto-battle",
        name: "Synthetic battle",
        description: "Synthetic artifact for a rollback graph test",
        instructions: "Test only",
        interTeamCoordination: {
          plugin: "coordination/crypto-battle.ts",
          stateBudget: { bytesPerTeam: 31744, baseBytes: 1536 },
        },
        i18n: { en: { name: "Synthetic battle", description: "Test", instructions: "Test" } },
      }),
      "problems/battles/ac26-crypto-battle/coordination/crypto-battle.ts":
        "export const synthetic = true;",
    };
    for (const [path, contents] of Object.entries(files)) {
      const target = join(root, path);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, contents);
    }
    const stack = new Stack(new App(), "Artifacts");
    const bootstrap = new CompetitorBootstrapHosting(stack, "Bootstrap", root);
    const execution = cloudExecutionArtifacts(stack, root, []);
    expect(bootstrap.templateUrl).toContain("competitor-bootstrap.yaml");
    expect(execution.bucket.stack).toBe(stack);
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::S3::Bucket", {
      VersioningConfiguration: { Status: "Enabled" },
    });
    const deployments = Object.values(template.findResources("Custom::CDKBucketDeployment"));
    expect(deployments).toHaveLength(2);
    for (const [cleanupId, cleanup] of Object.entries(
      template.findResources("Custom::S3AutoDeleteObjects"),
    )) {
      const deployment = deployments.find(
        (resource) =>
          resource.Properties.DestinationBucketName.Ref === cleanup.Properties.BucketName.Ref,
      );
      expect(deployment?.DependsOn).toContain(cleanupId);
    }
  });
});
