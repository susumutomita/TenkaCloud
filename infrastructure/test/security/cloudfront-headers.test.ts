import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import {
  buildContentSecurityPolicy,
  buildSecurityHeadersPolicy,
} from "../../lib/security/cloudfront-headers";

interface SecurityHeadersConfig {
  StrictTransportSecurity: {
    AccessControlMaxAgeSec: number;
    IncludeSubdomains: boolean;
    Preload: boolean;
  };
  FrameOptions: { FrameOption: string };
  ContentTypeOptions: unknown;
  ReferrerPolicy: { ReferrerPolicy: string };
  ContentSecurityPolicy: { ContentSecurityPolicy: string };
}

/**
 * Issue #855: CloudFront security headers helper の pin。 CSP の各 directive、 5 つの
 * security header が ResponseHeadersPolicy に乗ることを CFn synth で確認する。
 */

describe("buildContentSecurityPolicy (pure helper)", () => {
  it("default で connect-src / form-action / frame-src を 'self' のみに閉じる", () => {
    const csp = buildContentSecurityPolicy();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).toContain("font-src 'self' data:");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-src 'self'");
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

  it("should add frameSrcAllowedOrigins to 'self' without widening other directives", () => {
    const csp = buildContentSecurityPolicy({
      frameSrcAllowedOrigins: ["https://www.youtube.com"],
    });
    expect(csp).toContain("frame-src 'self' https://www.youtube.com");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' https://www.youtube.com");
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
    const app = new App({ autoSynth: false });
    const stack = new Stack(app, "TestStack");
    buildSecurityHeadersPolicy(stack, "TestPolicy", {
      connectSrcAllowedOrigins: ["https://api.example.com"],
      formActionAllowedOrigins: ["https://auth.example.com"],
    });
    return Template.fromStack(stack);
  }

  function securityHeadersConfig(template: Template): SecurityHeadersConfig {
    const policies = template.findResources("AWS::CloudFront::ResponseHeadersPolicy");
    const [policy] = Object.values(policies) as Array<{
      Properties?: {
        ResponseHeadersPolicyConfig?: { SecurityHeadersConfig?: SecurityHeadersConfig };
      };
    }>;
    const config = policy?.Properties?.ResponseHeadersPolicyConfig?.SecurityHeadersConfig;
    expect(config).toBeDefined();
    if (!config) throw new Error("Expected a CloudFront security headers config");
    return config;
  }

  it("ResponseHeadersPolicy を 1 個作る", () => {
    synth().resourceCountIs("AWS::CloudFront::ResponseHeadersPolicy", 1);
  });

  it("HSTS / Frame Options / Content Type / Referrer / CSP の 5 header が含まれる", () => {
    const sec = securityHeadersConfig(synth());
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
    const hsts = securityHeadersConfig(synth()).StrictTransportSecurity;
    expect(hsts.AccessControlMaxAgeSec).toBe(63072000);
    expect(hsts.IncludeSubdomains).toBe(true);
    expect(hsts.Preload).toBe(true);
  });

  it("FrameOptions は DENY (= clickjacking 防御)", () => {
    const fo = securityHeadersConfig(synth()).FrameOptions;
    expect(fo.FrameOption).toBe("DENY");
  });

  it("ReferrerPolicy は strict-origin-when-cross-origin", () => {
    const rp = securityHeadersConfig(synth()).ReferrerPolicy;
    expect(rp.ReferrerPolicy).toBe("strict-origin-when-cross-origin");
  });
});
