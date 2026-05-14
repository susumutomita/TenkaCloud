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
  it("`concurrentBuildLimit` を未指定なら ConcurrentBuildLimit プロパティを設定しないべき", () => {
    // 未指定 = AWS account 全体の concurrent build limit (default 60) をフルに使う。
    // この既定挙動を変えないことが本 PR の前提 (= 既存運用への regression を出さない)。
    const tpl = synth();
    const projects = tpl.findResources("AWS::CodeBuild::Project");
    const projectKeys = Object.keys(projects);
    expect(projectKeys.length).toBe(1);
    const project = projects[projectKeys[0] as string];
    expect(project?.Properties?.ConcurrentBuildLimit).toBeUndefined();
  });

  it("`concurrentBuildLimit: 200` を渡したら CFn の ConcurrentBuildLimit に反映されるべき", () => {
    // Service Quota request で account を 200 に上げた operator が、本 project に明示的に
    // cap を伝える経路。CDK Project は `concurrentBuildLimit` を ConcurrentBuildLimit
    // CFn property にそのまま渡す。
    const tpl = synth({ concurrentBuildLimit: 200 });
    tpl.hasResourceProperties(
      "AWS::CodeBuild::Project",
      Match.objectLike({ ConcurrentBuildLimit: 200 }),
    );
  });

  it("`concurrentBuildLimit: 60` (= AWS account default) を渡しても CFn property に反映されるべき", () => {
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
  it("CodeBuild Project Role に sts:AssumeRole (`arn:aws:iam::*:role/TenkaCloud-*`) を付与するべき", () => {
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

  it("CodeBuild Project Role に SSM SecureString Read (= tenant path prefix scope) を付与するべき", () => {
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

  it("CodeBuild env variables に AssumeRole と per-deployment ExternalId 用の env を宣言するべき", () => {
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
