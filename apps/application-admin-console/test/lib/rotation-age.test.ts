import { describe, expect, it } from "vitest";
import { computeRotationAge, ROTATION_AGE_WARNING_DAYS } from "../../src/lib/rotation-age";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("computeRotationAge", () => {
  it("rotatedAt があれば rotatedAt 基準で日数を返すべき", () => {
    const baseIso = "2026-04-01T00:00:00.000Z";
    const nowMs = Date.parse(baseIso) + 5 * DAY_MS;
    const res = computeRotationAge({
      createdAt: "2026-01-01T00:00:00.000Z",
      rotatedAt: baseIso,
      nowMs,
    });
    expect(res.ageDays).toBe(5);
    expect(res.hasRotated).toBe(true);
    expect(res.isStale).toBe(false);
  });

  it("rotatedAt が無ければ createdAt 基準で日数を返すべき", () => {
    const baseIso = "2026-01-01T00:00:00.000Z";
    const nowMs = Date.parse(baseIso) + 30 * DAY_MS;
    const res = computeRotationAge({ createdAt: baseIso, nowMs });
    expect(res.ageDays).toBe(30);
    expect(res.hasRotated).toBe(false);
  });

  it("経過日数が ROTATION_AGE_WARNING_DAYS を超えると isStale=true になるべき", () => {
    const baseIso = "2026-01-01T00:00:00.000Z";
    const nowMs = Date.parse(baseIso) + (ROTATION_AGE_WARNING_DAYS + 1) * DAY_MS;
    const res = computeRotationAge({ createdAt: baseIso, nowMs });
    expect(res.isStale).toBe(true);
  });

  it("境界値 (= ちょうど ROTATION_AGE_WARNING_DAYS 日) では isStale=false のままであるべき", () => {
    const baseIso = "2026-01-01T00:00:00.000Z";
    const nowMs = Date.parse(baseIso) + ROTATION_AGE_WARNING_DAYS * DAY_MS;
    const res = computeRotationAge({ createdAt: baseIso, nowMs });
    expect(res.ageDays).toBe(ROTATION_AGE_WARNING_DAYS);
    expect(res.isStale).toBe(false);
  });

  it("nowMs が base より過去でも ageDays=0 を返すべき (= マイナスを出さない)", () => {
    const baseIso = "2026-05-01T00:00:00.000Z";
    const nowMs = Date.parse(baseIso) - 5 * DAY_MS;
    const res = computeRotationAge({ createdAt: baseIso, nowMs });
    expect(res.ageDays).toBe(0);
  });
});
