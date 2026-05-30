import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "../src/index";

/**
 * Issue #1446: 3 SPA 共有 `formatRelativeTime` の正本テスト (participant-portal から移設)。
 * 「N 分前 / N 時間前 / N 日前 / 今」 + 30 日越え ISO fallback + invalid/未来 の防御を pin。
 */
describe("formatRelativeTime", () => {
  const NOW = new Date("2026-05-05T10:00:00.000Z");

  it("should return em-dash for undefined / null / empty string", () => {
    expect(formatRelativeTime(undefined, "ja", NOW)).toBe("—");
    expect(formatRelativeTime(null, "ja", NOW)).toBe("—");
    expect(formatRelativeTime("", "ja", NOW)).toBe("—");
  });

  it("should return em-dash for an unparseable date", () => {
    expect(formatRelativeTime("not-a-date", "ja", NOW)).toBe("—");
  });

  it("should show 今 / just now under 30 seconds", () => {
    expect(formatRelativeTime("2026-05-05T10:00:00.000Z", "ja", NOW)).toBe("今");
    expect(formatRelativeTime("2026-05-05T09:59:31.000Z", "ja", NOW)).toBe("今");
    expect(formatRelativeTime("2026-05-05T10:00:00.000Z", "en", NOW)).toBe("just now");
  });

  it("should show minutes", () => {
    expect(formatRelativeTime("2026-05-05T09:59:00.000Z", "ja", NOW)).toBe("1 分前");
    expect(formatRelativeTime("2026-05-05T09:59:00.000Z", "en", NOW)).toBe("1 min ago");
  });

  it("should show hours", () => {
    expect(formatRelativeTime("2026-05-05T09:00:00.000Z", "ja", NOW)).toBe("1 時間前");
    expect(formatRelativeTime("2026-05-05T09:00:00.000Z", "en", NOW)).toBe("1 h ago");
  });

  it("should show days", () => {
    expect(formatRelativeTime("2026-05-04T10:00:00.000Z", "ja", NOW)).toBe("1 日前");
    expect(formatRelativeTime("2026-05-04T10:00:00.000Z", "en", NOW)).toBe("1 d ago");
  });

  it("should fall back to the ISO date past 30 days", () => {
    expect(formatRelativeTime("2026-03-01T10:00:00.000Z", "ja", NOW)).toBe("2026-03-01");
    expect(formatRelativeTime("2026-03-01T10:00:00.000Z", "en", NOW)).toBe("2026-03-01");
  });

  it("should clamp a future timestamp to 今 (no future wording)", () => {
    expect(formatRelativeTime("2026-05-05T11:00:00.000Z", "ja", NOW)).toBe("今");
  });

  it("should default lang to ja and now to the current time", () => {
    // 引数省略 = ja + new Date()。 大昔の日付は必ず ISO fallback。
    expect(formatRelativeTime("2000-01-01T00:00:00.000Z")).toBe("2000-01-01");
  });
});
