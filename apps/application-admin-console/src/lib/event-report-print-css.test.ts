import { describe, expect, it } from "vitest";
import { EVENT_REPORT_PRINT_CSS, EVENT_REPORT_PRINT_SELECTORS } from "./event-report-print-css";

describe("event-report-print-css", () => {
  it("should wrap all rules in an @media print block (= no screen impact)", () => {
    expect(EVENT_REPORT_PRINT_CSS.trim().startsWith("@media print")).toBe(true);
  });

  it("should pin the load-bearing selector list (= acts as a snapshot to catch accidental drops)", () => {
    expect(EVENT_REPORT_PRINT_SELECTORS).toEqual([
      'header[id^="awsui"]',
      'nav[aria-labelledby^="awsui-side-navigation"]',
      "body > *:not([data-tenkacloud-print-root]):not(style):not(script)",
      "[data-tenkacloud-print-root]",
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
});
