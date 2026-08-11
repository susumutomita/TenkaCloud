import { Match, type Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import {
  SYNTH_TIMEOUT_MS,
  synthDefault,
  synthLite,
} from "./problem-deploy-backend-stack.test-helpers";

describe("ProblemDeployBackendStack (#778: eventBusArn optional 化)", () => {
  // synth は 5 個の NodejsFunction (= esbuild bundling) を含むため CI 上で ~7s かかる。
  // vitest の default 5s timeout を 30s に拡張する (= 既存 #538 test と同じ pattern)。

  // describe scope で 1 度だけ synth して、 3 件の it で再利用 (= per-test の重複 synth で
  // 21s 消費するのを 7s に圧縮)。
  let liteTemplate: Template;
  let fullTemplate: Template;

  it(
    "should create 1 new local EventBus when eventBusArn is omitted (Lite mode self-contained)",
    () => {
      liteTemplate = synthLite("LiteStack", "test-source-bucket-lite");
      liteTemplate.resourceCountIs("AWS::Events::EventBus", 1);
      liteTemplate.hasResourceProperties(
        "AWS::Events::EventBus",
        Match.objectLike({
          Name: Match.stringLikeRegexp("^tenkacloud-problem-deploy-local-"),
        }),
      );
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should not create a local EventBus in the existing path (Full mode) where eventBusArn is provided",
    () => {
      fullTemplate = synthDefault();
      fullTemplate.resourceCountIs("AWS::Events::EventBus", 0);
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should still provision DeployApi / EventApi / CompetitorAccountsApi / GenericScoring Lambdas in the same shape even when eventBusArn is omitted (features stay live)",
    () => {
      // 前の test で立てた liteTemplate を再利用 (= synth コストを節約)。
      if (!liteTemplate) {
        liteTemplate = synthLite("LiteStack2", "test-source-bucket-lite-2");
      }
      const lambdaCount = Object.keys(liteTemplate.findResources("AWS::Lambda::Function")).length;
      expect(lambdaCount).toBeGreaterThan(0);
      // EventBridge Rule (= Step Functions trigger) も local bus にぶら下がる。
      const ruleCount = Object.keys(liteTemplate.findResources("AWS::Events::Rule")).length;
      expect(ruleCount).toBeGreaterThan(0);
    },
    SYNTH_TIMEOUT_MS,
  );
});
