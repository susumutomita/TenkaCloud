import { describe, expect, it } from "vitest";
import { isBootstrapUrlMissing } from "./competitor-bootstrap";

/**
 * Issue #1055: runtime-config の `competitorBootstrapTemplateUrl` 未注入判定を pin する。
 * UI 側はこの判定を使って CompetitorAccounts 画面に警告 banner を出す。
 */
describe("isBootstrapUrlMissing (Issue #1055)", () => {
  it("undefined は missing として扱うべき", () => {
    expect(isBootstrapUrlMissing(undefined)).toBe(true);
  });

  it("空文字列は missing として扱うべき", () => {
    expect(isBootstrapUrlMissing("")).toBe(true);
  });

  it("S3 URL が注入されていれば missing ではないべき", () => {
    expect(
      isBootstrapUrlMissing(
        "https://tenkacloud-bootstrap-123.s3.ap-northeast-1.amazonaws.com/competitor-bootstrap.yaml",
      ),
    ).toBe(false);
  });

  it("GitHub raw URL (= 旧 fallback) も missing 扱いはしない (= 値が入っている時点で operator 配線済の判定)", () => {
    // fallback URL も「URL が注入されている」 扱いにする (= 警告は出さない)。
    // raw URL 自体が CFn で reject される問題は #1053 で別途解決される。
    expect(
      isBootstrapUrlMissing(
        "https://raw.githubusercontent.com/susumutomita/TenkaCloud/main/infrastructure/templates/competitor-bootstrap.yaml",
      ),
    ).toBe(false);
  });
});
