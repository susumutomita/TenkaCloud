import { describe, expect, it } from "vitest";
import {
  formatDateTime,
  formatEventStatus,
  formatRelativeTime,
  formatRole,
} from "../../src/lib/format";

/**
 * Issue #1362: 用途別グルーピング + 表示加工 helpers の pure-function 検証。
 * 「DB 生値そのまま表示しない」 の最低境界を test で固定する。
 */

describe("formatRelativeTime", () => {
  const NOW = new Date("2026-05-05T10:00:00.000Z");

  it("should return em-dash for undefined / null / empty (= 未設定 装飾なし)", () => {
    expect(formatRelativeTime(undefined, "ja", NOW)).toBe("—");
    expect(formatRelativeTime(null, "ja", NOW)).toBe("—");
    expect(formatRelativeTime("", "ja", NOW)).toBe("—");
  });

  it("should return em-dash for an invalid ISO (= 防御的 fallback)", () => {
    expect(formatRelativeTime("not-a-date", "ja", NOW)).toBe("—");
  });

  it("should render under 30 seconds as 「今」 / 'just now'", () => {
    expect(formatRelativeTime("2026-05-05T10:00:00.000Z", "ja", NOW)).toBe("今");
    expect(formatRelativeTime("2026-05-05T10:00:00.000Z", "en", NOW)).toBe("just now");
  });

  it("should cross the 1-minute boundary at 60 seconds", () => {
    expect(formatRelativeTime("2026-05-05T09:59:00.000Z", "ja", NOW)).toBe("1 分前");
    expect(formatRelativeTime("2026-05-05T09:59:00.000Z", "en", NOW)).toBe("1 min ago");
  });

  it("should cross the 1-hour boundary at 60 minutes", () => {
    expect(formatRelativeTime("2026-05-05T09:00:00.000Z", "ja", NOW)).toBe("1 時間前");
    expect(formatRelativeTime("2026-05-05T09:00:00.000Z", "en", NOW)).toBe("1 h ago");
  });

  it("should cross the 1-day boundary at 24 hours", () => {
    expect(formatRelativeTime("2026-05-04T10:00:00.000Z", "ja", NOW)).toBe("1 日前");
    expect(formatRelativeTime("2026-05-04T10:00:00.000Z", "en", NOW)).toBe("1 d ago");
  });

  it("should fall back to YYYY-MM-DD beyond 30 days", () => {
    expect(formatRelativeTime("2026-03-01T10:00:00.000Z", "ja", NOW)).toBe("2026-03-01");
  });

  it("should treat future timestamps as 「今」 (= clock skew defense)", () => {
    expect(formatRelativeTime("2026-05-05T11:00:00.000Z", "ja", NOW)).toBe("今");
  });
});

describe("formatDateTime", () => {
  it("should pass through an invalid ISO unchanged (= defensive fallback)", () => {
    expect(formatDateTime("not-a-date")).toBe("not-a-date");
  });

  it("should render an absolute date-time for a valid ISO (ja + en)", () => {
    const ja = formatDateTime("2026-05-05T10:00:00.000Z", "ja");
    expect(ja).toContain("2026");
    expect(ja).not.toBe("2026-05-05T10:00:00.000Z"); // not the raw ISO
    expect(formatDateTime("2026-05-05T10:00:00.000Z", "en")).toContain("2026");
  });
});

describe("formatEventStatus", () => {
  it("should map known statuses to Japanese labels", () => {
    expect(formatEventStatus("DRAFT", "ja")).toBe("下書き");
    expect(formatEventStatus("READY", "ja")).toBe("準備完了");
    expect(formatEventStatus("RUNNING", "ja")).toBe("競技中");
    expect(formatEventStatus("ENDED", "ja")).toBe("終了");
    expect(formatEventStatus("ARCHIVED", "ja")).toBe("終了済");
  });

  it("should map known statuses to English labels", () => {
    expect(formatEventStatus("DRAFT", "en")).toBe("Draft");
    expect(formatEventStatus("READY", "en")).toBe("Ready");
    expect(formatEventStatus("RUNNING", "en")).toBe("Running");
    expect(formatEventStatus("TEARDOWN", "en")).toBe("Teardown");
  });

  it("should pass through unknown enum values (= debug fallback)", () => {
    expect(formatEventStatus("WAT_IS_THIS", "ja")).toBe("WAT_IS_THIS");
  });
});

describe("formatRole", () => {
  it("should map SBT role enums to localized labels", () => {
    expect(formatRole("TenantAdmin", "ja")).toBe("テナント管理者");
    expect(formatRole("TenantAdmin", "en")).toBe("Tenant admin");
    expect(formatRole("SystemAdmin", "ja")).toBe("システム管理者");
  });

  it("should pass through unknown roles", () => {
    expect(formatRole("ImpossibleRole", "ja")).toBe("ImpossibleRole");
  });
});
