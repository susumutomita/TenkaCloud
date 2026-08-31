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
    const app = new App({ autoSynth: false });
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

  it("should attach a Managed login branding with the custom ink settings (not Cognito defaults)", () => {
    // ink テーマの partial settings + Summit ロゴを投入する。 settings/assets を渡すので
    // UseCognitoProvidedValues は排他で省略される (= 既定値 fallback を使わない)。
    const { stack, userPool, userPoolDomain, clientId } = makeStack();
    applyControlPlaneManagedLogin(stack, { userPool, userPoolDomain, clientId });
    const tpl = Template.fromStack(stack);
    tpl.resourceCountIs("AWS::Cognito::ManagedLoginBranding", 1);
    tpl.hasResourceProperties(
      "AWS::Cognito::ManagedLoginBranding",
      Match.objectLike({
        // primary "Sign in" button が ink 背景 + white text (ink テーマの核)。
        Settings: Match.objectLike({
          components: Match.objectLike({
            primaryButton: Match.objectLike({
              lightMode: Match.objectLike({
                defaults: { backgroundColor: "1d1d1fff", textColor: "ffffffff" },
              }),
            }),
            // page background が ink アクセント。
            pageBackground: Match.objectLike({
              lightMode: { color: "1d1d1fff" },
            }),
            // form は white カード。
            form: Match.objectLike({
              lightMode: Match.objectLike({ backgroundColor: "ffffffff" }),
            }),
          }),
        }),
        // Summit ロゴが FORM_LOGO として attach されている。
        Assets: Match.arrayWith([
          Match.objectLike({
            Category: "FORM_LOGO",
            ColorMode: "LIGHT",
            Extension: "SVG",
          }),
        ]),
      }),
    );
  });

  it("should not set UseCognitoProvidedValues (custom settings/assets are mutually exclusive)", () => {
    const { stack, userPool, userPoolDomain, clientId } = makeStack();
    applyControlPlaneManagedLogin(stack, { userPool, userPoolDomain, clientId });
    const tpl = Template.fromStack(stack);
    const brandings = tpl.findResources("AWS::Cognito::ManagedLoginBranding");
    const props = Object.values(brandings)[0]?.Properties ?? {};
    expect(props.UseCognitoProvidedValues).toBeUndefined();
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
