/**
 * Provider-neutral model adapter contract (Issue #3036 Phase 2: "model provider adapter を定義し、
 * core contract を Claude 固有にしない").
 *
 * Nothing in this file names a vendor, a model family, or a wire protocol. A request is a plain
 * system/user prompt pair plus an output-token budget; a response is plain output text plus a
 * stop reason and usage counters. No field here is shaped after any one vendor's API (no
 * "anthropic-version" header, no vendor-specific stop-reason strings, no vendor-specific message
 * block format) — a request/response pair for a different vendor's model fits this same shape
 * without widening it.
 *
 * The ONLY implementation of `ModelProvider` in this package is `./fixture-model-provider.ts`,
 * the model-free deterministic path Issue #3036's Sandbox requirements call mandatory: "model を
 * 使わない deterministic fixture path を必須にし、orchestrator / verifier / scoring を通常 CI で
 * 検証できるようにする". A live provider (Claude or otherwise) is intentionally NOT implemented
 * here — this task's brief is explicit that "live model 呼び出しは実装しないでください". A live
 * adapter is a follow-up that implements this same interface from OUTSIDE this package (or in a
 * sibling file added later); nothing about that follow-up requires reshaping this contract, which
 * is the point of fixing it now as its own file.
 */

/** One request to a model provider. Plain text in, nothing vendor-specific. */
export interface ModelProviderRequest {
  /** Isolation identity for this call (Issue #3036 "N Finder を独立 sandbox で並列実行する") — never reused across two different Finder tasks in the same run. */
  readonly sessionId: string;
  readonly focusArea: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly maxOutputTokens: number;
}

export interface ModelProviderUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * A successful call's result. `outputText` is untrusted model output — nothing in this package
 * trusts it until `./finder-output.ts`'s `extractFinderHandoff` has schema-validated it down to a
 * witness bundle. This type does not interpret `outputText` at all.
 */
export interface ModelProviderResponse {
  readonly outputText: string;
  readonly stopReason: "end_turn" | "max_output_tokens";
  readonly usage: ModelProviderUsage;
}

/**
 * Kept intentionally small and closed: these are the failure modes Issue #3036 names explicitly
 * ("rate limit / model error / timeout の checkpoint / resume"). `transport_error` covers any
 * other network/process failure the adapter cannot classify more specifically; it does not become
 * a silent catch-all that a caller can widen into "confirmed" or "succeeded" — see
 * `isRetryableModelProviderError` below and `../finder-orchestration.ts`'s retry loop, neither of
 * which ever produces a success from an error result.
 */
export type ModelProviderErrorKind =
  | "rate_limited"
  | "timeout"
  | "transport_error"
  | "invalid_response";

export interface ModelProviderError {
  readonly kind: ModelProviderErrorKind;
  readonly message: string;
  /**
   * True only for errors the orchestrator may retry. This is the adapter's own declaration, not a
   * classifier's guess — the adapter is closest to knowing whether the same call is worth
   * repeating (e.g. a rate limit almost always is; a request rejected for being malformed almost
   * never is). "No false pass": a `retryable: false` error is never retried, no matter how many
   * attempts remain in the caller's budget.
   */
  readonly retryable: boolean;
}

export type ModelProviderResult =
  | { readonly ok: true; readonly response: ModelProviderResponse }
  | { readonly ok: false; readonly error: ModelProviderError };

/**
 * The ONLY seam between the orchestrator and any model backend. An implementation may call a live
 * API; this package never does — see the file doc comment.
 */
export interface ModelProvider {
  readonly providerId: string;
  readonly providerVersion: string;
  complete(request: ModelProviderRequest): Promise<ModelProviderResult>;
}

/**
 * Single source of truth for "is this error worth retrying" (Issue #3036 "rate limit / model
 * error / timeout の checkpoint / resume"). Deliberately trivial — the adapter's own `retryable`
 * flag is authoritative — but kept as a named function so every call site (today: the Finder
 * orchestrator's retry loop) reads the same rule and a future caller cannot quietly invent its own
 * looser one.
 */
export function isRetryableModelProviderError(error: ModelProviderError): boolean {
  return error.retryable;
}
