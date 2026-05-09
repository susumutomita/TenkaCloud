import { describe, expect, it } from "vitest";
import { isScoringActive, joinUrl } from "../../lib/problem-deploy/handlers/health-check-handler";
import {
  computeSince,
  type EndpointHealth,
  parseEndpointsHealth,
} from "../../lib/problem-deploy/handlers/shared/endpoints-health";

/**
 * Health Check Lambda 内のヘルパーを pin する。Scoring の解釈は
 * `lib/utils/scoring-metadata.ts` 側で集約され、別 test file が cover する。
 */

describe("isScoringActive", () => {
  const NOW = "2026-05-08T10:00:00.000Z";

  it("eventStartsAt 未設定なら false (= deploy 直後の意図しない加点を防ぐ)", () => {
    expect(isScoringActive({}, NOW)).toBe(false);
    expect(isScoringActive({ eventStartsAt: undefined }, NOW)).toBe(false);
  });

  it("eventStartsAt が現在時刻より未来なら false (= operator が schedule 済だが時刻未到達)", () => {
    expect(isScoringActive({ eventStartsAt: "2026-05-08T10:00:00.001Z" }, NOW)).toBe(false);
    expect(isScoringActive({ eventStartsAt: "2026-05-08T11:00:00.000Z" }, NOW)).toBe(false);
  });

  it("eventStartsAt が現在時刻と同じか過去なら true (= 競技開始済、採点 active)", () => {
    expect(isScoringActive({ eventStartsAt: NOW }, NOW)).toBe(true);
    expect(isScoringActive({ eventStartsAt: "2026-05-08T09:00:00.000Z" }, NOW)).toBe(true);
    expect(isScoringActive({ eventStartsAt: "2025-01-01T00:00:00.000Z" }, NOW)).toBe(true);
  });

  it("eventEndsAt 未設定は終了 gate 無し (= 旧 deployment / 終了未指示の event の既存挙動)", () => {
    expect(isScoringActive({ eventStartsAt: "2026-05-08T09:00:00.000Z" }, NOW)).toBe(true);
    expect(
      isScoringActive({ eventStartsAt: "2026-05-08T09:00:00.000Z", eventEndsAt: undefined }, NOW),
    ).toBe(true);
  });

  it("eventEndsAt が設定済で now < eventEndsAt なら true (= まだ競技中)", () => {
    expect(
      isScoringActive(
        {
          eventStartsAt: "2026-05-08T09:00:00.000Z",
          eventEndsAt: "2026-05-08T11:00:00.000Z",
        },
        NOW,
      ),
    ).toBe(true);
  });

  it("eventEndsAt 設定済で now >= eventEndsAt なら false (= operator が終了済、採点停止)", () => {
    // ちょうど終了時刻 (= 境界値、含む側) は false
    expect(
      isScoringActive({ eventStartsAt: "2026-05-08T09:00:00.000Z", eventEndsAt: NOW }, NOW),
    ).toBe(false);
    // 既に過去
    expect(
      isScoringActive(
        {
          eventStartsAt: "2026-05-08T09:00:00.000Z",
          eventEndsAt: "2026-05-08T09:30:00.000Z",
        },
        NOW,
      ),
    ).toBe(false);
  });

  it("eventStartsAt 未到達なら eventEndsAt が未設定でも false (= 開始 gate が優先)", () => {
    expect(
      isScoringActive({ eventStartsAt: "2026-05-08T11:00:00.000Z", eventEndsAt: undefined }, NOW),
    ).toBe(false);
  });
});

describe("joinUrl", () => {
  it("path 空ならそのまま base を返すべき", () => {
    expect(joinUrl("https://x.example.com", "")).toBe("https://x.example.com");
  });

  it("base 末尾 / と path 先頭 / の二重スラッシュを正規化", () => {
    expect(joinUrl("https://x.example.com/", "/foo")).toBe("https://x.example.com/foo");
  });

  it("base 末尾 / 無し + path 先頭 / 無しは / を補う", () => {
    expect(joinUrl("https://x.example.com", "foo")).toBe("https://x.example.com/foo");
  });

  it("path が絶対 URL ならそのまま採用 (= override)", () => {
    expect(joinUrl("https://x.example.com", "https://other.example.com/health")).toBe(
      "https://other.example.com/health",
    );
  });

  it("通常 case: 末尾 / 無し base + 先頭 / path", () => {
    expect(joinUrl("https://x.example.com", "/healthz")).toBe("https://x.example.com/healthz");
  });
});

describe("parseEndpointsHealth", () => {
  it("undefined / 空文字 / 壊れた JSON は空 map を返すべき", () => {
    expect(parseEndpointsHealth(undefined)).toEqual({});
    expect(parseEndpointsHealth("")).toEqual({});
    expect(parseEndpointsHealth("{not-json")).toEqual({});
  });

  it("正常な健全性 map を decode するべき", () => {
    const raw = JSON.stringify({
      FrontendUrl: { ok: true, checkedAt: "2026-05-05T10:00:00.000Z" },
      ApiUrl: {
        ok: false,
        checkedAt: "2026-05-05T10:00:00.000Z",
        since: "2026-05-05T09:55:00.000Z",
      },
    });
    expect(parseEndpointsHealth(raw)).toEqual({
      FrontendUrl: { ok: true, checkedAt: "2026-05-05T10:00:00.000Z" },
      ApiUrl: {
        ok: false,
        checkedAt: "2026-05-05T10:00:00.000Z",
        since: "2026-05-05T09:55:00.000Z",
      },
    });
  });

  it("array や primitive は空 map を返すべき", () => {
    expect(parseEndpointsHealth(JSON.stringify(["x"]))).toEqual({});
    expect(parseEndpointsHealth(JSON.stringify(123))).toEqual({});
  });

  it("`ok` が boolean でない / `checkedAt` が string でない entry は drop", () => {
    const raw = JSON.stringify({
      Bad1: { ok: "yes", checkedAt: "2026-05-05T10:00:00.000Z" },
      Bad2: { ok: true, checkedAt: 123 },
      Good: { ok: true, checkedAt: "2026-05-05T10:00:00.000Z" },
    });
    expect(parseEndpointsHealth(raw)).toEqual({
      Good: { ok: true, checkedAt: "2026-05-05T10:00:00.000Z", since: undefined },
    });
  });
});

describe("computeSince", () => {
  const NOW = "2026-05-05T10:05:00.000Z";

  it("ok=true なら undefined", () => {
    expect(computeSince(true, undefined, NOW)).toBeUndefined();
    expect(computeSince(true, { ok: false, checkedAt: "x", since: "y" }, NOW)).toBeUndefined();
  });

  it("ok=false 新規 (prev=undefined) なら now", () => {
    expect(computeSince(false, undefined, NOW)).toBe(NOW);
  });

  it("ok=false 新規 (prev.ok=true) なら now", () => {
    const prev: EndpointHealth = { ok: true, checkedAt: "2026-05-05T10:04:00.000Z" };
    expect(computeSince(false, prev, NOW)).toBe(NOW);
  });

  it("ok=false 継続中 (prev.ok=false で prev.since あり) なら prev.since を保持", () => {
    const prev: EndpointHealth = {
      ok: false,
      checkedAt: "2026-05-05T10:04:00.000Z",
      since: "2026-05-05T09:50:00.000Z",
    };
    expect(computeSince(false, prev, NOW)).toBe("2026-05-05T09:50:00.000Z");
  });

  it("ok=false で prev.ok=false だが since 不在なら now (= データ不整合への防御)", () => {
    const prev: EndpointHealth = { ok: false, checkedAt: "2026-05-05T10:04:00.000Z" };
    expect(computeSince(false, prev, NOW)).toBe(NOW);
  });
});
