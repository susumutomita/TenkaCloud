import { describe, expect, it } from "vitest";
import {
  createRateLimiter,
  RATE_LIMITS,
} from "../../lib/problem-deploy/handlers/shared/rate-limiter";

describe("createRateLimiter", () => {
  it("the first take should be allowed (lazy init, full capacity)", () => {
    const limiter = createRateLimiter({ now: () => 0 });
    const out = limiter.take("k", RATE_LIMITS.WRITE_LOW);
    expect(out.allowed).toBe(true);
    expect(out.retryAfterSec).toBe(0);
  });

  it("should reject the next take once capacity is exhausted", () => {
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

  it("should refill over time (1 token per second at refillPerSec=1)", () => {
    let t = 0;
    const limiter = createRateLimiter({ now: () => t });
    const config = { capacity: 1, refillPerSec: 1 };
    expect(limiter.take("k", config).allowed).toBe(true);
    expect(limiter.take("k", config).allowed).toBe(false);
    t = 1000;
    expect(limiter.take("k", config).allowed).toBe(true);
  });

  it("should not refill beyond capacity (burst cap)", () => {
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

  it("different keys should have independent buckets (team1 exhaustion doesn't affect team2)", () => {
    const limiter = createRateLimiter({ now: () => 0 });
    const config = { capacity: 1, refillPerSec: 0 };
    expect(limiter.take("team1", config).allowed).toBe(true);
    expect(limiter.take("team1", config).allowed).toBe(false);
    expect(limiter.take("team2", config).allowed).toBe(true);
  });

  it("retryAfterSec should approximate the time until the next token is available (derived from refillPerSec)", () => {
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

  it("should clamp retryAfterSec to 60 when refillPerSec=0 (full stop)", () => {
    const limiter = createRateLimiter({ now: () => 0 });
    const config = { capacity: 1, refillPerSec: 0 };
    expect(limiter.take("k", config).allowed).toBe(true);
    const denied = limiter.take("k", config);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec).toBe(60);
  });

  it("reset() should wipe all buckets", () => {
    const limiter = createRateLimiter({ now: () => 0 });
    const config = { capacity: 1, refillPerSec: 0 };
    limiter.take("k", config);
    expect(limiter.take("k", config).allowed).toBe(false);
    limiter.reset();
    expect(limiter.take("k", config).allowed).toBe(true);
  });

  it("RATE_LIMITS.WRITE_LOW should be 10 burst / 0.2 RPS (12 RPM) (general human writes)", () => {
    expect(RATE_LIMITS.WRITE_LOW.capacity).toBe(10);
    expect(RATE_LIMITS.WRITE_LOW.refillPerSec).toBe(0.2);
  });

  it("Issue #870: RATE_LIMITS.WRITE_VERY_LOW should be 3 burst / 0.1 RPS (6 RPM) (submit-flag brute force throttle)", () => {
    expect(RATE_LIMITS.WRITE_VERY_LOW.capacity).toBe(3);
    expect(RATE_LIMITS.WRITE_VERY_LOW.refillPerSec).toBe(0.1);
  });

  it("RATE_LIMITS.READ_HIGH should be 60 burst / 2 RPS (doesn't impede 5s polling)", () => {
    expect(RATE_LIMITS.READ_HIGH.capacity).toBe(60);
    expect(RATE_LIMITS.READ_HIGH.refillPerSec).toBe(2);
  });

  it("RATE_LIMITS.READ_MID should be 60 burst / 1 RPS (ample for 60s polling)", () => {
    expect(RATE_LIMITS.READ_MID.capacity).toBe(60);
    expect(RATE_LIMITS.READ_MID.refillPerSec).toBe(1);
  });
});
