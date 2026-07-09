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
    verifyPublicKeyParameterName: "/tenkacloud/intent-verify-public-jwk",
    expectedAudience: "plane://tenka/ingress",
    allowedTenantIds: ["tenant-a"],
    allowedEventIds: ["event-a"],
    problemsCatalog: { "hello-world": "problems/challenges/hello-world" },
    competitorAccountsTableName: "CompetitorAccounts",
    competitorAccountsTableArn: "arn:aws:dynamodb:us-east-1:111111111111:table/CompetitorAccounts",
    environmentName: "test",
    env: { account: "111111111111", region: "us-east-1" },
    ...overrides,
  });
  return Template.fromStack(stack);
}

describe("IntentIngressStack (ADR-049 Phase 4 / #2293)", () => {
  it("should expose an unauthenticated Function URL (JWS is the auth)", () => {
    synth().hasResourceProperties("AWS::Lambda::Url", { AuthType: "NONE" });
  }, 60_000);

  it("should provision a 1/1 PROVISIONED nonce table with a TTL attribute", () => {
    // PROVISIONED is the CFn default so CDK omits BillingMode; ProvisionedThroughput
    // (absent on on-demand tables) proves it is PROVISIONED.
    synth().hasResourceProperties("AWS::DynamoDB::Table", {
      ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 },
      TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
    });
  });

  it("should grant ssm:GetParameter scoped to both verification parameters", () => {
    synth().hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "ssm:GetParameter",
            Resource: Match.stringLikeRegexp(
              "arn:aws:ssm:\\*:111111111111:parameter/tenkacloud/intent-verify-secret",
            ),
          }),
          Match.objectLike({
            Action: "ssm:GetParameter",
            Resource: Match.stringLikeRegexp(
              "arn:aws:ssm:\\*:111111111111:parameter/tenkacloud/intent-verify-public-jwk",
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

  it("should grant only dynamodb:GetItem on the competitor-accounts table", () => {
    synth().hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "dynamodb:GetItem",
            Resource: "arn:aws:dynamodb:us-east-1:111111111111:table/CompetitorAccounts",
          }),
        ]),
      }),
    });
  });

  it("should inject the scope + infra env vars into the ingress Lambda", () => {
    synth().hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          VERIFY_SECRET_PARAM: "/tenkacloud/intent-verify-secret",
          VERIFY_PUBLIC_KEY_PARAM: "/tenkacloud/intent-verify-public-jwk",
          EXPECTED_AUDIENCE: "plane://tenka/ingress",
          ALLOWED_TENANT_IDS: "tenant-a",
          ALLOWED_EVENT_IDS: "event-a",
          COMPETITOR_ACCOUNTS_TABLE_NAME: "CompetitorAccounts",
          DEPLOY_ENVIRONMENT: "test",
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

  it("should omit the optional scope env vars when no audience/allowlists are configured", () => {
    // Only the required props: exercises the `: {}` (absent) side of the conditional
    // env spreads for EXPECTED_AUDIENCE / ALLOWED_TENANT_IDS / ALLOWED_EVENT_IDS.
    const app = new App();
    const stack = new IntentIngressStack(app, "TestIntentIngressMinimal", {
      verifySecretParameterName: "/tenkacloud/intent-verify-secret",
      verifyPublicKeyParameterName: "/tenkacloud/intent-verify-public-jwk",
      problemsCatalog: { "hello-world": "problems/challenges/hello-world" },
      competitorAccountsTableName: "CompetitorAccounts",
      competitorAccountsTableArn:
        "arn:aws:dynamodb:us-east-1:111111111111:table/CompetitorAccounts",
      environmentName: "test",
      env: { account: "111111111111", region: "us-east-1" },
    });
    Template.fromStack(stack).hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          VERIFY_SECRET_PARAM: "/tenkacloud/intent-verify-secret",
          VERIFY_PUBLIC_KEY_PARAM: "/tenkacloud/intent-verify-public-jwk",
          EXPECTED_AUDIENCE: Match.absent(),
          ALLOWED_TENANT_IDS: Match.absent(),
          ALLOWED_EVENT_IDS: Match.absent(),
        }),
      },
    });
  });

  it("should prepend a slash to the SSM ARN when the verify-secret name has no leading slash", () => {
    // Exercises the ELSE of `verifySecretParameterName.startsWith("/")`: a bare name
    // must be normalized to `.../parameter/<name>` in the scoped resource ARN.
    synth({ verifySecretParameterName: "tenkacloud/intent-verify-secret" }).hasResourceProperties(
      "AWS::IAM::Policy",
      {
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
      },
    );
  });

  it("should prepend a slash to the SSM ARN when the public-key name has no leading slash", () => {
    synth({
      verifyPublicKeyParameterName: "tenkacloud/intent-verify-public-jwk",
    }).hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "ssm:GetParameter",
            Resource: Match.stringLikeRegexp(
              "arn:aws:ssm:\\*:111111111111:parameter/tenkacloud/intent-verify-public-jwk",
            ),
          }),
        ]),
      }),
    });
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
