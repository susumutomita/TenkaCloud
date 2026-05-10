import { App, Aspects, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { BuildSpec, Project, Source } from "aws-cdk-lib/aws-codebuild";
import { Key } from "aws-cdk-lib/aws-kms";
import { describe, expect, it } from "vitest";
import { CodeBuildUseAwsManagedKms } from "../../lib/cdk-aspect/codebuild-use-aws-managed-kms";

function buildStackWithCodeBuild(): Template {
  const app = new App();
  const stack = new Stack(app, "TestStack");
  // SBT BashJobRunner と同じ shape を再現: CodeBuild project に customer-managed KMS Key を attach
  const encryptionKey = new Key(stack, "EncryptionKey", { description: "build artifact key" });
  new Project(stack, "Build", {
    source: Source.gitHub({ owner: "x", repo: "y" }),
    encryptionKey,
    buildSpec: BuildSpec.fromObject({ version: "0.2", phases: { build: { commands: ["true"] } } }),
  });
  Aspects.of(app).add(new CodeBuildUseAwsManagedKms());
  return Template.fromStack(stack);
}

describe("CodeBuildUseAwsManagedKms", () => {
  it("CodeBuild Project から EncryptionKey property が削除されるべき (= AWS-managed default にフォールバック)", () => {
    const template = buildStackWithCodeBuild();
    const projects = template.findResources("AWS::CodeBuild::Project");
    const projectKeys = Object.keys(projects);
    expect(projectKeys.length).toBeGreaterThan(0);
    for (const key of projectKeys) {
      expect(projects[key]?.Properties?.EncryptionKey).toBeUndefined();
    }
  });

  it("'EncryptionKey' を含む Construct path の AWS::KMS::Key resource は template から消えるべき", () => {
    const template = buildStackWithCodeBuild();
    template.resourceCountIs("AWS::KMS::Key", 0);
  });

  it("CodeBuild Role の IAM Policy の kms:* statement は除去されるべき (= 残った statement に kms action が無い)", () => {
    const template = buildStackWithCodeBuild();
    const policies = template.findResources("AWS::IAM::Policy");
    for (const policy of Object.values(policies)) {
      const statements = (policy as { Properties: { PolicyDocument: { Statement: unknown[] } } })
        .Properties.PolicyDocument.Statement;
      for (const s of statements) {
        const json = JSON.stringify(s);
        expect(json).not.toContain("kms:");
      }
    }
  });

  it("CodeBuild Role の IAM Policy の Resource に Fn::GetAtt EncryptionKey 参照は残らないべき", () => {
    const template = buildStackWithCodeBuild();
    const policies = template.findResources("AWS::IAM::Policy");
    for (const policy of Object.values(policies)) {
      const json = JSON.stringify(policy);
      expect(json).not.toContain("EncryptionKey");
    }
  });

  it("EncryptionKey と無関係な KMS Key (= 別用途) は影響を受けないべき", () => {
    const app = new App();
    const stack = new Stack(app, "OtherStack");
    new Key(stack, "DataAtRestKey", { description: "別用途の KMS、削除されてはいけない" });
    Aspects.of(app).add(new CodeBuildUseAwsManagedKms());
    const template = Template.fromStack(stack);
    template.resourceCountIs("AWS::KMS::Key", 1);
  });
});
