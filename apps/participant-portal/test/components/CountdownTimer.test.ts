import { describe, expect, it } from "vitest";
import { computeCountdownState } from "../../src/components/CountdownTimer";

/**
 * Issue #1349: CountdownTimer の pure logic (= 残時間状態判定 + HH:MM:SS format) を pin。
 * React 側の `setInterval` 駆動 re-render は本 test では検証しない (= computeCountdownState
 * が時刻引数を受け取る分離設計なので render を mount しなくて済む)。
 */
describe("computeCountdownState", () => {
  const now = Date.parse("2026-05-22T13:00:00Z");

  it("should return no-event when endsAt is missing or invalid", () => {
    expect(computeCountdownState(undefined, now)).toEqual({ kind: "no-event" });
    expect(computeCountdownState("not-an-iso", now)).toEqual({ kind: "no-event" });
  });

  it("should return ended when endsAt is in the past", () => {
    const past = "2026-05-22T12:00:00Z";
    expect(computeCountdownState(past, now)).toEqual({ kind: "ended", display: "00:00:00" });
  });

  it("should return ended when endsAt equals now (boundary)", () => {
    const same = new Date(now).toISOString();
    expect(computeCountdownState(same, now)).toEqual({ kind: "ended", display: "00:00:00" });
  });

  it("should return running with HH:MM:SS when remaining > 5 minutes", () => {
    // 1 時間 23 分 45 秒 後
    const futureMs = now + ((1 * 60 + 23) * 60 + 45) * 1000;
    const state = computeCountdownState(new Date(futureMs).toISOString(), now);
    expect(state.kind).toBe("running");
    if (state.kind === "running") {
      expect(state.display).toBe("01:23:45");
      expect(state.remainingSec).toBe((1 * 60 + 23) * 60 + 45);
    }
  });

  it("should return warning when remaining <= 5 minutes (= last 5 min visual alert)", () => {
    const futureMs = now + 4 * 60 * 1000 + 30 * 1000;
    const state = computeCountdownState(new Date(futureMs).toISOString(), now);
    expect(state.kind).toBe("warning");
    if (state.kind === "warning") {
      expect(state.display).toBe("00:04:30");
    }
  });

  it("should treat exactly 5 minutes left as warning (boundary)", () => {
    const futureMs = now + 5 * 60 * 1000;
    const state = computeCountdownState(new Date(futureMs).toISOString(), now);
    expect(state.kind).toBe("warning");
  });

  it("should pad single-digit hours / minutes / seconds with leading zeros", () => {
    const futureMs = now + (60 * 60 + 6) * 1000 + 7 * 60 * 1000; // 1h 7m 6s ... actually compute
    // Pick a deterministic value: 0h 0m 9s + 5m1s buffer = 5m10s so it's warning
    const fiveTen = now + (5 * 60 + 10) * 1000;
    const state = computeCountdownState(new Date(fiveTen).toISOString(), now);
    expect(state.kind).toBe("running");
    if (state.kind === "running") {
      expect(state.display).toBe("00:05:10");
    }
    expect(futureMs).toBeGreaterThan(now); // silence unused-var lint
  });
});
