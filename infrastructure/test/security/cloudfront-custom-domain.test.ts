import { App, Stack } from "aws-cdk-lib";
import { describe, expect, it } from "vitest";
import { buildCustomDomainDistributionProps } from "../../lib/security/cloudfront-custom-domain.js";

/**
 * Issue #1695: opt-in カスタムドメイン props ヘルパ。 config 未設定 / 空文字なら NO-OP ({}),
 * 設定時のみ domainNames + certificate + TLS 1.2 を返すことを pin する。
 */
function scope() {
  return new Stack(new App({ autoSynth: false }), "TestStack");
}

describe("buildCustomDomainDistributionProps (Issue #1695)", () => {
  it("should return empty props (NO-OP) when config is undefined", () => {
    expect(buildCustomDomainDistributionProps(scope(), "Cert", undefined)).toEqual({});
  });

  it("should return empty props when domainName is blank", () => {
    const result = buildCustomDomainDistributionProps(scope(), "Cert", {
      domainName: "   ",
      certificateArn: "arn:aws:acm:us-east-1:111122223333:certificate/abc",
    });
    expect(result).toEqual({});
  });

  it("should return empty props when certificateArn is blank", () => {
    const result = buildCustomDomainDistributionProps(scope(), "Cert", {
      domainName: "console.example.com",
      certificateArn: "",
    });
    expect(result).toEqual({});
  });

  it("should set domainNames, a certificate, and TLS 1.2 when configured", () => {
    const result = buildCustomDomainDistributionProps(scope(), "Cert", {
      domainName: "console.example.com",
      certificateArn: "arn:aws:acm:us-east-1:111122223333:certificate/abc",
    });
    expect(result.domainNames).toEqual(["console.example.com"]);
    expect(result.certificate).toBeDefined();
    // SecurityPolicyProtocol.TLS_V1_2_2021
    expect(result.minimumProtocolVersion).toBe("TLSv1.2_2021");
  });
});
