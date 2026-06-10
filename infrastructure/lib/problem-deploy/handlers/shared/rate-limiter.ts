/**
 * Issue #767: Participant Portal の token bearer 経路で per-team rate limit を効かせる。
 *
 * Free Tier 制約 (= DDB 1/1 PROVISIONED) で DDB 経由の sliding window を入れると
 * 1 request あたり 1 RCU + 1 WCU 消費し、 25 RCU/WCU quota を 25 RPS で食い切る。
 * その代替として **同 Lambda instance 内の in-memory token bucket** を使う。
 *
 * 重要 (security 上の限界): これは **best-effort の per-instance 壁** であり、
 * **cross-instance のハード保証ではない**。 participant Lambda は公開 Function URL
 * (`authType: NONE`) で `reservedConcurrentExecutions` を pin していないため、 burst で
 * warm instance が N 個に scale すると各 instance が満タンの bucket を持ち、 同一
 * `(team, route)` の実効上限は **約 N 倍** になる (= concurrency で bypass 可能)。
 * `reservedConcurrency = 1` は本質的な修正ではない (全 team を 1 instance に直列化し
 * 自滅 DoS になる)。 したがって本 limiter は「単一 instance 連打の DoS を緩める soft wall」
 * と位置づけ、 brute-force に対する実防御は **巨大な flag 鍵空間 + 競技 gate (start/end/lock)**
 * に依存する。 ハードな分散制限が要るなら DDB / atomic counter ベースに差し替える。
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
 *   - WRITE_LOW: 人手の write (= teamName / hint reveal) を 10 burst / 12 RPM で絞る
 *   - WRITE_VERY_LOW: brute force 標的になりうる write (= submit-flag) を 3 burst / 6 RPM
 *     (= 1 attempt / 10s sustained) で更に絞る。 Issue #870: 旧 WRITE_LOW 適用時は
 *     1 team / day で 17,000 attempts 可能だった。 6 RPM なら 1 day = 8,640 attempts、
 *     2 day = 17k と倍以上の遅延を強制でき、 短時間 brute force 経路を実質遮断する。
 */
export const RATE_LIMITS = {
  READ_HIGH: { capacity: 60, refillPerSec: 2 } as const satisfies RateLimitConfig,
  READ_MID: { capacity: 60, refillPerSec: 1 } as const satisfies RateLimitConfig,
  WRITE_LOW: { capacity: 10, refillPerSec: 0.2 } as const satisfies RateLimitConfig,
  WRITE_VERY_LOW: { capacity: 3, refillPerSec: 0.1 } as const satisfies RateLimitConfig,
};

/** Lambda module-scope singleton (warm invoke で共有)。 */
export const participantRateLimiter = createRateLimiter();
