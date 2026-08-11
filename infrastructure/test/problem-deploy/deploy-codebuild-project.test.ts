import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { describe, expect, it } from "vitest";
import { DeployCodeBuildProject } from "../../lib/problem-deploy/deploy-codebuild-project";

/**
 * Bulk Deploy の並列度は account-wide CodeBuild concurrent build limit (default 60) が
 * hard cap。`concurrentBuildLimit` を CDK 経由で渡せるようにすることで、
 *  - Service Quota 引き上げ済みの operator は build cap を明示でき、
 *  - 引き上げ前の運用 (= dev / sandbox) は安全側に倒して暴走を防ぐ、
 * の 2 方向の tuning が可能になる。
 *
 * 本テストでは「prop を渡したら CFn Property に反映される」「未指定なら account max を
 * 利用する CFn default (= property 省略) になる」の 2 系統を検証する。
 */
function synth(props?: { concurrentBuildLimit?: number }): Template {
  const app = new App();
  // ssm:GetParameter ARN を build するため account / region を pin する。
  const stack = new Stack(app, "TestStack", {
    env: { account: "123456789012", region: "ap-northeast-1" },
  });
  const sourceBucket = Bucket.fromBucketName(stack, "SourceBucket", "test-source-bucket");
  new DeployCodeBuildProject(stack, "DeployCodeBuild", {
    sourceBucket,
    sourceObjectKey: "source.zip",
    concurrentBuildLimit: props?.concurrentBuildLimit,
    environmentName: "development",
  });
  return Template.fromStack(stack);
}

describe("DeployCodeBuildProject — concurrent build limit (#538)", () => {
  it("should omit the ConcurrentBuildLimit property when `concurrentBuildLimit` is unset", () => {
    // 未指定 = AWS account 全体の concurrent build limit (default 60) をフルに使う。
    // この既定挙動を維持して既存運用への regression を防ぐ。
    const tpl = synth();
    const projects = tpl.findResources("AWS::CodeBuild::Project");
    const projectKeys = Object.keys(projects);
    expect(projectKeys.length).toBe(1);
    const project = projects[projectKeys[0] as string];
    expect(project?.Properties?.ConcurrentBuildLimit).toBeUndefined();
  });

  it("should reflect `concurrentBuildLimit: 200` in CFn ConcurrentBuildLimit", () => {
    // Service Quota request で account を 200 に上げた operator が、本 project に明示的に
    // cap を伝える経路。CDK Project は `concurrentBuildLimit` を ConcurrentBuildLimit
    // CFn property にそのまま渡す。
    const tpl = synth({ concurrentBuildLimit: 200 });
    tpl.hasResourceProperties(
      "AWS::CodeBuild::Project",
      Match.objectLike({ ConcurrentBuildLimit: 200 }),
    );
  });

  it("should reflect `concurrentBuildLimit: 60` (= AWS account default) in the CFn property", () => {
    // 60 は AWS 既定の hard cap と同値。明示的に 60 を設定して「project がこの cap を
    // 越えない」ことを宣言的にしたい運用 (= dev 環境のコスト暴走防止) に使う。
    const tpl = synth({ concurrentBuildLimit: 60 });
    tpl.hasResourceProperties(
      "AWS::CodeBuild::Project",
      Match.objectLike({ ConcurrentBuildLimit: 60 }),
    );
  });
});

describe("DeployCodeBuildProject — Phase 2.2 cross-account perms (Issue #459)", () => {
  it("should grant sts:AssumeRole (`arn:aws:iam::*:role/TenkaCloud-*`) to the CodeBuild Project Role", () => {
    const tpl = synth();
    // Project Role の inline policy に AssumeRole を含む statement が出るべき。
    tpl.hasResourceProperties(
      "AWS::IAM::Policy",
      Match.objectLike({
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: "Allow",
              Action: "sts:AssumeRole",
              Resource: "arn:aws:iam::*:role/TenkaCloud-*",
            }),
          ]),
        }),
      }),
    );
  });

  it("should grant SSM SecureString Read (tenant path prefix scope) to the CodeBuild Project Role", () => {
    const tpl = synth();
    tpl.hasResourceProperties(
      "AWS::IAM::Policy",
      Match.objectLike({
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: "Allow",
              Action: "ssm:GetParameter",
              Resource:
                "arn:aws:ssm:ap-northeast-1:123456789012:parameter/development/tenants/*/external-id",
            }),
          ]),
        }),
      }),
    );
  });

  it("should declare AssumeRole and per-deployment ExternalId env vars in the CodeBuild env", () => {
    const tpl = synth();
    tpl.hasResourceProperties(
      "AWS::CodeBuild::Project",
      Match.objectLike({
        Environment: Match.objectLike({
          EnvironmentVariables: Match.arrayWith([
            Match.objectLike({ Name: "COMPETITOR_ROLE_ARN" }),
            Match.objectLike({ Name: "EXTERNAL_ID_SSM_PARAMETER" }),
            Match.objectLike({ Name: "TENKACLOUD_ACCOUNT_ID" }),
            Match.objectLike({ Name: "PROBLEM_EXTERNAL_ID" }),
          ]),
        }),
      }),
    );
  });
});

describe("DeployCodeBuildProject — #1381 CFn service-role least-privilege", () => {
  // CodeBuild role に attach された AWS::IAM::Policy 群の全 Action を集める。
  // 注: cfnExecRole の広域権限は AWS::IAM::Role の inlinePolicies (= Policies) に入るので
  // AWS::IAM::Policy には現れない。 よって AWS::IAM::Policy の Action 集合 = CodeBuild role 等の
  // addToRolePolicy 由来であり、 ここに iam:*/ec2:* が無いことが CodeBuild role から剥がれた証拠。
  function iamPolicyActions(tpl: Template): string[] {
    const policies = tpl.findResources("AWS::IAM::Policy");
    return Object.values(policies).flatMap((p) => {
      const statements =
        (p as { Properties?: { PolicyDocument?: { Statement?: unknown[] } } }).Properties
          ?.PolicyDocument?.Statement ?? [];
      return statements.flatMap((s) => {
        const action = (s as { Action?: string | string[] }).Action;
        return Array.isArray(action) ? action : typeof action === "string" ? [action] : [];
      });
    });
  }

  it("should NOT grant iam:* / ec2:* on the CodeBuild project role (moved to the CFn exec role)", () => {
    const actions = iamPolicyActions(synth());
    expect(actions).not.toContain("iam:*");
    expect(actions).not.toContain("ec2:*");
    expect(actions).not.toContain("s3:*");
  });

  it("should create a CloudFormation execution role assumable only by cloudformation.amazonaws.com with the resource-creation perms", () => {
    const tpl = synth();
    tpl.hasResourceProperties(
      "AWS::IAM::Role",
      Match.objectLike({
        AssumeRolePolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: "Allow",
              Action: "sts:AssumeRole",
              Principal: { Service: "cloudformation.amazonaws.com" },
            }),
          ]),
        }),
        Policies: Match.arrayWith([
          Match.objectLike({
            PolicyDocument: Match.objectLike({
              Statement: Match.arrayWith([
                Match.objectLike({
                  Effect: "Allow",
                  Action: Match.arrayWith(["iam:*"]),
                }),
              ]),
            }),
          }),
        ]),
      }),
    );
  });

  it("should let CodeBuild only PassRole the exec role to CloudFormation (conditioned)", () => {
    const tpl = synth();
    tpl.hasResourceProperties(
      "AWS::IAM::Policy",
      Match.objectLike({
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: "Allow",
              Action: "iam:PassRole",
              Condition: {
                StringEquals: { "iam:PassedToService": "cloudformation.amazonaws.com" },
              },
            }),
          ]),
        }),
      }),
    );
  });

  it("should scope stack-operating cloudformation actions to the tc-* stack name prefix", () => {
    const tpl = synth();
    tpl.hasResourceProperties(
      "AWS::IAM::Policy",
      Match.objectLike({
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: "Allow",
              Action: Match.arrayWith(["cloudformation:CreateStack"]),
              Resource: "arn:aws:cloudformation:*:123456789012:stack/tc-*/*",
            }),
          ]),
        }),
      }),
    );
  });

  it("should pass CFN_EXEC_ROLE_ARN to the CodeBuild env (same-account --role-arn source)", () => {
    const tpl = synth();
    tpl.hasResourceProperties(
      "AWS::CodeBuild::Project",
      Match.objectLike({
        Environment: Match.objectLike({
          EnvironmentVariables: Match.arrayWith([Match.objectLike({ Name: "CFN_EXEC_ROLE_ARN" })]),
        }),
      }),
    );
  });
});
