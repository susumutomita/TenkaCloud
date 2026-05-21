import type { SourceBundleConfig } from "../config/config-interface.js";

/**
 * Issue #1056: deploy artifact (= `source.zip`) bucket の lifecycle policy。
 *
 * versioning=Enabled で同 key に PUT し続ける構造のため、 旧 version (= Noncurrent) が
 * 無限蓄積する。 `keepNoncurrentVersions` 世代を rollback 用に残し、 それ以上古い旧 version
 * は `expireAfterDays` 日経過で expire させる。
 *
 * 設定値は `infrastructure/environments/<env>/config.json` の `sourceBundleConfig` に住む。
 * placeholder 展開後 string で来ることがあるため `Number()` で正規化する (= dynamoDbConfig /
 * kmsConfig と同パターン)。 未指定 (= undefined) 時は default 5 / 1 を使う。
 */
const DEFAULT_KEEP_NONCURRENT_VERSIONS = 5;
const DEFAULT_EXPIRE_AFTER_DAYS = 1;

export interface SourceBundleLifecyclePolicy {
  readonly Rules: ReadonlyArray<{
    readonly ID: string;
    readonly Status: "Enabled";
    readonly Filter: Record<string, never>;
    readonly NoncurrentVersionExpiration: {
      readonly NoncurrentDays: number;
      readonly NewerNoncurrentVersions: number;
    };
  }>;
}

export function buildSourceBundleLifecyclePolicy(
  config: SourceBundleConfig | undefined,
): SourceBundleLifecyclePolicy {
  const keep = normalizePositiveInteger(
    config?.keepNoncurrentVersions,
    DEFAULT_KEEP_NONCURRENT_VERSIONS,
  );
  const days = normalizePositiveInteger(config?.expireAfterDays, DEFAULT_EXPIRE_AFTER_DAYS);
  return {
    Rules: [
      {
        ID: "keep-noncurrent-source-zip",
        Status: "Enabled",
        Filter: {},
        NoncurrentVersionExpiration: {
          NoncurrentDays: days,
          NewerNoncurrentVersions: keep,
        },
      },
    ],
  };
}

function normalizePositiveInteger(value: number | string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new Error(
      `sourceBundleConfig value must be a positive integer, got ${JSON.stringify(value)}`,
    );
  }
  return n;
}
