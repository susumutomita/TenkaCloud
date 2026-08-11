import { Match, type Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import {
  SYNTH_TIMEOUT_MS,
  synthCoordinationDispatcherLambdaOnly,
} from "../problem-deploy-backend-stack.test-helpers";

/**
 * Issue #1420: 専用 CoordinationDispatcherLambda の最小 IAM 境界を pin する。
 * 核心は「participant-portal Lambda が持つ sts:AssumeRole / ssm / kms を **継承しない**」こと
 * (= 未信頼の問題同梱 plugin を将来 in-process 実行しても competitor 資格情報・ExternalId に
 * 構造的に到達不能にすること)。
 */

// Role の **inline 権限ポリシー** (= Properties.Policies) の action を集める。 trust policy
// (AssumeRolePolicyDocument) は除外する (= 全 role が sts:AssumeRole を含むため、 権限境界の検証対象外)。
function allActions(tpl: Template): string[] {
  return Object.values(tpl.findResources("AWS::IAM::Role")).flatMap((r) => {
    const policies =
      (
        r as {
          Properties?: { Policies?: Array<{ PolicyDocument?: { Statement?: unknown[] } }> };
        }
      ).Properties?.Policies ?? [];
    return policies.flatMap((p) =>
      (p.PolicyDocument?.Statement ?? []).flatMap((s) => {
        const a = (s as { Action?: string | string[] }).Action;
        return Array.isArray(a) ? a : typeof a === "string" ? [a] : [];
      }),
    );
  });
}

describe("CoordinationDispatcherLambda", () => {
  it(
    "should provision a Node.js 22 / arm64 Lambda with a Function URL (AuthType=NONE)",
    () => {
      const tpl = synthCoordinationDispatcherLambdaOnly();
      tpl.hasResourceProperties(
        "AWS::Lambda::Function",
        Match.objectLike({ Runtime: "nodejs22.x", Architectures: ["arm64"] }),
      );
      tpl.hasResourceProperties("AWS::Lambda::Url", Match.objectLike({ AuthType: "NONE" }));
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should pass the table-name env required by the shared builder",
    () => {
      const tpl = synthCoordinationDispatcherLambdaOnly();
      tpl.hasResourceProperties(
        "AWS::Lambda::Function",
        Match.objectLike({
          Environment: Match.objectLike({
            Variables: Match.objectLike({
              DEPLOYMENTS_TABLE_NAME: Match.anyValue(),
              EVENTS_TABLE_NAME: Match.anyValue(),
              DEPLOY_ENVIRONMENT: "development",
            }),
          }),
        }),
      );
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should grant scoped DynamoDB access but NOT sts:AssumeRole / ssm / kms",
    () => {
      const tpl = synthCoordinationDispatcherLambdaOnly();
      const actions = allActions(tpl);
      // team-login-key 認証 (Query) + coordination state 行 (Get/Put) は持つ。
      expect(actions).toContain("dynamodb:Query");
      expect(actions).toContain("dynamodb:GetItem");
      expect(actions).toContain("dynamodb:PutItem");
      // competitor 資格情報・ExternalId への経路は **存在しない**。
      expect(actions).not.toContain("sts:AssumeRole");
      expect(actions).not.toContain("ssm:GetParameter");
      expect(actions).not.toContain("kms:Decrypt");
    },
    SYNTH_TIMEOUT_MS,
  );
});
