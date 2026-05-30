import { describe, expect, it } from "vitest";
import { formatRelativeTime, formatTenantStatus, formatTier } from "../../src/lib/format";

/**
 * Issue #1362: admin-console 側 format helper の境界検証。
 */

describe("formatRelativeTime", () => {
  const NOW = new Date("2026-05-05T10:00:00.000Z");

  it("should return em-dash for undefined / null / empty", () => {
    expect(formatRelativeTime(undefined, "ja", NOW)).toBe("—");
    expect(formatRelativeTime(null, "ja", NOW)).toBe("—");
    expect(formatRelativeTime("", "ja", NOW)).toBe("—");
  });

  it("should return em-dash for an unparseable (non-empty) ISO string", () => {
    expect(formatRelativeTime("not-a-date", "ja", NOW)).toBe("—");
  });

  it("should render under 30 seconds as 「今」 in ja and 'just now' in en", () => {
    expect(formatRelativeTime("2026-05-05T10:00:00.000Z", "ja", NOW)).toBe("今");
    expect(formatRelativeTime("2026-05-05T10:00:00.000Z", "en", NOW)).toBe("just now");
  });

  it("should bucket relative time at 1-minute / 1-hour / 1-day boundaries", () => {
    expect(formatRelativeTime("2026-05-05T09:59:00.000Z", "ja", NOW)).toBe("1 分前");
    expect(formatRelativeTime("2026-05-05T09:00:00.000Z", "ja", NOW)).toBe("1 時間前");
    expect(formatRelativeTime("2026-05-04T10:00:00.000Z", "ja", NOW)).toBe("1 日前");
  });

  it("should render the minute / hour / day buckets in English too", () => {
    expect(formatRelativeTime("2026-05-05T09:59:00.000Z", "en", NOW)).toBe("1 min ago");
    expect(formatRelativeTime("2026-05-05T09:00:00.000Z", "en", NOW)).toBe("1 h ago");
    expect(formatRelativeTime("2026-05-04T10:00:00.000Z", "en", NOW)).toBe("1 d ago");
  });

  it("should fall back to YYYY-MM-DD beyond 30 days", () => {
    expect(formatRelativeTime("2026-03-01T10:00:00.000Z", "ja", NOW)).toBe("2026-03-01");
  });
});

describe("formatTenantStatus", () => {
  it("should map known statuses to Japanese / English labels", () => {
    expect(formatTenantStatus("ACTIVE", "ja")).toBe("稼働中");
    expect(formatTenantStatus("ACTIVE", "en")).toBe("Active");
    expect(formatTenantStatus("DELETING", "ja")).toBe("削除中");
  });

  it("should pass through unknown statuses", () => {
    expect(formatTenantStatus("NEW_STATE", "ja")).toBe("NEW_STATE");
  });
});

describe("formatTier", () => {
  it("should annotate isolation kind for known SBT tiers", () => {
    expect(formatTier("BASIC", "ja")).toBe("BASIC (プール)");
    expect(formatTier("PLATINUM", "ja")).toBe("PLATINUM (サイロ)");
    expect(formatTier("PLATINUM", "en")).toBe("PLATINUM (silo)");
  });

  it("should pass through unknown tiers", () => {
    expect(formatTier("FREE", "ja")).toBe("FREE");
  });
});
