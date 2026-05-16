import { describe, expect, it } from "vitest";
import {
  createRateLimiter,
  RATE_LIMITS,
} from "../../lib/problem-deploy/handlers/shared/rate-limiter";

describe("createRateLimiter", () => {
  it("初回 take は許可されるべき (lazy 初期化、 capacity 満タン)", () => {
    const limiter = createRateLimiter({ now: () => 0 });
    const out = limiter.take("k", RATE_LIMITS.WRITE_LOW);
    expect(out.allowed).toBe(true);
    expect(out.retryAfterSec).toBe(0);
  });

  it("capacity を使い切ったら次の take は拒否されるべき", () => {
    const t = 0;
    const limiter = createRateLimiter({ now: () => t });
    const config = { capacity: 3, refillPerSec: 0 };
    expect(limiter.take("k", config).allowed).toBe(true);
    expect(limiter.take("k", config).allowed).toBe(true);
    expect(limiter.take("k", config).allowed).toBe(true);
    const denied = limiter.take("k", config);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it("時間経過で refill されるべき (= refillPerSec=1 で 1 秒後に 1 トークン)", () => {
    let t = 0;
    const limiter = createRateLimiter({ now: () => t });
    const config = { capacity: 1, refillPerSec: 1 };
    expect(limiter.take("k", config).allowed).toBe(true);
    expect(limiter.take("k", config).allowed).toBe(false);
    t = 1000;
    expect(limiter.take("k", config).allowed).toBe(true);
  });

  it("capacity を超えて refill されないべき (= burst cap)", () => {
    let t = 0;
    const limiter = createRateLimiter({ now: () => t });
    const config = { capacity: 2, refillPerSec: 5 };
    expect(limiter.take("k", config).allowed).toBe(true);
    expect(limiter.take("k", config).allowed).toBe(true);
    expect(limiter.take("k", config).allowed).toBe(false);
    t = 60_000;
    // 60 秒経っても capacity=2 を超えない (= 3 連続 take しても 3 つ目は拒否)
    expect(limiter.take("k", config).allowed).toBe(true);
    expect(limiter.take("k", config).allowed).toBe(true);
    expect(limiter.take("k", config).allowed).toBe(false);
  });

  it("別 key は独立した bucket を持つべき (team1 が使い切っても team2 は影響なし)", () => {
    const limiter = createRateLimiter({ now: () => 0 });
    const config = { capacity: 1, refillPerSec: 0 };
    expect(limiter.take("team1", config).allowed).toBe(true);
    expect(limiter.take("team1", config).allowed).toBe(false);
    expect(limiter.take("team2", config).allowed).toBe(true);
  });

  it("retryAfterSec は次に 1 トークン取得可能な時間に近似されるべき (= refillPerSec 由来)", () => {
    const t = 0;
    const limiter = createRateLimiter({ now: () => t });
    const config = { capacity: 1, refillPerSec: 0.5 };
    expect(limiter.take("k", config).allowed).toBe(true);
    const denied = limiter.take("k", config);
    expect(denied.allowed).toBe(false);
    // 1 トークン貯まるには 1 / 0.5 = 2 秒必要
    expect(denied.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(denied.retryAfterSec).toBeLessThanOrEqual(2);
  });

  it("refillPerSec=0 (= 完全停止) の場合は retryAfterSec を 60 にクランプすべき", () => {
    const limiter = createRateLimiter({ now: () => 0 });
    const config = { capacity: 1, refillPerSec: 0 };
    expect(limiter.take("k", config).allowed).toBe(true);
    const denied = limiter.take("k", config);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec).toBe(60);
  });

  it("reset() で全 bucket を消すべき", () => {
    const limiter = createRateLimiter({ now: () => 0 });
    const config = { capacity: 1, refillPerSec: 0 };
    limiter.take("k", config);
    expect(limiter.take("k", config).allowed).toBe(false);
    limiter.reset();
    expect(limiter.take("k", config).allowed).toBe(true);
  });

  it("RATE_LIMITS.WRITE_LOW は 10 burst / 0.2 RPS (= 12 RPM) であるべき (= 人手 write 一般)", () => {
    expect(RATE_LIMITS.WRITE_LOW.capacity).toBe(10);
    expect(RATE_LIMITS.WRITE_LOW.refillPerSec).toBe(0.2);
  });

  it("Issue #870: RATE_LIMITS.WRITE_VERY_LOW は 3 burst / 0.1 RPS (= 6 RPM) であるべき (= submit-flag brute force 抑制)", () => {
    expect(RATE_LIMITS.WRITE_VERY_LOW.capacity).toBe(3);
    expect(RATE_LIMITS.WRITE_VERY_LOW.refillPerSec).toBe(0.1);
  });

  it("RATE_LIMITS.READ_HIGH は 60 burst / 2 RPS であるべき (= 5s polling 阻害しない)", () => {
    expect(RATE_LIMITS.READ_HIGH.capacity).toBe(60);
    expect(RATE_LIMITS.READ_HIGH.refillPerSec).toBe(2);
  });

  it("RATE_LIMITS.READ_MID は 60 burst / 1 RPS であるべき (= 60s polling は余裕)", () => {
    expect(RATE_LIMITS.READ_MID.capacity).toBe(60);
    expect(RATE_LIMITS.READ_MID.refillPerSec).toBe(1);
  });
});
