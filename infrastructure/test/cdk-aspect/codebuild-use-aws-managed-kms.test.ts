import { App, Aspects, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { BuildSpec, Project, Source } from "aws-cdk-lib/aws-codebuild";
import { Key } from "aws-cdk-lib/aws-kms";
import { describe, expect, it } from "vitest";
import { CodeBuildUseAwsManagedKms } from "../../lib/cdk-aspect/codebuild-use-aws-managed-kms";

function buildStackWithCodeBuild(): Template {
  const app = new App({ autoSynth: false });
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

function collectPolicyActions(template: Template): string[] {
  const policies = template.findResources("AWS::IAM::Policy");
  return Object.values(policies).flatMap((policy) => {
    const statements = (policy as { Properties: { PolicyDocument: { Statement: unknown[] } } })
      .Properties.PolicyDocument.Statement;
    return statements.flatMap((statement) => {
      const action = (statement as { Action?: string | string[] }).Action;
      if (Array.isArray(action)) return action;
      return action ? [action] : [];
    });
  });
}

describe("CodeBuildUseAwsManagedKms", () => {
  it("should remove the EncryptionKey property from the CodeBuild Project (fall back to AWS-managed default)", () => {
    const template = buildStackWithCodeBuild();
    const projects = template.findResources("AWS::CodeBuild::Project");
    const projectKeys = Object.keys(projects);
    expect(projectKeys.length).toBeGreaterThan(0);
    for (const key of projectKeys) {
      expect(projects[key]?.Properties?.EncryptionKey).toBeUndefined();
    }
  });

  it("should remove AWS::KMS::Key resources whose Construct path contains 'EncryptionKey' from the template", () => {
    const template = buildStackWithCodeBuild();
    template.resourceCountIs("AWS::KMS::Key", 0);
  });

  it("should strip kms:* statements from the CodeBuild Role IAM Policy (no kms action remains)", () => {
    const template = buildStackWithCodeBuild();
    // `kms:` prefix で始まる action が残っていないこと。 Resource ARN 内の `kms:`
    // 文字列ではなく statement.Action だけを構造的に check する。
    for (const action of collectPolicyActions(template)) {
      expect(action.startsWith("kms:")).toBe(false);
    }
  });

  it("should leave no Fn::GetAtt EncryptionKey reference in the CodeBuild Role IAM Policy Resource", () => {
    const template = buildStackWithCodeBuild();
    const policies = template.findResources("AWS::IAM::Policy");
    for (const policy of Object.values(policies)) {
      const json = JSON.stringify(policy);
      expect(json).not.toContain("EncryptionKey");
    }
  });

  it("should leave KMS Keys unrelated to EncryptionKey untouched (different use)", () => {
    const app = new App({ autoSynth: false });
    const stack = new Stack(app, "OtherStack");
    new Key(stack, "DataAtRestKey", { description: "別用途の KMS、削除されてはいけない" });
    Aspects.of(app).add(new CodeBuildUseAwsManagedKms());
    const template = Template.fromStack(stack);
    template.resourceCountIs("AWS::KMS::Key", 1);
  });

  it("should keep statements with mixed Resources (EncryptionKey + other ARNs) (.every() defensive)", async () => {
    const { App, Aspects, Stack } = await import("aws-cdk-lib");
    const { Role, ServicePrincipal, PolicyStatement, Effect, Policy } = await import(
      "aws-cdk-lib/aws-iam"
    );
    const { Key } = await import("aws-cdk-lib/aws-kms");
    const app = new App({ autoSynth: false });
    const stack = new Stack(app, "MixedStack");
    const key = new Key(stack, "EncryptionKey");
    const role = new Role(stack, "Role", {
      assumedBy: new ServicePrincipal("codebuild.amazonaws.com"),
    });
    new Policy(stack, "Pol", {
      roles: [role],
      statements: [
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ["s3:GetObject", "kms:Decrypt"],
          resources: [key.keyArn, "arn:aws:s3:::other-bucket/*"],
        }),
      ],
    });
    Aspects.of(app).add(new CodeBuildUseAwsManagedKms());
    const template = Template.fromStack(stack);
    // mixed Resource statement は .every() で false 判定 → 維持される
    const policies = template.findResources("AWS::IAM::Policy");
    const policyStatements = Object.values(policies).flatMap(
      (p) =>
        (p as { Properties: { PolicyDocument: { Statement: unknown[] } } }).Properties
          .PolicyDocument.Statement,
    );
    // 1 statement が残っている (= 削除されなかった)
    expect(policyStatements.length).toBe(1);
  });
});
