import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { UserPool, UserPoolClient } from "aws-cdk-lib/aws-cognito";
import { describe, expect, it } from "vitest";
import { applyControlPlaneManagedLogin } from "../../lib/control-plane/managed-login";

/**
 * Issue #1992 (Phase 2 of #1990): Control Plane (SBT) の System Admin ログインを
 * Managed login (v2) へ移行する attach module。 SBT 構築ツリー (Docker 依存) を synth せず
 * 軽量な plain Cognito 構成でユニットテストする (= saml-identity-providers.test.ts と同設計)。
 */
describe("applyControlPlaneManagedLogin (#1992)", () => {
  function makeStack() {
    const app = new App();
    const stack = new Stack(app, "TestStack");
    const userPool = new UserPool(stack, "Pool");
    const userPoolDomain = userPool.addDomain("Domain", {
      cognitoDomain: { domainPrefix: "tenkacloud-cp-test" },
    });
    const client = new UserPoolClient(stack, "Client", { userPool });
    return { stack, userPool, userPoolDomain, clientId: client.userPoolClientId };
  }

  it("should opt the SBT UserPoolDomain into Managed login (v2)", () => {
    const { stack, userPool, userPoolDomain, clientId } = makeStack();
    applyControlPlaneManagedLogin(stack, { userPool, userPoolDomain, clientId });
    const tpl = Template.fromStack(stack);
    tpl.hasResourceProperties(
      "AWS::Cognito::UserPoolDomain",
      Match.objectLike({ ManagedLoginVersion: 2 }),
    );
  });

  it("should attach a Managed login branding using Cognito-provided defaults", () => {
    // 厳密な ink/ロゴ settings は live Describe 反復前提のため、 まず Cognito 既定値
    // (UseCognitoProvidedValues) で valid な managed login を立ち上げる (Phase 2a)。
    const { stack, userPool, userPoolDomain, clientId } = makeStack();
    applyControlPlaneManagedLogin(stack, { userPool, userPoolDomain, clientId });
    const tpl = Template.fromStack(stack);
    tpl.resourceCountIs("AWS::Cognito::ManagedLoginBranding", 1);
    tpl.hasResourceProperties(
      "AWS::Cognito::ManagedLoginBranding",
      Match.objectLike({ UseCognitoProvidedValues: true }),
    );
  });

  it("should return the created branding resource", () => {
    const { stack, userPool, userPoolDomain, clientId } = makeStack();
    const branding = applyControlPlaneManagedLogin(stack, { userPool, userPoolDomain, clientId });
    expect(branding).toBeDefined();
    expect(branding.userPoolId).toBe(userPool.userPoolId);
  });

  it("should not create a classic UserPoolUICustomizationAttachment", () => {
    // Control Plane は classic UICustomization を持たないので managed login は純粋に additive。
    const { stack, userPool, userPoolDomain, clientId } = makeStack();
    applyControlPlaneManagedLogin(stack, { userPool, userPoolDomain, clientId });
    const tpl = Template.fromStack(stack);
    tpl.resourceCountIs("AWS::Cognito::UserPoolUICustomizationAttachment", 0);
  });
});
