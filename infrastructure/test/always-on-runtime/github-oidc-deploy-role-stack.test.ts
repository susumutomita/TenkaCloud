import { fileURLToPath } from "node:url";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it, vi } from "vitest";
import { scanTemplateForIamDescriptions } from "../../../scripts/lib/iam-description-ascii";
import { buildOidcRoleApp } from "../../bin/tenkacloud-always-on-oidc.js";
import { GithubOidcDeployRoleStack } from "../../lib/always-on-runtime/github-oidc-deploy-role-stack.js";

/**
 * Issue #2293: GitHub Actions OIDC deploy-role stack.
 * Pins the security-critical invariants of the runtime-lifecycle trust:
 *   - trust policy hard-pins aud (StringEquals) + sub (StringLike, environment-scoped)
 *   - deploy is limited to cdk-* bootstrap roles; sweeper mutations are limited to
 *     tenkacloud-event-runtime-* resources
 *   - the OIDC provider is created when absent and imported when an ARN is supplied
 */

const ACCOUNT = "123456789012";
const REGION = "ap-northeast-1";

function synth(props?: {
  existingOidc?: boolean;
  subjectClaimPattern?: string;
  githubRepository?: string;
  cdkQualifier?: string;
}): Template {
  const app = new App();
  const stack = new GithubOidcDeployRoleStack(app, "Test", {
    env: { account: ACCOUNT, region: REGION },
    ...(props?.existingOidc
      ? {
          existingOidcProviderArn: `arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`,
        }
      : {}),
    ...(props?.subjectClaimPattern ? { subjectClaimPattern: props.subjectClaimPattern } : {}),
    ...(props?.githubRepository ? { githubRepository: props.githubRepository } : {}),
    ...(props?.cdkQualifier ? { cdkQualifier: props.cdkQualifier } : {}),
  });
  return Template.fromStack(stack);
}

describe("GithubOidcDeployRoleStack (#2293)", () => {
  it("should hard-pin the OIDC trust policy aud (StringEquals) and sub (StringLike, environment-scoped)", () => {
    const t = synth();
    t.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "sts:AssumeRoleWithWebIdentity",
            Condition: Match.objectLike({
              StringEquals: Match.objectLike({
                "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
              }),
              StringLike: Match.objectLike({
                "token.actions.githubusercontent.com:sub":
                  "repo:susumutomita/TenkaCloud:environment:*",
              }),
            }),
          }),
        ]),
      },
    });
  });

  it("should let the sub claim pattern be overridden (configurable / testable)", () => {
    const t = synth({
      subjectClaimPattern: "repo:susumutomita/TenkaCloud:environment:always-on-runtime",
    });
    t.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Condition: Match.objectLike({
              StringLike: Match.objectLike({
                "token.actions.githubusercontent.com:sub":
                  "repo:susumutomita/TenkaCloud:environment:always-on-runtime",
              }),
            }),
          }),
        ]),
      },
    });
  });

  it("should derive the default sub from the githubRepository prop", () => {
    const t = synth({ githubRepository: "acme/Fork" });
    t.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Condition: Match.objectLike({
              StringLike: Match.objectLike({
                "token.actions.githubusercontent.com:sub": "repo:acme/Fork:environment:*",
              }),
            }),
          }),
        ]),
      },
    });
  });

  it("should scope deploy role chaining to the account's cdk bootstrap roles", () => {
    const t = synth();
    t.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Allow",
            Action: "sts:AssumeRole",
            Resource: Match.arrayWith([
              `arn:aws:iam::${ACCOUNT}:role/cdk-hnb659fds-deploy-role-*`,
              `arn:aws:iam::${ACCOUNT}:role/cdk-hnb659fds-file-publishing-role-*`,
              `arn:aws:iam::${ACCOUNT}:role/cdk-hnb659fds-lookup-role-*`,
              `arn:aws:iam::${ACCOUNT}:role/cdk-hnb659fds-cfn-exec-role-*`,
            ]),
          }),
        ]),
      },
    });
  });

  it("should grant the sweeper only event-runtime delete and archive mutations", () => {
    const t = synth();
    t.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Allow",
            Action: "cloudformation:DescribeStacks",
            Resource: "*",
          }),
          Match.objectLike({
            Effect: "Allow",
            Action: "cloudformation:DeleteStack",
            Resource: Match.anyValue(),
          }),
          Match.objectLike({
            Effect: "Allow",
            Action: "lambda:InvokeFunction",
            Resource: Match.anyValue(),
          }),
        ]),
      },
    });
    const policies = JSON.stringify(t.findResources("AWS::IAM::Policy"));
    expect(policies).toContain(
      `cloudformation:${REGION}:${ACCOUNT}:stack/tenkacloud-event-runtime-*/*`,
    );
    expect(policies).toContain(`lambda:${REGION}:${ACCOUNT}:function:tenkacloud-event-runtime-*`);
  });

  it("should scope the assumable bootstrap roles to a custom cdk qualifier", () => {
    const t = synth({ cdkQualifier: "custom123" });
    t.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "sts:AssumeRole",
            Resource: Match.arrayWith([`arn:aws:iam::${ACCOUNT}:role/cdk-custom123-deploy-role-*`]),
          }),
        ]),
      },
    });
  });

  it("should attach no managed policy at all to the deploy role (imported-provider variant isolates it)", () => {
    // With an imported provider the CDK OIDC custom-resource infra is absent, so the
    // only role in the template is our deploy role.
    const t = synth({ existingOidc: true });
    t.resourceCountIs("AWS::IAM::Role", 1);
    const deployRole = Object.values(t.findResources("AWS::IAM::Role"))[0];
    const managed = deployRole.Properties?.ManagedPolicyArns;
    expect(managed === undefined || (Array.isArray(managed) && managed.length === 0)).toBe(true);
  });

  it("should never reference AdministratorAccess on any role in the template", () => {
    const t = synth();
    for (const role of Object.values(t.findResources("AWS::IAM::Role"))) {
      const managed = role.Properties?.ManagedPolicyArns ?? [];
      expect(JSON.stringify(managed)).not.toContain("AdministratorAccess");
    }
  });

  it("should allow only the read-only DescribeStacks action to use wildcard resource scope", () => {
    const t = synth();
    const collectActions = (statement: { Action?: unknown }): string[] => {
      const action = statement.Action;
      if (typeof action === "string") return [action];
      if (Array.isArray(action)) return action.filter((a): a is string => typeof a === "string");
      return [];
    };
    const collectResources = (statement: { Resource?: unknown }): unknown[] => {
      const resource = statement.Resource;
      return Array.isArray(resource) ? resource : resource === undefined ? [] : [resource];
    };
    for (const policy of Object.values(t.findResources("AWS::IAM::Policy"))) {
      const statements = policy.Properties?.PolicyDocument?.Statement ?? [];
      for (const statement of statements) {
        expect(collectActions(statement)).not.toContain("*");
        if (collectResources(statement).includes("*")) {
          expect(collectActions(statement)).toEqual(["cloudformation:DescribeStacks"]);
        }
      }
    }
  });

  it("should create a GitHub OIDC provider when no ARN is imported", () => {
    const t = synth();
    t.resourceCountIs("Custom::AWSCDKOpenIdConnectProvider", 1);
  });

  it("should import an existing OIDC provider when an ARN is supplied", () => {
    const t = synth({ existingOidc: true });
    t.resourceCountIs("Custom::AWSCDKOpenIdConnectProvider", 0);
  });

  it("should emit an Output for the deploy role ARN", () => {
    const t = synth();
    t.hasOutput("DeployRoleArnOutput", { Value: Match.anyValue() });
  });

  it("should keep every IAM Role/ManagedPolicy description within the IAM Latin-1 range", () => {
    const findings = scanTemplateForIamDescriptions(synth().toJSON());
    expect(findings).toEqual([]);
  });

  it("should set an explicit RoleName when deployRoleName is provided", () => {
    const app = new App();
    const stack = new GithubOidcDeployRoleStack(app, "TestNamed", {
      env: { account: ACCOUNT, region: REGION },
      deployRoleName: "tenkacloud-always-on-deploy",
    });
    Template.fromStack(stack).hasResourceProperties("AWS::IAM::Role", {
      RoleName: "tenkacloud-always-on-deploy",
    });
  });
});

describe("buildOidcRoleApp (bin/tenkacloud-always-on-oidc.ts)", () => {
  it("should throw loudly when the AWS account env is missing", () => {
    expect(() => buildOidcRoleApp({ env: { CDK_PARAM_AWS_REGION: REGION } })).toThrow(
      /CDK_PARAM_AWS_ACCOUNT_ID/,
    );
  });

  it("should throw loudly when the AWS region env is missing", () => {
    expect(() => buildOidcRoleApp({ env: { CDK_PARAM_AWS_ACCOUNT_ID: ACCOUNT } })).toThrow(
      /CDK_PARAM_AWS_REGION/,
    );
  });

  it("should synthesize the OIDC role stack when the required env is set", () => {
    const app = buildOidcRoleApp({
      env: { CDK_PARAM_AWS_ACCOUNT_ID: ACCOUNT, CDK_PARAM_AWS_REGION: REGION },
    });
    const assembly = app.synth();
    const stack = assembly.stacks.find((s) => s.stackName === "tenkacloud-always-on-oidc");
    if (!stack) throw new Error("tenkacloud-always-on-oidc stack was not synthesized");
    // The web-identity deploy role must be present (the OIDC provider adds its own infra role).
    Template.fromJSON(stack.template).hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([Match.objectLike({ Action: "sts:AssumeRoleWithWebIdentity" })]),
      },
    });
  });

  it("should honor env overrides for the OIDC provider ARN and the sub claim", () => {
    const app = buildOidcRoleApp({
      env: {
        CDK_PARAM_AWS_ACCOUNT_ID: ACCOUNT,
        CDK_PARAM_AWS_REGION: REGION,
        CDK_PARAM_GITHUB_OIDC_PROVIDER_ARN: `arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`,
        CDK_PARAM_GITHUB_OIDC_SUBJECT: "repo:susumutomita/TenkaCloud:environment:staging",
      },
    });
    const assembly = app.synth();
    const stack = assembly.stacks.find((s) => s.stackName === "tenkacloud-always-on-oidc");
    if (!stack) throw new Error("tenkacloud-always-on-oidc stack was not synthesized");
    const t = Template.fromJSON(stack.template);
    t.resourceCountIs("Custom::AWSCDKOpenIdConnectProvider", 0);
    t.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Condition: Match.objectLike({
              StringLike: Match.objectLike({
                "token.actions.githubusercontent.com:sub":
                  "repo:susumutomita/TenkaCloud:environment:staging",
              }),
            }),
          }),
        ]),
      },
    });
  });

  it("should synth the app when invoked as the CDK entrypoint (argv guard)", async () => {
    // Point argv[1] at the module path so the top-level guard fires on import.
    const modPath = fileURLToPath(
      new URL("../../bin/tenkacloud-always-on-oidc.ts", import.meta.url),
    );
    const savedArgv1 = process.argv[1];
    const savedAccount = process.env.CDK_PARAM_AWS_ACCOUNT_ID;
    const savedRegion = process.env.CDK_PARAM_AWS_REGION;
    process.argv[1] = modPath;
    process.env.CDK_PARAM_AWS_ACCOUNT_ID = ACCOUNT;
    process.env.CDK_PARAM_AWS_REGION = REGION;
    vi.resetModules();
    try {
      await expect(import("../../bin/tenkacloud-always-on-oidc")).resolves.toBeDefined();
    } finally {
      process.argv[1] = savedArgv1;
      if (savedAccount === undefined) delete process.env.CDK_PARAM_AWS_ACCOUNT_ID;
      else process.env.CDK_PARAM_AWS_ACCOUNT_ID = savedAccount;
      if (savedRegion === undefined) delete process.env.CDK_PARAM_AWS_REGION;
      else process.env.CDK_PARAM_AWS_REGION = savedRegion;
      vi.resetModules();
    }
  });

  it("should thread the githubRepository and cdkQualifier env into the synthesized stack", () => {
    const app = buildOidcRoleApp({
      env: {
        CDK_PARAM_AWS_ACCOUNT_ID: ACCOUNT,
        CDK_PARAM_AWS_REGION: REGION,
        CDK_PARAM_GITHUB_REPOSITORY: "acme/Fork",
        CDK_PARAM_CDK_QUALIFIER: "custom123",
      },
    });
    const assembly = app.synth();
    const stack = assembly.stacks.find((s) => s.stackName === "tenkacloud-always-on-oidc");
    if (!stack) throw new Error("tenkacloud-always-on-oidc stack was not synthesized");
    const t = Template.fromJSON(stack.template);
    t.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Condition: Match.objectLike({
              StringLike: Match.objectLike({
                "token.actions.githubusercontent.com:sub": "repo:acme/Fork:environment:*",
              }),
            }),
          }),
        ]),
      },
    });
    t.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Resource: Match.arrayWith([`arn:aws:iam::${ACCOUNT}:role/cdk-custom123-deploy-role-*`]),
          }),
        ]),
      },
    });
  });
});
