import { describe, expect, it } from "vitest";
import { describeAgo } from "../../src/lib/format";

/**
 * `describeAgo` は score 停滞時間の人間可読フォーマット。
 * Battle 中の defender は「N 分前」を見て「最近加点が来ていない」と察知する重要な
 * display function。
 */

const NOW = new Date("2026-05-05T10:00:00.000Z").getTime();

describe("describeAgo", () => {
  it("undefined / 空文字なら「未採点」を返すべき", () => {
    expect(describeAgo(undefined, NOW)).toBe("未採点");
  });

  it("不正な ISO 文字列なら「?」を返すべき (best-effort)", () => {
    expect(describeAgo("not-a-date", NOW)).toBe("?");
    expect(describeAgo("", NOW)).toBe("未採点");
  });

  it("0 秒前 (= 今) は「0 秒前」", () => {
    expect(describeAgo("2026-05-05T10:00:00.000Z", NOW)).toBe("0 秒前");
  });

  it("60 秒未満は「N 秒前」", () => {
    expect(describeAgo("2026-05-05T09:59:30.000Z", NOW)).toBe("30 秒前");
    expect(describeAgo("2026-05-05T09:59:01.000Z", NOW)).toBe("59 秒前");
  });

  it("60 秒以上 60 分未満は「N 分前」", () => {
    expect(describeAgo("2026-05-05T09:59:00.000Z", NOW)).toBe("1 分前");
    expect(describeAgo("2026-05-05T09:58:00.000Z", NOW)).toBe("2 分前");
    expect(describeAgo("2026-05-05T09:01:00.000Z", NOW)).toBe("59 分前");
  });

  it("60 分以上は「N 時間 M 分前」", () => {
    expect(describeAgo("2026-05-05T09:00:00.000Z", NOW)).toBe("1 時間 0 分前");
    expect(describeAgo("2026-05-05T08:30:00.000Z", NOW)).toBe("1 時間 30 分前");
    expect(describeAgo("2026-05-05T07:15:00.000Z", NOW)).toBe("2 時間 45 分前");
  });

  it("未来時刻 (= now より新しい sinceIso) でも 0 秒前として扱うべき (= clock skew 防御)", () => {
    expect(describeAgo("2026-05-05T10:01:00.000Z", NOW)).toBe("0 秒前");
  });
});
