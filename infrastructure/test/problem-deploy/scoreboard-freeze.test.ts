import { describe, expect, it } from "vitest";
import {
  DEFAULT_FREEZE_MINUTES,
  isWithinFreezeWindow,
} from "../../lib/problem-deploy/handlers/participant-handler/leaderboard";

/**
 * Issue #1038 P1 #9 follow-up: scoreboard freeze window 判定の pure logic test。
 *
 * 旧 PR-1044 では DEFAULT_FREEZE_MINUTES (= 30) 固定だったが、 operator が event 単位で可変
 * 設定できるようにした (`scoreboardFreezeMinutes`)。 freeze 分数の扱い:
 *   - 0 → freeze 無効化 (= 終了直前でも順位を見せる)
 *   - 1〜180 → N 分前から freeze
 *   - undefined → default 30 分 (= 後方互換)
 *   - NaN / 負 / 上限超過 → default にフォールバック (= safe)
 */

describe("isWithinFreezeWindow (Issue #1038 P1 #9 follow-up)", () => {
  const endsAt = "2026-05-19T01:00:00.000Z";
  const endsAtMs = Date.parse(endsAt);

  it("should freeze from 30 minutes before by default (existing behavior)", () => {
    expect(isWithinFreezeWindow(endsAt, endsAtMs - 31 * 60 * 1000)).toBe(false);
    expect(isWithinFreezeWindow(endsAt, endsAtMs - 30 * 60 * 1000)).toBe(true);
    expect(isWithinFreezeWindow(endsAt, endsAtMs - 1 * 60 * 1000)).toBe(true);
  });

  it("should freeze from 60 minutes before when operator specifies 60 minutes", () => {
    expect(isWithinFreezeWindow(endsAt, endsAtMs - 61 * 60 * 1000, 60)).toBe(false);
    expect(isWithinFreezeWindow(endsAt, endsAtMs - 60 * 60 * 1000, 60)).toBe(true);
    expect(isWithinFreezeWindow(endsAt, endsAtMs - 30 * 60 * 1000, 60)).toBe(true);
  });

  it("should freeze from 10 minutes before when operator specifies 10 minutes (shorter window than default)", () => {
    expect(isWithinFreezeWindow(endsAt, endsAtMs - 31 * 60 * 1000, 10)).toBe(false);
    expect(isWithinFreezeWindow(endsAt, endsAtMs - 11 * 60 * 1000, 10)).toBe(false);
    expect(isWithinFreezeWindow(endsAt, endsAtMs - 10 * 60 * 1000, 10)).toBe(true);
  });

  it("should disable freeze when operator specifies 0 (ranking stays public even at the end)", () => {
    expect(isWithinFreezeWindow(endsAt, endsAtMs - 1 * 60 * 1000, 0)).toBe(false);
    expect(isWithinFreezeWindow(endsAt, endsAtMs - 0, 0)).toBe(false);
  });

  it("終了済 (= now ≥ endsAt) なら freeze しない (= 最終結果公開)", () => {
    expect(isWithinFreezeWindow(endsAt, endsAtMs, 30)).toBe(false);
    expect(isWithinFreezeWindow(endsAt, endsAtMs + 1000, 30)).toBe(false);
    // 0 / 60 / undefined どれでも同じ
    expect(isWithinFreezeWindow(endsAt, endsAtMs, 0)).toBe(false);
    expect(isWithinFreezeWindow(endsAt, endsAtMs, 60)).toBe(false);
    expect(isWithinFreezeWindow(endsAt, endsAtMs, undefined)).toBe(false);
  });

  it("endsAt 不在は false (= freeze 機能 disabled)", () => {
    expect(isWithinFreezeWindow(undefined, Date.now())).toBe(false);
    expect(isWithinFreezeWindow(undefined, Date.now(), 60)).toBe(false);
  });

  it("不正な endsAt (parse 不能) は false", () => {
    expect(isWithinFreezeWindow("not-a-date", Date.now(), 30)).toBe(false);
  });

  it("不正な freezeMinutes (NaN / 負 / 上限超過) は default にフォールバック", () => {
    // NaN → default 30
    expect(isWithinFreezeWindow(endsAt, endsAtMs - 30 * 60 * 1000, Number.NaN)).toBe(true);
    expect(isWithinFreezeWindow(endsAt, endsAtMs - 31 * 60 * 1000, Number.NaN)).toBe(false);
    // 負 → default 30
    expect(isWithinFreezeWindow(endsAt, endsAtMs - 30 * 60 * 1000, -1)).toBe(true);
    // 上限超過 (180 > max) → default 30
    expect(isWithinFreezeWindow(endsAt, endsAtMs - 30 * 60 * 1000, 999)).toBe(true);
    expect(isWithinFreezeWindow(endsAt, endsAtMs - 31 * 60 * 1000, 999)).toBe(false);
  });

  it("DEFAULT_FREEZE_MINUTES should be exported (for operator UI default display)", () => {
    expect(DEFAULT_FREEZE_MINUTES).toBe(30);
  });

  it("境界 1 分: endsAt 直前まで freeze (= 既存挙動を維持)", () => {
    expect(isWithinFreezeWindow(endsAt, endsAtMs - 1, 30)).toBe(true);
    // ちょうど endsAt は終了済扱い (= 上の test と一致)
    expect(isWithinFreezeWindow(endsAt, endsAtMs, 30)).toBe(false);
  });
});
