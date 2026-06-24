import { afterEach, describe, expect, it, vi } from "vitest";
import { colorFor, formatElapsed } from "../src/lib/jobs-format";

/**
 * #refactor: Jobs.tsx から lib/jobs-format へ切り出した pure helper の単体テスト。
 * 旧 Jobs.test.tsx は re-export 経由でこれらを叩くが、 page test から独立して helper の
 * 分岐 (色マップ fallback / 経過時間の h・m・s 粒度 / 不正入力) を直接検証する。
 */
afterEach(() => {
  vi.useRealTimers();
});

describe("colorFor", () => {
  it("should map known statuses to a color and fall back to grey", () => {
    expect(colorFor("Succeeded")).toBe("green");
    expect(colorFor("InProgress")).toBe("blue");
    expect(colorFor("Running")).toBe("blue");
    expect(colorFor("Failed")).toBe("red");
    expect(colorFor("Stopped")).toBe("grey");
    expect(colorFor("WeirdUnknown")).toBe("grey");
  });
});

describe("formatElapsed", () => {
  it("should format elapsed time across hour / minute / second granularities", () => {
    expect(formatElapsed("2026-01-01T00:00:00Z", "2026-01-01T02:30:00Z")).toBe("2h 30m");
    expect(formatElapsed("2026-01-01T00:00:00Z", "2026-01-01T00:05:30Z")).toBe("5m 30s");
    expect(formatElapsed("2026-01-01T00:00:00Z", "2026-01-01T00:00:45Z")).toBe("45s");
  });

  it("should return em-dash for missing or unparseable start time", () => {
    expect(formatElapsed(undefined, undefined)).toBe("—");
    expect(formatElapsed("not-a-date", "2026-01-01T00:00:00Z")).toBe("—");
  });

  it("should clamp a negative interval (end before start) to zero seconds", () => {
    expect(formatElapsed("2026-01-01T00:01:00Z", "2026-01-01T00:00:00Z")).toBe("0s");
  });

  it("should use the current time when there is no end time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:10Z"));
    expect(formatElapsed("2026-01-01T00:00:00Z", undefined)).toBe("10s");
  });
});
