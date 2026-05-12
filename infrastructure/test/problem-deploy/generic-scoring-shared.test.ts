import { describe, expect, it } from "vitest";
import { isScoringActive } from "../../lib/problem-deploy/handlers/generic-scoring-handler/scoring-active";
import {
  joinUrl,
  parseScoringState,
} from "../../lib/problem-deploy/handlers/generic-scoring-handler/shared";
import {
  computeSince,
  type EndpointHealth,
  parseEndpointsHealth,
} from "../../lib/problem-deploy/handlers/shared/endpoints-health";

/**
 * 旧 health-check-handler から `generic-scoring-handler/` に relocate された helper の test。
 * 動作不変 (= health-check-handler.test.ts と同一 assertion)。
 */

describe("isScoringActive (relocated from health-check-handler)", () => {
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
    expect(
      isScoringActive({ eventStartsAt: "2026-05-08T09:00:00.000Z", eventEndsAt: NOW }, NOW),
    ).toBe(false);
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

describe("joinUrl (relocated from health-check-handler)", () => {
  it("path 空ならそのまま base を返すべき", () => {
    expect(joinUrl("https://x.example.com", "")).toBe("https://x.example.com");
  });

  it("base 末尾 / と path 先頭 / の二重スラッシュを正規化すべき", () => {
    expect(joinUrl("https://x.example.com/", "/foo")).toBe("https://x.example.com/foo");
  });

  it("base 末尾 / 無し + path 先頭 / 無しは / を補うべき", () => {
    expect(joinUrl("https://x.example.com", "foo")).toBe("https://x.example.com/foo");
  });

  it("path が絶対 URL ならそのまま採用すべき (= override)", () => {
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

  it("正常な健全性 map を decode すべき", () => {
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
});

describe("computeSince", () => {
  const NOW = "2026-05-05T10:05:00.000Z";

  it("ok=true なら undefined を返すべき", () => {
    expect(computeSince(true, undefined, NOW)).toBeUndefined();
    expect(computeSince(true, { ok: false, checkedAt: "x", since: "y" }, NOW)).toBeUndefined();
  });

  it("ok=false 新規 (prev=undefined) なら now を返すべき", () => {
    expect(computeSince(false, undefined, NOW)).toBe(NOW);
  });

  it("ok=false 新規 (prev.ok=true) なら now を返すべき", () => {
    const prev: EndpointHealth = { ok: true, checkedAt: "2026-05-05T10:04:00.000Z" };
    expect(computeSince(false, prev, NOW)).toBe(NOW);
  });

  it("ok=false 継続中 (prev.ok=false で prev.since あり) なら prev.since を保持すべき", () => {
    const prev: EndpointHealth = {
      ok: false,
      checkedAt: "2026-05-05T10:04:00.000Z",
      since: "2026-05-05T09:50:00.000Z",
    };
    expect(computeSince(false, prev, NOW)).toBe("2026-05-05T09:50:00.000Z");
  });
});

describe("parseScoringState (ADR-012 Phase 3.B、 dispatcher state persistence)", () => {
  it("undefined / 空文字 / 壊れた JSON は空 state を返すべき", () => {
    expect(parseScoringState(undefined)).toEqual({});
    expect(parseScoringState("")).toEqual({});
    expect(parseScoringState("{not-json")).toEqual({});
  });

  it("attackCount を数値で decode すべき", () => {
    expect(parseScoringState(JSON.stringify({ attackCount: 42 }))).toEqual({ attackCount: 42 });
  });

  it("bonusAwarded を boolean=true entries のみで decode すべき", () => {
    expect(
      parseScoringState(
        JSON.stringify({ bonusAwarded: { "all-slots": true, other: false, x: "no" } }),
      ),
    ).toEqual({ bonusAwarded: { "all-slots": true } });
  });

  it("両 field 混在を decode すべき", () => {
    expect(
      parseScoringState(JSON.stringify({ attackCount: 1, bonusAwarded: { x: true } })),
    ).toEqual({ attackCount: 1, bonusAwarded: { x: true } });
  });

  it("array や primitive は空 state を返すべき", () => {
    expect(parseScoringState(JSON.stringify([1, 2]))).toEqual({});
    expect(parseScoringState(JSON.stringify(123))).toEqual({});
  });
});
