import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { App, Stack } from "aws-cdk-lib";
import { CfnInclude } from "aws-cdk-lib/cloudformation-include";
import { afterAll, describe, expect, it } from "vitest";
import { CloudApplicationStack } from "../../lib/cloud-hosting/application-stack.js";
import { projectBootstrap } from "../../lib/cloud-hosting/bootstrap.js";
import { CloudDataStack } from "../../lib/cloud-hosting/data-stack.js";
import {
  applicationRoleBoundary,
  CLOUD_HOSTING_RESOURCE_TYPES,
  deploymentPolicies,
  type IamPolicyDocument,
  installedCdkBootstrapTemplate,
  projectBootstrapTemplate,
  splitManagedPolicy,
} from "../../lib/cloud-hosting/deployment-policy.js";
import { cloudStackNames, cloudStackTags } from "../../lib/cloud-hosting/stack-names.js";
import { projectSynthesizer } from "../../lib/cloud-hosting/synthesizer.js";

const scope = { account: "123456789012", region: "us-east-1", environment: "staging" };
const output = mkdtempSync(join(tmpdir(), "tenkacloud-deployment-policy-"));
afterAll(() => rmSync(output, { recursive: true, force: true }));
const actions = (policy: IamPolicyDocument) =>
  policy.Statement.flatMap((statement) => statement.Action);
const statement = (policy: IamPolicyDocument, sid: string) => {
  const result = policy.Statement.find((entry) => entry.Sid === sid);
  if (!result) throw new Error(`Missing policy statement ${sid}`);
  return result;
};

function allActions(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(allActions);
  return Object.entries(value).flatMap(([key, nested]) => {
    if (key !== "Action") return allActions(nested);
    if (typeof nested === "string") return [nested];
    return Array.isArray(nested) ? (nested as string[]) : [];
  });
}

describe("bounded cloud-host deployment IAM", () => {
  it("keeps generated-name permissions usable for long environments and scopes S3 creation by bucket location", () => {
    const long = deploymentPolicies({
      ...scope,
      environment: "a".repeat(32),
      region: "ap-northeast-1",
    });
    expect(statement(long.execution, "PassApplicationRoles").Resource).toEqual([
      "arn:aws:iam::123456789012:role/tenkacloud-cloud-*",
    ]);
    expect(statement(long.execution, "Buckets").Resource).toEqual([
      "arn:aws:s3:::tenkacloud-cloud-*",
    ]);
    expect(
      statement(long.execution, "Tables").Condition?.StringEquals?.["aws:ResourceTag/Environment"],
    ).toBe("a".repeat(32));
    expect(statement(long.execution, "CreateBuckets").Condition).toEqual({
      StringEquals: { "s3:LocationConstraint": "ap-northeast-1" },
    });
    expect(statement(long.setup, "CreateToolkitBucket").Condition).toEqual({
      StringEquals: { "s3:LocationConstraint": "ap-northeast-1" },
    });
    expect(statement(deploymentPolicies(scope).execution, "CreateBuckets").Condition).toEqual({
      StringEqualsIfExists: { "s3:LocationConstraint": "us-east-1" },
    });
    expect(
      Buffer.byteLength(
        JSON.stringify(projectBootstrapTemplate({ ...scope, environment: "a".repeat(32) })),
      ),
    ).toBeLessThanOrEqual(51200);
  });

  it("derives isolated names from the exact account, region and validated environment", () => {
    const { identities } = deploymentPolicies(scope);
    expect(identities.qualifier).toBe(projectBootstrap("staging").qualifier);
    expect(identities.setupStackName).toBe("TenkaCloudToolkit-staging");
    expect(identities.operatorPolicyArn).toBe(
      "arn:aws:iam::123456789012:policy/tenkacloud/cloud-hosting/staging-us-east-1-operator",
    );
    expect(identities.executionPolicyArns.length).toBeGreaterThan(1);
    for (const arn of identities.executionPolicyArns)
      expect(arn).toMatch(
        /^arn:aws:iam::123456789012:policy\/tenkacloud\/cloud-hosting\/staging-us-east-1-execution-\d+$/u,
      );
    expect(
      deploymentPolicies({ ...scope, region: "ap-northeast-1" }).identities.operatorPolicyArn,
    ).not.toBe(identities.operatorPolicyArn);
    expect(
      deploymentPolicies({ ...scope, environment: "production" }).identities.qualifier,
    ).not.toBe(identities.qualifier);
    for (const invalid of [
      { ...scope, account: "*" },
      { ...scope, region: "*" },
      { ...scope, region: "cn-north-1" },
      { ...scope, environment: "../development" },
    ])
      expect(() => deploymentPolicies(invalid)).toThrow();
  });

  it("has explicit actions and keeps IAM creation out of the ordinary operator", () => {
    const policies = deploymentPolicies(scope);
    for (const policy of [
      policies.execution,
      policies.operator,
      policies.setup,
      policies.applicationBoundary,
    ]) {
      expect(actions(policy).every((action) => /^[a-z0-9-]+:[A-Za-z]+$/u.test(action))).toBe(true);
      expect(JSON.stringify(policy)).not.toContain("AdministratorAccess");
    }
    expect(actions(policies.operator).filter((action) => action.startsWith("iam:"))).toEqual([
      "iam:PassRole",
    ]);
    expect(actions(policies.setup)).toContain("iam:CreateRole");
    expect(actions(policies.setup)).toContain("iam:CreatePolicy");
    expect(actions(policies.applicationBoundary).some((action) => action.startsWith("iam:"))).toBe(
      false,
    );
    expect(actions(policies.execution)).not.toContain("iam:CreatePolicyVersion");
    expect(actions(policies.execution)).not.toContain("iam:DeleteRolePermissionsBoundary");
  });

  it("grants no matching resource path for unrelated stacks, roles, buckets or bootstrap-policy edits", () => {
    const p = deploymentPolicies(scope);
    // A missing action/resource match is denied even before conditional grants are evaluated.
    // This is a structural regression check, not a replacement for AWS IAM evaluation.
    const hasResourceGrant = (policy: IamPolicyDocument, action: string, resource: string) =>
      policy.Statement.some(
        (entry) =>
          entry.Effect === "Allow" &&
          entry.Action.includes(action) &&
          entry.Resource.some((pattern) =>
            new RegExp(
              `^${pattern
                .split("*")
                .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
                .join(".*")}$`,
              "u",
            ).test(resource),
          ),
      );
    for (const [action, resource] of [
      [
        "cloudformation:UpdateStack",
        "arn:aws:cloudformation:us-east-1:123456789012:stack/unrelated/*",
      ],
      [
        "cloudformation:UpdateStack",
        "arn:aws:cloudformation:us-east-1:123456789012:stack/TenkaCloudToolkit-staging/*",
      ],
      ["sts:AssumeRole", "arn:aws:iam::123456789012:role/unrelated"],
      ["iam:CreatePolicyVersion", p.identities.applicationBoundaryArn],
    ])
      expect(hasResourceGrant(p.operator, action ?? "", resource ?? "")).toBe(false);
    for (const action of ["s3:PutBucketPolicy", "s3:PutObject", "s3:DeleteObject"]) {
      expect(
        hasResourceGrant(
          p.applicationBoundary,
          action,
          `arn:aws:s3:::${p.identities.assetBucketName}`,
        ),
      ).toBe(false);
      expect(
        hasResourceGrant(
          p.applicationBoundary,
          action,
          `arn:aws:s3:::${p.identities.assetBucketName}/asset.zip`,
        ),
      ).toBe(false);
    }
    for (const [action, resource] of [
      ["iam:PassRole", "arn:aws:iam::123456789012:role/unrelated"],
      ["iam:PassRole", "arn:aws:iam::222222222222:role/tenkacloud-cloud-example"],
      ["s3:PutBucketPolicy", "arn:aws:s3:::unrelated-application"],
      [
        "iam:DeleteRolePermissionsBoundary",
        "arn:aws:iam::123456789012:role/tenkacloud-cloud-example",
      ],
      ["iam:CreatePolicyVersion", p.identities.applicationBoundaryArn],
    ])
      expect(hasResourceGrant(p.execution, action ?? "", resource ?? "")).toBe(false);
  });

  it("permits stack tags only through the owned stack mutation APIs", () => {
    const p = deploymentPolicies(scope);
    const expected = {
      StringEquals: {
        "cloudformation:CreateAction": [
          "CreateStack",
          "UpdateStack",
          "CreateChangeSet",
          "ExecuteChangeSet",
        ],
      },
    };
    expect(statement(p.operator, "OwnedStackTags").Action).toEqual([
      "cloudformation:TagResource",
      "cloudformation:UntagResource",
    ]);
    expect(statement(p.operator, "OwnedStackTags").Resource).toEqual(
      statement(p.operator, "DeployWithExecutionRole").Resource,
    );
    expect(statement(p.operator, "OwnedStackTags").Condition).toEqual(expected);
    expect(statement(p.setup, "ToolkitTags").Resource).toEqual([
      "arn:aws:cloudformation:us-east-1:123456789012:stack/TenkaCloudToolkit-staging/*",
    ]);
    expect(statement(p.setup, "ToolkitTags").Condition).toEqual(expected);
  });

  it("passes only the project execution role to CloudFormation and only project app roles to their two services", () => {
    const p = deploymentPolicies(scope);
    expect(statement(p.operator, "PassCloudFormationExecution")).toMatchObject({
      Resource: [p.identities.executionRoleArn],
      Condition: { StringEquals: { "iam:PassedToService": "cloudformation.amazonaws.com" } },
    });
    expect(statement(p.operator, "DeployWithExecutionRole")).toMatchObject({
      Resource: [
        "arn:aws:cloudformation:us-east-1:123456789012:stack/tenkacloud-cloud-staging/*",
        "arn:aws:cloudformation:us-east-1:123456789012:stack/tenkacloud-cloud-problem-deploy-staging/*",
      ],
      Condition: { ArnEquals: { "cloudformation:RoleArn": p.identities.executionRoleArn } },
    });
    expect(statement(p.execution, "PassApplicationRoles")).toMatchObject({
      Resource: ["arn:aws:iam::123456789012:role/tenkacloud-cloud-*"],
      Condition: {
        StringEquals: {
          "iam:PassedToService": ["lambda.amazonaws.com", "states.amazonaws.com"],
        },
      },
    });
    expect(JSON.stringify(statement(p.execution, "PassApplicationRoles"))).not.toContain(
      "ResourceTag",
    );
    expect(statement(p.operator, "AssumeOwnedBootstrapRoles").Resource).not.toContain(
      p.identities.executionRoleArn,
    );
    expect(statement(p.operator, "AssumeOwnedBootstrapRoles").Resource).not.toContain(
      p.identities.imagePublishingRoleArn,
    );
    expect(JSON.stringify(p.operator)).not.toContain("CDKToolkit");
    expect(JSON.stringify(p.operator)).not.toContain("hnb659fds");
  });

  it("requires the immutable runtime boundary and ownership tags when creating or editing application roles", () => {
    const p = deploymentPolicies(scope);
    expect(statement(p.execution, "CreateRolesWithBoundary").Condition).toEqual({
      StringEquals: {
        "aws:RequestTag/TenkaCloudProject": "cloud-hosting",
        "aws:RequestTag/Environment": "staging",
        "aws:RequestTag/TenkaCloudRegion": "us-east-1",
        "iam:PermissionsBoundary": p.identities.applicationBoundaryArn,
      },
    });
    expect(statement(p.execution, "ApplicationRoles").Condition).toEqual({
      StringEquals: {
        "aws:ResourceTag/TenkaCloudProject": "cloud-hosting",
        "aws:ResourceTag/Environment": "staging",
        "aws:ResourceTag/TenkaCloudRegion": "us-east-1",
      },
    });
    expect(
      statement(p.execution, "AttachServiceLoggingPolicies").Condition?.ArnEquals?.[
        "iam:PolicyARN"
      ],
    ).toEqual(["arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"]);
    expect(actions(p.execution)).not.toContain("iam:CreateServiceLinkedRole");
  });

  it("documents and isolates APIs that cannot authorize against exact resource ARNs", () => {
    const p = deploymentPolicies(scope);
    expect(p.limits.some((limit) => limit.includes("origin access controls"))).toBe(true);
    expect(statement(p.execution, "OriginAccessControls").Resource).toEqual([
      "arn:aws:cloudfront::123456789012:origin-access-control/*",
    ]);
    expect(JSON.stringify(p.execution)).not.toContain("::/account");
    expect(statement(p.execution, "WorkflowLogDelivery")).toMatchObject({
      Resource: ["*"],
      Condition: { StringEquals: { "aws:RequestedRegion": "us-east-1" } },
    });
    expect(statement(p.execution, "Distributions").Condition).toEqual({
      StringEquals: {
        "aws:ResourceTag/TenkaCloudProject": "cloud-hosting",
        "aws:ResourceTag/Environment": "staging",
        "aws:ResourceTag/TenkaCloudRegion": "us-east-1",
      },
    });
  });

  it("preserves registry ExternalId/tag fences and the control-plane role denial inside the boundary", () => {
    const boundary = applicationRoleBoundary(scope);
    expect(statement(boundary, "CompetitorRoles").Condition).toMatchObject({
      Null: { "sts:ExternalId": "false" },
      StringEquals: { "aws:ResourceTag/TenkaCloud:Purpose": "competitor-deploy" },
    });
    expect(
      statement(boundary, "ParticipantViewer").Condition?.StringEquals?.["sts:ExternalId"],
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Literal IAM policy variable.
    ).toBe("${aws:ResourceTag/TenkaCloud:JobId}");
    expect(statement(boundary, "NeverAssumeControlPlaneRoles")).toEqual({
      Sid: "NeverAssumeControlPlaneRoles",
      Effect: "Deny",
      Action: ["sts:AssumeRole"],
      Resource: ["arn:aws:iam::123456789012:role/*"],
    });
    expect(statement(boundary, "InitializeExternalId").Condition).toEqual({
      StringEquals: { "ssm:Overwrite": "false" },
    });
    const legacy = {
      roleArn: "arn:aws:iam::222222222222:role/OriginalCompetitor",
      externalIdParameterArn: "arn:aws:ssm:us-east-1:123456789012:parameter/legacy/external-id",
    };
    expect(
      statement(
        applicationRoleBoundary({ ...scope, runnerBindings: [legacy] }),
        "LegacyCompetitorRoles",
      ).Resource,
    ).toEqual([legacy.roleArn]);
    expect(() =>
      applicationRoleBoundary({
        ...scope,
        runnerBindings: [{ ...legacy, roleArn: "arn:aws:iam::123456789012:role/Admin" }],
      }),
    ).toThrow();
    expect(() =>
      applicationRoleBoundary({
        ...scope,
        runnerBindings: [{ ...legacy, roleArn: "arn:aws:iam::*:role/*" }],
      }),
    ).toThrow();
  });

  it("splits managed policies without losing statements and stays within AWS size limits", () => {
    const p = deploymentPolicies(scope);
    expect(p.executionParts.flatMap((part) => part.Statement)).toEqual(p.execution.Statement);
    const template = projectBootstrapTemplate(scope);
    for (const resource of Object.values(template.Resources)) {
      if (resource.Type === "AWS::IAM::ManagedPolicy")
        expect(JSON.stringify(resource.Properties.PolicyDocument).length).toBeLessThanOrEqual(6144);
    }
    expect(() =>
      splitManagedPolicy({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "TooLarge",
            Effect: "Allow",
            Action: ["s3:GetObject"],
            Resource: ["a".repeat(6200)],
          },
        ],
      }),
    ).toThrow("exceeds");
  });
});

describe("scoped transformation of the pinned CDK bootstrap", () => {
  it("preserves stock resources/outputs/version while removing broad grants and external trust inputs", () => {
    const stock = installedCdkBootstrapTemplate();
    const original = JSON.stringify(stock);
    const template = projectBootstrapTemplate(scope, stock);
    expect(JSON.stringify(stock)).toBe(original);
    for (const name of Object.keys(stock.Resources as object))
      expect(template.Resources).toHaveProperty(name);
    for (const name of Object.keys(stock.Outputs as object))
      expect(template.Outputs).toHaveProperty(name);
    expect(template.Outputs.BootstrapVersion?.Value).toBe(
      template.Resources.CdkBootstrapVersion?.Properties.Value,
    );
    expect(template.Metadata?.TenkaCloudSetupPermissions).toEqual(deploymentPolicies(scope).setup);
    expect(Buffer.byteLength(JSON.stringify(template))).toBeLessThanOrEqual(51200);
    expect(template.Parameters.Qualifier?.Default).toBe(
      projectBootstrap(scope.environment).qualifier,
    );
    expect(template.Parameters.BootstrapVariant?.AllowedValues).toEqual([
      "TenkaCloud cloud-hosting v1",
    ]);
    expect(template.Parameters.TrustedAccounts?.AllowedValues).toEqual([""]);
    expect(template.Parameters.TrustedAccountsForLookup?.AllowedValues).toEqual([""]);
    expect(template.Parameters.FileAssetsBucketKmsKeyId?.AllowedValues).toEqual([
      "AWS_MANAGED_KEY",
    ]);
    expect(JSON.stringify(template)).not.toContain("AdministratorAccess");
    expect(JSON.stringify(template)).not.toContain("ReadOnlyAccess");
    expect(allActions(template).every((action) => !action.includes("*"))).toBe(true);
    expect(template.Resources.CloudFormationExecutionRole?.Properties.ManagedPolicyArns).toEqual(
      deploymentPolicies(scope).executionParts.map((_, index) => ({
        Ref: `ExecutionPolicy${index + 1}`,
      })),
    );
    expect(template.Resources.DeploymentActionRole?.Properties.ManagedPolicyArns).toEqual([
      { Ref: "OperatorPolicy" },
    ]);
    expect(template.Resources.LookupRole?.Properties.ManagedPolicyArns).toBeUndefined();
  });

  it("fails closed if the upstream bootstrap adds a role or changes a resource contract", () => {
    const stock = installedCdkBootstrapTemplate();
    const resources = stock.Resources as Record<string, unknown>;
    resources.UnreviewedRole = { Type: "AWS::IAM::Role", Properties: {} };
    expect(() => projectBootstrapTemplate(scope, stock)).toThrow("resource contract changed");
    const changed = installedCdkBootstrapTemplate();
    (changed.Resources as Record<string, unknown>).StagingBucket = {
      Type: "AWS::S3::SomethingNew",
    };
    expect(() => projectBootstrapTemplate(scope, changed)).toThrow("resource contract changed");
  });

  it("loads the generated template as CloudFormation with matching concrete policy names", () => {
    const template = projectBootstrapTemplate(scope);
    const path = join(output, "bootstrap.json");
    writeFileSync(path, JSON.stringify(template));
    const app = new App({ outdir: join(output, "bootstrap-synth") });
    const stack = new Stack(app, "SyntheticProjectToolkit", { env: scope });
    new CfnInclude(stack, "Bootstrap", { templateFile: path });
    const actual = app.synth().getStackArtifact(stack.artifactId).template;
    expect(actual.Resources.OperatorPolicy.Properties.ManagedPolicyName).toBe(
      "staging-us-east-1-operator",
    );
    expect(actual.Resources.OperatorPolicy.Properties.Path).toBe("/tenkacloud/cloud-hosting/");
    expect(actual.Parameters.CloudFormationExecutionPolicies.Default).toBe(
      deploymentPolicies(scope).identities.executionPolicyArns.join(","),
    );
  });

  it("covers the actual application and data synth resource inventory, including CDK providers", () => {
    const assets = join(output, "assets");
    mkdirSync(assets);
    writeFileSync(join(assets, "index.html"), "Synthetic policy coverage asset");
    const app = new App({ outdir: join(output, "application-synth") });
    const names = cloudStackNames(scope.environment);
    const common = { env: scope, tags: cloudStackTags(scope.environment) };
    const backend = new CloudDataStack(app, names.backend, {
      ...common,
      synthesizer: projectSynthesizer(scope.environment),
      participantAssets: assets,
      environment: scope.environment,
    });
    const application = new CloudApplicationStack(app, names.app, {
      ...common,
      synthesizer: projectSynthesizer(scope.environment),
      repositoryRoot: resolve(import.meta.dirname, "../../.."),
      environment: scope.environment,
      backend,
      consoleAssets: assets,
    });
    expect(application.stackName).toBe(names.app);
    const assembly = app.synth();
    const deployment = deploymentPolicies(scope);
    for (const artifact of assembly.stacks) {
      for (const resource of Object.values(artifact.template.Resources) as {
        Type: string;
        Properties: Record<string, unknown>;
      }[]) {
        if (resource.Type === "AWS::IAM::Role")
          expect(resource.Properties.PermissionsBoundary).toBe(
            deployment.identities.applicationBoundaryArn,
          );
      }
    }
    const resources = assembly.stacks.flatMap(
      (artifact) => Object.values(artifact.template.Resources) as { Type: string }[],
    );
    expect([...new Set(resources.map((resource) => resource.Type))].sort()).toEqual(
      [...CLOUD_HOSTING_RESOURCE_TYPES].sort(),
    );
    const p = deploymentPolicies(scope);
    const executionActions = actions(p.execution);
    // Provider types require invocation, deployed code/layers, runtime IAM and S3 permissions.
    for (const action of [
      "dynamodb:CreateTable",
      "cognito-idp:CreateUserPool",
      "lambda:CreateFunction",
      "lambda:PublishLayerVersion",
      "lambda:AddPermission",
      "lambda:InvokeFunction",
      "s3:CreateBucket",
      "s3:PutBucketPolicy",
      "cloudfront:CreateDistribution",
      "cloudfront:CreateOriginAccessControl",
      "apigateway:POST",
      "apigateway:PATCH",
      "states:CreateStateMachine",
      "events:PutRule",
      "events:PutTargets",
      "iam:CreateRole",
      "iam:PutRolePolicy",
      "iam:AttachRolePolicy",
      "logs:CreateLogGroup",
      "logs:PutResourcePolicy",
    ])
      expect(executionActions).toContain(action);
  }, 60_000);
});
