/**
 * Issue #767: Participant Portal の token bearer 経路で per-team rate limit を効かせる。
 *
 * Free Tier 制約 (= DDB 1/1 PROVISIONED) で DDB 経由の sliding window を入れると
 * 1 request あたり 1 RCU + 1 WCU 消費し、 25 RCU/WCU quota を 25 RPS で食い切る。
 * Lambda の reservedConcurrency = 1 を前提に、 **同 Lambda instance 内の in-memory
 * token bucket** で代替する。 同時実行が増えた場合は warm Lambda instance ごとに
 * 別 bucket になるが、 「同 team が同 instance を連打した場合」の DoS を確実に塞ぐ
 * (= shared backend 劣化を防ぐ最低限の壁)。 厳密な distributed limit が必要に
 * なったら DDB token bucket に差し替える設計余地は残す。
 */

export interface RateLimitConfig {
  /** Bucket の最大トークン数 (= burst 許容上限)。 */
  readonly capacity: number;
  /** 1 秒あたりの refill レート (= sustained throughput)。 */
  readonly refillPerSec: number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export interface RateLimitOutcome {
  readonly allowed: boolean;
  /** リクエスト拒否時、 次にトークンが取得可能になるまでの秒数 (整数、 0 以上)。 */
  readonly retryAfterSec: number;
}

export interface RateLimiterClock {
  readonly now: () => number;
}

const defaultClock: RateLimiterClock = { now: () => Date.now() };

/**
 * Token bucket rate limiter (per key)。 module scope に Map を持つ singleton-like 構造。
 *
 * `key` は通常 `${teamLoginKey}|${action}` の form (= 同 team の同 action だけを束ねる、
 * 別 action の usage と独立)。
 *
 * 戻り値の `allowed=false` は 429 Too Many Requests を返すべき signal。
 * `retryAfterSec` は HTTP `Retry-After` header の値として使える。
 */
export function createRateLimiter(clock: RateLimiterClock = defaultClock) {
  const buckets = new Map<string, Bucket>();

  return {
    /**
     * key の bucket から 1 トークン消費を試みる。
     * 不在の bucket は capacity 満タンで lazy 初期化。
     */
    take(key: string, config: RateLimitConfig): RateLimitOutcome {
      const now = clock.now();
      const bucket = buckets.get(key) ?? { tokens: config.capacity, lastRefillMs: now };
      // Refill: 経過秒数 × refillPerSec を加算 (= sliding 補充)。capacity で cap。
      const elapsedSec = Math.max(0, (now - bucket.lastRefillMs) / 1000);
      const refilled = Math.min(config.capacity, bucket.tokens + elapsedSec * config.refillPerSec);
      if (refilled >= 1) {
        bucket.tokens = refilled - 1;
        bucket.lastRefillMs = now;
        buckets.set(key, bucket);
        return { allowed: true, retryAfterSec: 0 };
      }
      // 不足。 次に 1 トークン貯まるまでの秒数を計算 (refillPerSec=0 のとき Infinity を 60 にクランプ)。
      const needed = 1 - refilled;
      const waitSec = config.refillPerSec > 0 ? Math.ceil(needed / config.refillPerSec) : 60;
      bucket.tokens = refilled;
      bucket.lastRefillMs = now;
      buckets.set(key, bucket);
      return { allowed: false, retryAfterSec: Math.max(1, waitSec) };
    },

    /** test 等で bucket を強制リセット。 */
    reset(): void {
      buckets.clear();
    },

    /** test 用 debug: 現在の bucket 残量 */
    snapshot(): ReadonlyMap<string, Readonly<Bucket>> {
      return new Map(buckets);
    },
  };
}

/**
 * デフォルト config presets。 frontend polling 経路 (= 60s leaderboard / 5s notifications)
 * を阻害しないよう、 read 系は capacity を読みやすめに取る。
 *
 *   - READ_HIGH: notification polling (= 5s 間隔) を 12 RPS burst で許容、 sustained 2 RPS
 *   - READ_MID: leaderboard / score-events (= 60s 間隔) を 30 RPS burst で許容
 *   - WRITE_LOW: submit-flag / endpoint override (= 人手の write) を 5 RPS burst、 1 RPS sustained
 */
export const RATE_LIMITS = {
  READ_HIGH: { capacity: 60, refillPerSec: 2 } as const satisfies RateLimitConfig,
  READ_MID: { capacity: 60, refillPerSec: 1 } as const satisfies RateLimitConfig,
  WRITE_LOW: { capacity: 10, refillPerSec: 0.2 } as const satisfies RateLimitConfig,
};

/** Lambda module-scope singleton (warm invoke で共有)。 */
export const participantRateLimiter = createRateLimiter();
