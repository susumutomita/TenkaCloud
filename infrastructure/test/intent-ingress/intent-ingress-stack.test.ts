import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import {
  IntentIngressStack,
  type IntentIngressStackProps,
} from "../../lib/intent-ingress/intent-ingress-stack";

function synth(overrides: Partial<IntentIngressStackProps> = {}): Template {
  const app = new App();
  const stack = new IntentIngressStack(app, "TestIntentIngress", {
    verifySecretParameterName: "/tenkacloud/intent-verify-secret",
    expectedAudience: "plane://tenka/ingress",
    allowedTenantIds: ["tenant-a"],
    allowedEventIds: ["event-a"],
    problemsCatalog: { "hello-world": "problems/challenges/hello-world" },
    env: { account: "111111111111", region: "us-east-1" },
    ...overrides,
  });
  return Template.fromStack(stack);
}

describe("IntentIngressStack (ADR-049 Phase 4 / #2293)", () => {
  it("should expose an unauthenticated Function URL (JWS is the auth)", () => {
    synth().hasResourceProperties("AWS::Lambda::Url", { AuthType: "NONE" });
  });

  it("should provision a 1/1 PROVISIONED nonce table with a TTL attribute", () => {
    // PROVISIONED is the CFn default so CDK omits BillingMode; ProvisionedThroughput
    // (absent on on-demand tables) proves it is PROVISIONED.
    synth().hasResourceProperties("AWS::DynamoDB::Table", {
      ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 },
      TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
    });
  });

  it("should grant ssm:GetParameter scoped to the verify-secret parameter", () => {
    synth().hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "ssm:GetParameter",
            Resource: Match.stringLikeRegexp(
              "arn:aws:ssm:\\*:111111111111:parameter/tenkacloud/intent-verify-secret",
            ),
          }),
        ]),
      }),
    });
  });

  it("should grant events:PutEvents so the frozen event can be re-emitted", () => {
    synth().hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([Match.objectLike({ Action: "events:PutEvents" })]),
      }),
    });
  });

  it("should grant write (conditional PutItem) on the nonce table", () => {
    synth().hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Action: Match.arrayWith(["dynamodb:PutItem"]) }),
        ]),
      }),
    });
  });

  it("should inject the scope + infra env vars into the ingress Lambda", () => {
    synth().hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          VERIFY_SECRET_PARAM: "/tenkacloud/intent-verify-secret",
          EXPECTED_AUDIENCE: "plane://tenka/ingress",
          ALLOWED_TENANT_IDS: "tenant-a",
          ALLOWED_EVENT_IDS: "event-a",
        }),
      },
    });
  });

  it("should create a local EventBus when no bus ARN is provided (standalone)", () => {
    synth().resourceCountIs("AWS::Events::EventBus", 1);
  });

  it("should import an existing bus and create no local EventBus when an ARN is provided", () => {
    const t = synth({
      eventBusArn: "arn:aws:events:us-east-1:111111111111:event-bus/tenkacloud-deploy",
    });
    t.resourceCountIs("AWS::Events::EventBus", 0);
  });

  it("should not grant the ingress Lambda any sts:AssumeRole (no control-plane trust)", () => {
    const policies = synth().findResources("AWS::IAM::Policy");
    for (const policy of Object.values(policies)) {
      const statements = (
        policy.Properties as { PolicyDocument: { Statement: { Action?: unknown }[] } }
      ).PolicyDocument.Statement;
      for (const stmt of statements) {
        const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
        expect(actions).not.toContain("sts:AssumeRole");
      }
    }
  });
});
