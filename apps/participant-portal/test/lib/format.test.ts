import { describe, expect, it } from "vitest";
import { describeAgo } from "../../src/lib/format";

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
