import type { Context, Next } from 'hono';
import { createLogger } from '../lib/logger';

const logger = createLogger('rate-limit');

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

interface RequestRecord {
  count: number;
  resetTime: number;
}

const requestCounts = new Map<string, RequestRecord>();

const defaultConfig: RateLimitConfig = {
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 10, // 10 requests per minute
};

export function rateLimitMiddleware(config: Partial<RateLimitConfig> = {}) {
  const { windowMs, maxRequests } = { ...defaultConfig, ...config };

  // Cleanup old entries periodically
  setInterval(() => {
    const now = Date.now();
    for (const [key, record] of requestCounts.entries()) {
      if (record.resetTime < now) {
        requestCounts.delete(key);
      }
    }
  }, windowMs);

  return async (c: Context, next: Next) => {
    const ip =
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
      c.req.header('x-real-ip') ||
      'unknown';

    const now = Date.now();
    const record = requestCounts.get(ip);

    if (!record || record.resetTime < now) {
      // New window
      requestCounts.set(ip, {
        count: 1,
        resetTime: now + windowMs,
      });
      await next();
      return;
    }

    if (record.count >= maxRequests) {
      logger.warn({ ip, count: record.count }, 'レート制限を超過しました');
      return c.json(
        {
          error:
            'リクエスト数が上限を超えました。しばらくしてからお試しください。',
          retryAfter: Math.ceil((record.resetTime - now) / 1000),
        },
        429
      );
    }

    record.count++;
    await next();
  };
}
