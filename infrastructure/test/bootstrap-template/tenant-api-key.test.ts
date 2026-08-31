import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { TenantApiKey } from "../../lib/bootstrap-template/tenant-api-key";

/**
 * #1384: tenant API キーの値を CloudFormation template に平文で焼き込まない。 API Gateway に
 * 値を auto-generate させ、 値 SSM パラメータには非機密 placeholder を入れる (= 値は vestigial)。
 */
function synth(): Template {
  const app = new App({ autoSynth: false });
  const stack = new Stack(app, "Test", {
    env: { account: "123456789012", region: "ap-northeast-1" },
  });
  new TenantApiKey(stack, "BasicTierApiKey", {
    ssmParameterApiKeyIdName: "/test/basic/keyId",
    ssmParameterApiValueName: "/test/basic/value",
  });
  return Template.fromStack(stack);
}

describe("TenantApiKey (#1384)", () => {
  it("should NOT bake a Value into AWS::ApiGateway::ApiKey (API Gateway auto-generates it)", () => {
    const tpl = synth();
    const keys = tpl.findResources("AWS::ApiGateway::ApiKey");
    expect(Object.keys(keys)).toHaveLength(1);
    const props = (Object.values(keys)[0]?.Properties ?? {}) as Record<string, unknown>;
    expect(props).not.toHaveProperty("Value");
  });

  it("should store a non-secret placeholder (not a plaintext key) in the value SSM parameter", () => {
    const tpl = synth();
    tpl.hasResourceProperties(
      "AWS::SSM::Parameter",
      Match.objectLike({
        Name: "/test/basic/value",
        Type: "String",
        Value: "auto-generated-by-api-gateway-not-exposed",
      }),
    );
  });

  it("should still publish the API key ID for downstream wiring", () => {
    const tpl = synth();
    tpl.hasResourceProperties(
      "AWS::SSM::Parameter",
      Match.objectLike({ Name: "/test/basic/keyId" }),
    );
  });
});
