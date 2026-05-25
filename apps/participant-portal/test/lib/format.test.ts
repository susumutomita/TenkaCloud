import { describe, expect, it } from "vitest";
import { describeAgo, formatRelativeTime } from "../../src/lib/format";

/**
 * `describeAgo` は score 停滞時間の人間可読フォーマット。
 * Battle 中の defender は「N 分前」を見て「最近加点が来ていない」と察知する重要な
 * display function。
 */

const NOW = new Date("2026-05-05T10:00:00.000Z").getTime();

describe("describeAgo", () => {
  it("should return 「未採点」 for undefined / empty string", () => {
    expect(describeAgo(undefined, NOW)).toBe("未採点");
  });

  it("should return 「?」 for an invalid ISO string (best-effort)", () => {
    expect(describeAgo("not-a-date", NOW)).toBe("?");
    expect(describeAgo("", NOW)).toBe("未採点");
  });

  it("should return 「0 秒前」 for 0 seconds ago (= now)", () => {
    expect(describeAgo("2026-05-05T10:00:00.000Z", NOW)).toBe("0 秒前");
  });

  it("should render under 60 seconds as 「N 秒前」", () => {
    expect(describeAgo("2026-05-05T09:59:30.000Z", NOW)).toBe("30 秒前");
    expect(describeAgo("2026-05-05T09:59:01.000Z", NOW)).toBe("59 秒前");
  });

  it("should render 60 seconds to under 60 minutes as 「N 分前」", () => {
    expect(describeAgo("2026-05-05T09:59:00.000Z", NOW)).toBe("1 分前");
    expect(describeAgo("2026-05-05T09:58:00.000Z", NOW)).toBe("2 分前");
    expect(describeAgo("2026-05-05T09:01:00.000Z", NOW)).toBe("59 分前");
  });

  it("should render 60 minutes or more as 「N 時間 M 分前」", () => {
    expect(describeAgo("2026-05-05T09:00:00.000Z", NOW)).toBe("1 時間 0 分前");
    expect(describeAgo("2026-05-05T08:30:00.000Z", NOW)).toBe("1 時間 30 分前");
    expect(describeAgo("2026-05-05T07:15:00.000Z", NOW)).toBe("2 時間 45 分前");
  });

  it("should treat future timestamps (= sinceIso newer than now) as 0 seconds ago (= clock skew defense)", () => {
    expect(describeAgo("2026-05-05T10:01:00.000Z", NOW)).toBe("0 秒前");
  });
});

/**
 * Issue #1362: `formatRelativeTime` は admin / participant 3 SPA で共有する一般 UI 用 helper。
 * 「N 分前 / N 時間前 / N 日前 / 今」 + 30 日越えは ISO 日付 fallback。
 */
describe("formatRelativeTime", () => {
  const NOW_DATE = new Date("2026-05-05T10:00:00.000Z");

  it("should return em-dash for undefined / null / empty string (= 未設定 を装飾しない)", () => {
    expect(formatRelativeTime(undefined, "ja", NOW_DATE)).toBe("—");
    expect(formatRelativeTime(null, "ja", NOW_DATE)).toBe("—");
    expect(formatRelativeTime("", "ja", NOW_DATE)).toBe("—");
  });

  it("should return em-dash for invalid ISO (= 防御的 fallback)", () => {
    expect(formatRelativeTime("not-a-date", "ja", NOW_DATE)).toBe("—");
  });

  it("should render under 30 seconds as 「今」 in ja", () => {
    expect(formatRelativeTime("2026-05-05T10:00:00.000Z", "ja", NOW_DATE)).toBe("今");
    expect(formatRelativeTime("2026-05-05T09:59:31.000Z", "ja", NOW_DATE)).toBe("今");
  });

  it("should render under 30 seconds as 'just now' in en", () => {
    expect(formatRelativeTime("2026-05-05T10:00:00.000Z", "en", NOW_DATE)).toBe("just now");
  });

  it("should render 1 minute boundary as 「1 分前」 (= 60s)", () => {
    expect(formatRelativeTime("2026-05-05T09:59:00.000Z", "ja", NOW_DATE)).toBe("1 分前");
    expect(formatRelativeTime("2026-05-05T09:59:00.000Z", "en", NOW_DATE)).toBe("1 min ago");
  });

  it("should render 1 hour boundary as 「1 時間前」 (= 60min)", () => {
    expect(formatRelativeTime("2026-05-05T09:00:00.000Z", "ja", NOW_DATE)).toBe("1 時間前");
    expect(formatRelativeTime("2026-05-05T09:00:00.000Z", "en", NOW_DATE)).toBe("1 h ago");
  });

  it("should render 1 day boundary as 「1 日前」 (= 24h)", () => {
    expect(formatRelativeTime("2026-05-04T10:00:00.000Z", "ja", NOW_DATE)).toBe("1 日前");
    expect(formatRelativeTime("2026-05-04T10:00:00.000Z", "en", NOW_DATE)).toBe("1 d ago");
  });

  it("should render 30+ days ago as the ISO date prefix (= YYYY-MM-DD)", () => {
    expect(formatRelativeTime("2026-03-01T10:00:00.000Z", "ja", NOW_DATE)).toBe("2026-03-01");
  });

  it("should treat future timestamps as 「今」 (= clock skew defense)", () => {
    expect(formatRelativeTime("2026-05-05T11:00:00.000Z", "ja", NOW_DATE)).toBe("今");
  });
});
