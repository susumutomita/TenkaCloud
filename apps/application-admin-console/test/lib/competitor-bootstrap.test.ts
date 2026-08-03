import { describe, expect, it } from "vitest";
import {
  buildLaunchStackUrl,
  buildShareablePayload,
  COMPETITOR_BOOTSTRAP_TEMPLATE_URL_FALLBACK,
} from "../../src/lib/competitor-bootstrap";

describe("buildLaunchStackUrl", () => {
  const baseInput = {
    tenkaCloudAccountId: "123456789012",
    externalId: "ext-abc-123",
    competitorRoleName: "TenkaCloudCompetitorRole",
  };

  it("should return a CFn quickcreate URL using ap-northeast-1 as default region", () => {
    const url = buildLaunchStackUrl(baseInput);
    expect(url).toContain("https://ap-northeast-1.console.aws.amazon.com/cloudformation/home");
    expect(url).toContain("#/stacks/quickcreate");
  });

  it("should pre-fill templateURL with the public repo raw URL", () => {
    const url = buildLaunchStackUrl(baseInput);
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain(COMPETITOR_BOOTSTRAP_TEMPLATE_URL_FALLBACK);
  });

  it("should embed the 3 Parameter values as CFn pre-fill query strings", () => {
    const url = buildLaunchStackUrl(baseInput);
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain("param_TenkaCloudAccountId=123456789012");
    expect(decoded).toContain("param_ExternalId=ext-abc-123");
    expect(decoded).toContain("param_RoleName=TenkaCloudCompetitorRole");
  });

  it("should allow region to be overridden", () => {
    const url = buildLaunchStackUrl({ ...baseInput, region: "us-east-1" });
    expect(url).toContain("https://us-east-1.console.aws.amazon.com/");
    expect(url).toContain("region=us-east-1");
  });

  it("should prefer an injected templateUrl over the dev fallback when provided", () => {
    // runtime-config 由来の S3 URL が注入された production 経路 (= resolveTemplateUrl の
    // 「templateUrl あり」 分岐)。 fallback の GitHub raw URL は使わない。
    const injected = "https://tc-templates.s3.amazonaws.com/competitor-bootstrap.yaml";
    const decoded = decodeURIComponent(
      buildLaunchStackUrl({ ...baseInput, templateUrl: injected }),
    );
    expect(decoded).toContain(injected);
    expect(decoded).not.toContain(COMPETITOR_BOOTSTRAP_TEMPLATE_URL_FALLBACK);
  });
});

describe("buildShareablePayload", () => {
  const input = {
    tenkaCloudAccountId: "123456789012",
    externalId: "ext-abc-123",
    competitorRoleName: "TenkaCloudCompetitorRole",
  };

  it("should return a shareable payload that includes all 3 values", () => {
    const payload = buildShareablePayload(input);
    expect(payload).toContain("123456789012");
    expect(payload).toContain("ext-abc-123");
    expect(payload).toContain("TenkaCloudCompetitorRole");
  });

  it("should include both the CFn template raw URL and the Quick-create URL", () => {
    const payload = buildShareablePayload(input);
    expect(payload).toContain(COMPETITOR_BOOTSTRAP_TEMPLATE_URL_FALLBACK);
    expect(payload).toContain("quickcreate");
  });

  it("should include competitor-facing instruction text", () => {
    const payload = buildShareablePayload(input);
    expect(payload).toContain("deploy 手順");
    expect(payload).toContain("Verify");
  });
});

describe("COMPETITOR_BOOTSTRAP_TEMPLATE_URL_FALLBACK", () => {
  it("should point to a public repo raw URL (= accessible to competitors)", () => {
    expect(COMPETITOR_BOOTSTRAP_TEMPLATE_URL_FALLBACK).toMatch(
      /^https:\/\/raw\.githubusercontent\.com\/.+\/competitor-bootstrap\.yaml$/,
    );
  });
});
