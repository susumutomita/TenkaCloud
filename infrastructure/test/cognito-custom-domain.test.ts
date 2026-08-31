import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { UserPool } from "aws-cdk-lib/aws-cognito";
import { describe, expect, it } from "vitest";
import type { CustomDomainConfig } from "../lib/security/cloudfront-custom-domain";
import { attachCognitoCustomLoginDomain } from "../lib/security/cognito-custom-domain";

/**
 * Issue #1993 / #1994: Cognito ログイン カスタムドメイン helper。 param-gated (未設定なら NO-OP)
 * + 設定時は managed login v2 の custom domain を足す、 の契約を pin する。
 */
describe("attachCognitoCustomLoginDomain (#1993/#1994)", () => {
  function makeStack() {
    const app = new App({ autoSynth: false });
    const stack = new Stack(app, "TestStack", {
      env: { account: "123456789012", region: "ap-northeast-1" },
    });
    const userPool = new UserPool(stack, "Pool");
    return { stack, userPool };
  }

  const VALID: CustomDomainConfig = {
    domainName: "login.example.com",
    certificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/abc",
  };

  it("should be a NO-OP (no UserPoolDomain, returns undefined) when config is undefined", () => {
    const { stack, userPool } = makeStack();
    const result = attachCognitoCustomLoginDomain(stack, "LoginDomain", {
      userPoolId: userPool.userPoolId,
    });
    expect(result).toBeUndefined();
    Template.fromStack(stack).resourceCountIs("AWS::Cognito::UserPoolDomain", 0);
  });

  it("should be a NO-OP when domainName is blank (placeholder unset)", () => {
    const { stack, userPool } = makeStack();
    const result = attachCognitoCustomLoginDomain(stack, "LoginDomain", {
      userPoolId: userPool.userPoolId,
      config: { domainName: "   ", certificateArn: VALID.certificateArn },
    });
    expect(result).toBeUndefined();
    Template.fromStack(stack).resourceCountIs("AWS::Cognito::UserPoolDomain", 0);
  });

  it("should be a NO-OP when certificateArn is blank (placeholder unset)", () => {
    const { stack, userPool } = makeStack();
    const result = attachCognitoCustomLoginDomain(stack, "LoginDomain", {
      userPoolId: userPool.userPoolId,
      config: { domainName: VALID.domainName, certificateArn: "  " },
    });
    expect(result).toBeUndefined();
    Template.fromStack(stack).resourceCountIs("AWS::Cognito::UserPoolDomain", 0);
  });

  it("should create a managed-login (v2) custom domain when config is provided", () => {
    const { stack, userPool } = makeStack();
    const result = attachCognitoCustomLoginDomain(stack, "LoginDomain", {
      userPoolId: userPool.userPoolId,
      config: VALID,
    });
    expect(result).toBeDefined();
    const template = Template.fromStack(stack);
    template.resourceCountIs("AWS::Cognito::UserPoolDomain", 1);
    template.hasResourceProperties(
      "AWS::Cognito::UserPoolDomain",
      Match.objectLike({
        Domain: "login.example.com",
        ManagedLoginVersion: 2,
        CustomDomainConfig: {
          CertificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/abc",
        },
      }),
    );
  });
});
