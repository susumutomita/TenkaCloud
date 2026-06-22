import { App, Aspects } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, it } from "vitest";
import { DynamoDbLowCapacity } from "../lib/cdk-aspect/dynamodb-low-capacity.js";
import { EndpointEvalStack } from "../lib/endpoint-eval/endpoint-eval-stack.js";

function synth(): Template {
  const app = new App();
  const stack = new EndpointEvalStack(app, "TestEndpointEval", {
    env: { account: "123456789012", region: "ap-northeast-1" },
    signingSecretParamName: "/tenkacloud/development/endpoint-eval/signing-secret",
  });
  // bin と同じく低キャパシティ Aspect を被せて 1/1 を保証する。
  Aspects.of(stack).add(new DynamoDbLowCapacity(1, 1));
  return Template.fromStack(stack);
}

describe("EndpointEvalStack (#1973)", () => {
  const tpl = synth();

  it("should provision a single runs table with PK/SK, PROVISIONED 1/1, and TTL on expiresAt", () => {
    tpl.resourceCountIs("AWS::DynamoDB::Table", 1);
    tpl.hasResourceProperties(
      "AWS::DynamoDB::Table",
      Match.objectLike({
        ProvisionedThroughput: Match.objectLike({ ReadCapacityUnits: 1, WriteCapacityUnits: 1 }),
        KeySchema: Match.arrayWith([
          Match.objectLike({ AttributeName: "PK", KeyType: "HASH" }),
          Match.objectLike({ AttributeName: "SK", KeyType: "RANGE" }),
        ]),
        TimeToLiveSpecification: Match.objectLike({ AttributeName: "expiresAt", Enabled: true }),
      }),
    );
  });

  it("should run the eval handler on an ARM64 Node.js Lambda", () => {
    tpl.hasResourceProperties(
      "AWS::Lambda::Function",
      Match.objectLike({
        Handler: "index.handler",
        Runtime: Match.stringLikeRegexp("nodejs"),
        Architectures: ["arm64"],
      }),
    );
  });

  it("should expose a public Function URL (AuthType NONE) — anonymous run creation", () => {
    tpl.hasResourceProperties("AWS::Lambda::Url", Match.objectLike({ AuthType: "NONE" }));
  });

  it("should grant the Lambda SSM GetParameter for the signing secret and DDB access", () => {
    tpl.hasResourceProperties(
      "AWS::IAM::Policy",
      Match.objectLike({
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([Match.objectLike({ Action: "ssm:GetParameter" })]),
        }),
      }),
    );
  });

  it("should output the eval API URL", () => {
    tpl.hasOutput("*", Match.objectLike({ Description: Match.stringLikeRegexp("Function URL") }));
  });
});
