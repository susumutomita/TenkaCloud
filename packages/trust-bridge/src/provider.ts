import type { VerifiedCloudActionIntent } from "./schema.js";

/**
 * Issue #795: ProviderTokenExchange interface。
 *
 * 「verified intent → short-lived provider-native credential」 への変換を
 * 抽象化する。 implementation は provider 別の adapter (Phase 2 で AWS、
 * Phase 4 で GCP / Azure) が満たす。
 *
 * 重要な責務:
 *   - intent.target.provider が adapter の provider と一致することを確認
 *   - intent.constraints.ttlSeconds を provider-native lifetime に転写
 *   - intent.action.requestedScopes を provider-native scope (= AWS session
 *     policy / GCP role / Azure RBAC) に転写
 *   - intent.source.* の context を provider call の context (= ExternalId /
 *     session tags / audience claim) に転写
 */

export type ProviderId = "aws" | "azure" | "gcp" | "cloudflare";

export interface ExchangeContext {
  /**
   * adapter 側が provider への call に追加で必要な context (= AWS STS の
   * ExternalId 等)。 keys / values は adapter ごとに自由。
   */
  readonly [key: string]: unknown;
}

/**
 * Phase 2: 短命 credential の minimum 共通 shape。 adapter 別の追加 field は
 * adapter 側の concrete type で extend する (= 構造的 subtype)。
 */
export interface ProviderCredential {
  readonly provider: ProviderId;
  readonly issuedAt: string;
  readonly expiresAt: string;
  /** adapter が intent をエコーするとき (= deploy 側で audit に使う)。 */
  readonly forRequestId: string;
}

export interface ProviderTokenExchange<C extends ProviderCredential = ProviderCredential> {
  readonly provider: ProviderId;
  exchange(intent: VerifiedCloudActionIntent, context: ExchangeContext): Promise<C>;
}

export type ExchangeFailureReason =
  | "provider-mismatch"
  | "context-missing"
  | "provider-api-error"
  | "ttl-exceeded-provider-limit";

export class ExchangeError extends Error {
  readonly reason: ExchangeFailureReason;
  readonly underlying?: unknown;
  constructor(reason: ExchangeFailureReason, message: string, underlying?: unknown) {
    super(message);
    this.name = "ExchangeError";
    this.reason = reason;
    this.underlying = underlying;
  }
}
