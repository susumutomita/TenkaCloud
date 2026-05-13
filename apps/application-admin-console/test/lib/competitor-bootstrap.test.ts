import { describe, expect, it } from "vitest";
import {
  buildLaunchStackUrl,
  buildShareablePayload,
  buildUpdatePayload,
  buildUpdateStackUrl,
  COMPETITOR_BOOTSTRAP_TEMPLATE_URL,
} from "../../src/lib/competitor-bootstrap";

describe("buildLaunchStackUrl", () => {
  const baseInput = {
    tenkaCloudAccountId: "123456789012",
    externalId: "ext-abc-123",
    competitorRoleName: "TenkaCloudCompetitorRole",
  };

  it("ap-northeast-1 を default region として CFn quickcreate URL を返すべき", () => {
    const url = buildLaunchStackUrl(baseInput);
    expect(url).toContain("https://ap-northeast-1.console.aws.amazon.com/cloudformation/home");
    expect(url).toContain("#/stacks/quickcreate");
  });

  it("templateURL に public repo の raw URL が pre-fill されるべき", () => {
    const url = buildLaunchStackUrl(baseInput);
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain(COMPETITOR_BOOTSTRAP_TEMPLATE_URL);
  });

  it("Parameter 3 値が CFn pre-fill query string として埋め込まれるべき", () => {
    const url = buildLaunchStackUrl(baseInput);
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain("param_TenkaCloudAccountId=123456789012");
    expect(decoded).toContain("param_ExternalId=ext-abc-123");
    expect(decoded).toContain("param_RoleName=TenkaCloudCompetitorRole");
  });

  it("region を上書きできるべき", () => {
    const url = buildLaunchStackUrl({ ...baseInput, region: "us-east-1" });
    expect(url).toContain("https://us-east-1.console.aws.amazon.com/");
    expect(url).toContain("region=us-east-1");
  });
});

describe("buildShareablePayload", () => {
  const input = {
    tenkaCloudAccountId: "123456789012",
    externalId: "ext-abc-123",
    competitorRoleName: "TenkaCloudCompetitorRole",
  };

  it("3 値すべてを含む shareable payload を返すべき", () => {
    const payload = buildShareablePayload(input);
    expect(payload).toContain("123456789012");
    expect(payload).toContain("ext-abc-123");
    expect(payload).toContain("TenkaCloudCompetitorRole");
  });

  it("CFn テンプレ raw URL と Quick-create URL の両方を含むべき", () => {
    const payload = buildShareablePayload(input);
    expect(payload).toContain(COMPETITOR_BOOTSTRAP_TEMPLATE_URL);
    expect(payload).toContain("quickcreate");
  });

  it("競技者向けの手順テキストを含むべき", () => {
    const payload = buildShareablePayload(input);
    expect(payload).toContain("deploy 手順");
    expect(payload).toContain("Verify");
  });
});

describe("COMPETITOR_BOOTSTRAP_TEMPLATE_URL", () => {
  it("public repo の raw URL を指すべき (= 競技者 access 可能)", () => {
    expect(COMPETITOR_BOOTSTRAP_TEMPLATE_URL).toMatch(
      /^https:\/\/raw\.githubusercontent\.com\/.+\/competitor-bootstrap\.yaml$/,
    );
  });
});

describe("buildUpdateStackUrl (#706)", () => {
  it("Update Stack 経路 (#/stacks/update/template) を指すべき", () => {
    const url = buildUpdateStackUrl();
    expect(url).toContain("#/stacks/update/template");
    expect(url).toContain("https://ap-northeast-1.console.aws.amazon.com/cloudformation/home");
  });

  it("templateURL + stackName を pre-fill し、 秘密値 Parameter は含まないべき (= existing 値再利用)", () => {
    const decoded = decodeURIComponent(buildUpdateStackUrl());
    expect(decoded).toContain(COMPETITOR_BOOTSTRAP_TEMPLATE_URL);
    expect(decoded).toContain("stackName=tenkacloud-competitor-bootstrap");
    // 秘密値 (ExternalId) を URL に含めない、 既存 stack の Parameter を Use existing で再利用する
    expect(decoded).not.toContain("param_ExternalId");
    expect(decoded).not.toContain("param_TenkaCloudAccountId");
    expect(decoded).not.toContain("param_RoleName");
  });

  it("region を上書きできるべき", () => {
    const url = buildUpdateStackUrl({ region: "us-east-1" });
    expect(url).toContain("https://us-east-1.console.aws.amazon.com/");
    expect(url).toContain("region=us-east-1");
  });
});

describe("buildUpdatePayload (#706)", () => {
  it("Update Stack URL と「update のお願い」 文言を含むべき", () => {
    const payload = buildUpdatePayload();
    expect(payload).toContain(buildUpdateStackUrl());
    expect(payload).toContain("update");
    expect(payload).toContain("既存");
  });

  it("Quick-create URL (= 新規 create 経路) は含まれないべき (= update 専用)", () => {
    expect(buildUpdatePayload()).not.toContain("quickcreate");
  });

  it("秘密値 (ExternalId / TenkaCloudAccountId) は含まないべき (= 公開 URL のみ)", () => {
    const payload = buildUpdatePayload();
    expect(payload).not.toContain("ExternalId:");
    expect(payload).not.toContain("123456789012");
  });
});
