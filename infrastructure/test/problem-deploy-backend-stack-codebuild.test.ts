import { Match } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import {
  synthDefault,
  synthWithDeployConcurrentBuildLimit,
} from "./problem-deploy-backend-stack.test-helpers";

describe("ProblemDeployBackendStack (MVP-1) — CodeBuild Project (runs deploy-battles.sh)", () => {
  const tpl = synthDefault();

  it("should create 1 CodeBuild Project", () => {
    tpl.resourceCountIs("AWS::CodeBuild::Project", 1);
  });

  it("CodeBuild should read from S3 source", () => {
    tpl.hasResourceProperties(
      "AWS::CodeBuild::Project",
      Match.objectLike({
        Source: Match.objectLike({
          Type: "S3",
          Location: Match.stringLikeRegexp("test-source-bucket/source.zip"),
        }),
      }),
    );
  });

  it("should not output ConcurrentBuildLimit when `deployConcurrentBuildLimit` is unset (#538)", () => {
    // 未指定 = AWS account 全体の concurrent build quota (region default 60) を本 Project
    // でフルに使う既存挙動。本 stack の default props で synth した時点で property が
    // 出ていないことを保証する (= 既存運用への regression 防止)。
    const projects = tpl.findResources("AWS::CodeBuild::Project");
    const project = Object.values(projects)[0] as {
      Properties?: { ConcurrentBuildLimit?: number };
    };
    expect(project?.Properties?.ConcurrentBuildLimit).toBeUndefined();
  });
});

describe("ProblemDeployBackendStack (MVP-1) — CodeBuild Project concurrent build limit (#538)", () => {
  // 共有 fixture (`tpl = synthDefault()`) と別 props を渡すので別 instance で synth する。
  // bundling が長い環境でも assertion timeout に巻き込まれないよう collection 時に fixture 化する。
  const limited = synthWithDeployConcurrentBuildLimit();

  it("should reflect `deployConcurrentBuildLimit: 200` in the CFn property", () => {
    limited.hasResourceProperties(
      "AWS::CodeBuild::Project",
      Match.objectLike({ ConcurrentBuildLimit: 200 }),
    );
  });
});
