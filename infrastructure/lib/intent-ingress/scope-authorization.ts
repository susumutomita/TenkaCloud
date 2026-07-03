import type { VerifiedCloudActionIntent } from "@TenkaCloud/trust-bridge";

/**
 * ADR-049 Phase 4 (Issue #2293) — signed-intent ingress: scope authorization.
 *
 * A valid JWS signature proves the Cloudflare control plane authored this exact
 * `CloudActionIntent`, but it is NOT authorization: the platform still gates which
 * audience / tenant / event an ingressed intent may act for before it is re-emitted
 * onto the deploy bus. This is the ingress analogue of the customer-execution plane's
 * `checkLocalPolicy` (ADR-039): every field here is platform-local configuration the
 * remote signer cannot influence, so a compromised control plane cannot widen scope.
 *
 * All checks fail closed: an empty/absent allowlist means "not constrained on this
 * axis" (skip), a non-empty allowlist means the intent's claim MUST be a member.
 */

export interface IntentScopeConfig {
  /** When set, the intent's `audience` must equal this exactly (JWT-`aud` style). */
  readonly expectedAudience?: string;
  /** Non-empty → the intent's `source.tenantId` must be a member. */
  readonly allowedTenantIds?: readonly string[];
  /** Non-empty → the intent's `source.eventId` must be present AND a member. */
  readonly allowedEventIds?: readonly string[];
}

export type IntentScopeRejectionReason =
  | "audience-mismatch"
  | "tenant-not-allowed"
  | "event-id-missing"
  | "event-not-allowed";

export type IntentScopeVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: IntentScopeRejectionReason };

/**
 * Authorize the scope of a signature-verified intent against platform-local config.
 * Returns the first failing reason, or `{ ok: true }` when every configured axis passes.
 */
export function authorizeIntentScope(
  intent: VerifiedCloudActionIntent,
  cfg: IntentScopeConfig,
): IntentScopeVerdict {
  if (cfg.expectedAudience !== undefined && intent.audience !== cfg.expectedAudience) {
    return { ok: false, reason: "audience-mismatch" };
  }
  if (
    cfg.allowedTenantIds !== undefined &&
    cfg.allowedTenantIds.length > 0 &&
    !cfg.allowedTenantIds.includes(intent.source.tenantId)
  ) {
    return { ok: false, reason: "tenant-not-allowed" };
  }
  if (cfg.allowedEventIds !== undefined && cfg.allowedEventIds.length > 0) {
    const eventId = intent.source.eventId;
    if (eventId === undefined) {
      return { ok: false, reason: "event-id-missing" };
    }
    if (!cfg.allowedEventIds.includes(eventId)) {
      return { ok: false, reason: "event-not-allowed" };
    }
  }
  return { ok: true };
}
