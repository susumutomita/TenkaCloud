import { describe, expect, it } from "vitest";
import { EVENT_REPORT_PRINT_CSS, EVENT_REPORT_PRINT_SELECTORS } from "./event-report-print-css";

describe("event-report-print-css", () => {
  it("should wrap all rules in an @media print block (= no screen impact)", () => {
    expect(EVENT_REPORT_PRINT_CSS.trim().startsWith("@media print")).toBe(true);
  });

  it("should pin the load-bearing selector list (= acts as a snapshot to catch accidental drops)", () => {
    expect(EVENT_REPORT_PRINT_SELECTORS).toEqual([
      "body *",
      ".event-report-page",
      ".event-report-page *",
      "[data-tenkacloud-print-section]",
      "[data-tenkacloud-print-section-break]",
      "[data-tenkacloud-print-table]",
      "[data-tenkacloud-print-no-print]",
      "@page",
    ]);
  });

  it("should reference every snapshot selector in the CSS body", () => {
    for (const selector of EVENT_REPORT_PRINT_SELECTORS) {
      expect(EVENT_REPORT_PRINT_CSS).toContain(selector);
    }
  });

  it("should declare A4 portrait as the default page size", () => {
    expect(EVENT_REPORT_PRINT_CSS).toMatch(/size:\s*A4 portrait/);
  });

  it("should use a serif font stack for print readability", () => {
    expect(EVENT_REPORT_PRINT_CSS).toMatch(/font-family:[^;]*serif/i);
  });

  it("should enable page-break-inside avoidance on section blocks", () => {
    expect(EVENT_REPORT_PRINT_CSS).toMatch(/page-break-inside:\s*avoid/);
  });

  it("should put major sections on new pages via page-break-before", () => {
    expect(EVENT_REPORT_PRINT_CSS).toMatch(/page-break-before:\s*always/);
  });

  it("should use a visibility-whitelist (not display:none on chrome) to stop blank print preview (#1317)", () => {
    // 1) すべて visibility: hidden で隠す
    expect(EVENT_REPORT_PRINT_CSS).toMatch(/body\s*\*\s*\{\s*[^}]*visibility:\s*hidden/);
    // 2) .event-report-page とその子孫だけ visibility: visible
    expect(EVENT_REPORT_PRINT_CSS).toMatch(
      /\.event-report-page,\s*\.event-report-page\s*\*\s*\{\s*[^}]*visibility:\s*visible/,
    );
  });

  it("should pin the event-report-page container to the top-left of the printable area", () => {
    expect(EVENT_REPORT_PRINT_CSS).toMatch(/\.event-report-page\s*\{[^}]*position:\s*absolute/);
    expect(EVENT_REPORT_PRINT_CSS).toMatch(/\.event-report-page\s*\{[^}]*top:\s*0/);
    expect(EVENT_REPORT_PRINT_CSS).toMatch(/\.event-report-page\s*\{[^}]*left:\s*0/);
  });

  it("should not blanket-hide Cloudscape chrome with display:none (would risk hiding the report itself)", () => {
    // 旧実装の symptom: header/[id^=awsui] や nav に対する `display: none !important` で
    // 巻き込み事故が起きていた。 whitelist 方式に移行したので、 chrome 直撃の display:none は
    // 残っていないこと。
    expect(EVENT_REPORT_PRINT_CSS).not.toMatch(/header\[id\^="awsui"\][^{]*\{[^}]*display:\s*none/);
    expect(EVENT_REPORT_PRINT_CSS).not.toMatch(
      /nav\[aria-labelledby\^="awsui-side-navigation"\][^{]*\{[^}]*display:\s*none/,
    );
  });
});
