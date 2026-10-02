import { describe, expect, it } from "vitest";
import { isBootstrapUrlMissing } from "./competitor-bootstrap";

/**
 * Issue #1055: runtime-config の `competitorBootstrapTemplateUrl` 未注入判定を pin する。
 * UI 側はこの判定を使って CompetitorAccounts 画面に警告 banner を出す。
 */
describe("isBootstrapUrlMissing (Issue #1055)", () => {
  it("should treat undefined as missing", () => {
    expect(isBootstrapUrlMissing(undefined)).toBe(true);
  });

  it("should treat empty string as missing", () => {
    expect(isBootstrapUrlMissing("")).toBe(true);
  });

  it("should NOT treat an injected S3 URL as missing", () => {
    expect(
      isBootstrapUrlMissing(
        "https://tenkacloud-bootstrap-123.s3.ap-northeast-1.amazonaws.com/competitor-bootstrap.yaml",
      ),
    ).toBe(false);
  });

  it("should NOT treat a GitHub raw URL (= legacy fallback) as missing (= any value present means operator is wired up)", () => {
    // fallback URL も「URL が注入されている」 扱いにする (= 警告は出さない)。
    // raw URL 自体が CFn で reject される問題は #1053 で別途解決される。
    expect(
      isBootstrapUrlMissing(
        "https://raw.githubusercontent.com/susumutomita/TenkaCloud/main/infrastructure/templates/competitor-bootstrap.yaml",
      ),
    ).toBe(false);
  });
});
