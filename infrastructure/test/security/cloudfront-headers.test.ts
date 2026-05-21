import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import {
  buildContentSecurityPolicy,
  buildSecurityHeadersPolicy,
} from "../../lib/security/cloudfront-headers";

/**
 * Issue #855: CloudFront security headers helper の pin。 CSP の各 directive、 5 つの
 * security header が ResponseHeadersPolicy に乗ることを CFn synth で確認する。
 */

describe("buildContentSecurityPolicy (pure helper)", () => {
  it("default で 9 directive を持ち、 connect-src / form-action は 'self' のみ", () => {
    const csp = buildContentSecurityPolicy();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).toContain("font-src 'self' data:");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  it("should add connectSrcAllowedOrigins to 'self'", () => {
    const csp = buildContentSecurityPolicy({
      connectSrcAllowedOrigins: ["https://api.example.com", "https://auth.example.com"],
    });
    expect(csp).toContain("connect-src 'self' https://api.example.com https://auth.example.com");
  });

  it("should add formActionAllowedOrigins to 'self'", () => {
    const csp = buildContentSecurityPolicy({
      formActionAllowedOrigins: ["https://auth.example.com"],
    });
    expect(csp).toContain("form-action 'self' https://auth.example.com");
  });

  it("allowUnsafeEval=true なら script-src に 'unsafe-eval' を入れる (= dev only)", () => {
    const csp = buildContentSecurityPolicy({ allowUnsafeEval: true });
    expect(csp).toContain("script-src 'self' 'unsafe-eval'");
  });

  it("allowUnsafeEval が指定されない / false なら 'unsafe-eval' を含めない (= prod default 安全側)", () => {
    expect(buildContentSecurityPolicy()).not.toContain("'unsafe-eval'");
    expect(buildContentSecurityPolicy({ allowUnsafeEval: false })).not.toContain("'unsafe-eval'");
  });

  it("frame-ancestors 'none' が含まれる (= clickjacking 防御の主経路)", () => {
    expect(buildContentSecurityPolicy()).toContain("frame-ancestors 'none'");
  });

  it("Issue #899: should add additionalScriptSrcs to script-src / style-src / connect-src", () => {
    const csp = buildContentSecurityPolicy({
      additionalScriptSrcs: ["https://cdn.jsdelivr.net"],
    });
    expect(csp).toContain("script-src 'self' https://cdn.jsdelivr.net");
    expect(csp).toContain("style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net");
    expect(csp).toContain("connect-src 'self' https://cdn.jsdelivr.net");
  });
});

describe("buildSecurityHeadersPolicy (CDK ResponseHeadersPolicy synth)", () => {
  function synth(): Template {
    const app = new App();
    const stack = new Stack(app, "TestStack");
    buildSecurityHeadersPolicy(stack, "TestPolicy", {
      connectSrcAllowedOrigins: ["https://api.example.com"],
      formActionAllowedOrigins: ["https://auth.example.com"],
    });
    return Template.fromStack(stack);
  }

  it("ResponseHeadersPolicy を 1 個作る", () => {
    synth().resourceCountIs("AWS::CloudFront::ResponseHeadersPolicy", 1);
  });

  it("HSTS / Frame Options / Content Type / Referrer / CSP の 5 header が含まれる", () => {
    const template = synth();
    const policies = template.findResources("AWS::CloudFront::ResponseHeadersPolicy");
    const config = Object.values(policies)[0]?.Properties?.ResponseHeadersPolicyConfig as {
      SecurityHeadersConfig?: {
        StrictTransportSecurity?: unknown;
        FrameOptions?: unknown;
        ContentTypeOptions?: unknown;
        ReferrerPolicy?: unknown;
        ContentSecurityPolicy?: { ContentSecurityPolicy?: string };
      };
    };
    const sec = config?.SecurityHeadersConfig ?? {};
    expect(sec.StrictTransportSecurity).toBeDefined();
    expect(sec.FrameOptions).toBeDefined();
    expect(sec.ContentTypeOptions).toBeDefined();
    expect(sec.ReferrerPolicy).toBeDefined();
    expect(sec.ContentSecurityPolicy?.ContentSecurityPolicy).toContain("default-src 'self'");
    expect(sec.ContentSecurityPolicy?.ContentSecurityPolicy).toContain(
      "connect-src 'self' https://api.example.com",
    );
  });

  it("HSTS の max-age が 63072000 秒 (= 2 年) で includeSubdomains + preload", () => {
    const template = synth();
    const policies = template.findResources("AWS::CloudFront::ResponseHeadersPolicy");
    const hsts = (
      Object.values(policies)[0]?.Properties as {
        ResponseHeadersPolicyConfig: {
          SecurityHeadersConfig: {
            StrictTransportSecurity: {
              AccessControlMaxAgeSec: number;
              IncludeSubdomains: boolean;
              Preload: boolean;
            };
          };
        };
      }
    ).ResponseHeadersPolicyConfig.SecurityHeadersConfig.StrictTransportSecurity;
    expect(hsts.AccessControlMaxAgeSec).toBe(63072000);
    expect(hsts.IncludeSubdomains).toBe(true);
    expect(hsts.Preload).toBe(true);
  });

  it("FrameOptions は DENY (= clickjacking 防御)", () => {
    const template = synth();
    const policies = template.findResources("AWS::CloudFront::ResponseHeadersPolicy");
    const fo = (
      Object.values(policies)[0]?.Properties as {
        ResponseHeadersPolicyConfig: {
          SecurityHeadersConfig: { FrameOptions: { FrameOption: string } };
        };
      }
    ).ResponseHeadersPolicyConfig.SecurityHeadersConfig.FrameOptions;
    expect(fo.FrameOption).toBe("DENY");
  });

  it("ReferrerPolicy は strict-origin-when-cross-origin", () => {
    const template = synth();
    const policies = template.findResources("AWS::CloudFront::ResponseHeadersPolicy");
    const rp = (
      Object.values(policies)[0]?.Properties as {
        ResponseHeadersPolicyConfig: {
          SecurityHeadersConfig: { ReferrerPolicy: { ReferrerPolicy: string } };
        };
      }
    ).ResponseHeadersPolicyConfig.SecurityHeadersConfig.ReferrerPolicy;
    expect(rp.ReferrerPolicy).toBe("strict-origin-when-cross-origin");
  });
});
