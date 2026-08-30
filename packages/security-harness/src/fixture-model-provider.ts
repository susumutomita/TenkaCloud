/**
 * The model-free deterministic `ModelProvider` (Issue #3036 Phase 2 Sandbox requirement: "model
 * を使わない deterministic fixture path を必須にし、orchestrator / verifier / scoring を通常 CI
 * で検証できるようにする").
 *
 * This is NOT a mock fallback for a missing live provider — see the distinction the task brief
 * both draw:
 *
 *   - a "mock fallback" would sit in a PRODUCTION code path and quietly stand in for a real
 *     dependency that failed or was never configured, hiding that failure from the caller
 *     (exactly what `PRINCIPLE_FAIL_LOUDLY_AT_BOUNDARIES` and this repo's "no false pass" rule
 *     forbid);
 *   - `FixtureModelProvider` is never selected implicitly and never substitutes for a live
 *     provider that failed to respond — it is one explicit, scripted `ModelProvider`
 *     implementation a caller constructs on purpose, specifically so `runFinders`,
 *     `dedupeFindings`, and the rest of the orchestration can be exercised deterministically in
 *     ordinary CI, in the demo CLI, and in this package's own tests, without any model or network
 *     dependency at all. A live provider's absence, timeout, or error is represented as an
 *     explicit `ModelProviderResult` value (see `./model-provider.ts`) that this same fixture can
 *     also script — it is a test double for a documented seam, not a hidden fallback.
 *
 * Determinism: a script is an ordered, fixed list of results per focus area. Each call to
 * `complete()` for a given focus area consumes the next scripted entry, so the same script always
 * produces the same sequence of outcomes — no `Math.random()`, no clock read, no real network I/O.
 */

import type { ModelProvider, ModelProviderRequest, ModelProviderResult } from "./model-provider.js";

export interface FixtureModelProviderOptions {
  /**
   * Keyed by focus area. Each call to `complete` for that focus area consumes the next entry in
   * its script, in declaration order. A focus area with no script entry left produces an explicit
   * `invalid_response` error (never a silent empty success) — see `complete` below.
   */
  readonly scripts: Readonly<Record<string, readonly ModelProviderResult[]>>;
  readonly providerId?: string;
  readonly providerVersion?: string;
}

export class FixtureModelProvider implements ModelProvider {
  readonly providerId: string;
  readonly providerVersion: string;
  private readonly scripts: Readonly<Record<string, readonly ModelProviderResult[]>>;
  private readonly cursors = new Map<string, number>();

  constructor(options: FixtureModelProviderOptions) {
    this.providerId = options.providerId ?? "fixture-no-model";
    this.providerVersion = options.providerVersion ?? "1.0.0";
    this.scripts = options.scripts;
  }

  async complete(request: ModelProviderRequest): Promise<ModelProviderResult> {
    // A real microtask hop — even a model-free fixture completes asynchronously, so callers that
    // (correctly) assume `complete()` never resolves synchronously are exercised the same way
    // here as against a live provider.
    await Promise.resolve();
    const script = this.scripts[request.focusArea];
    if (script === undefined || script.length === 0) {
      return {
        ok: false,
        error: {
          kind: "invalid_response",
          message: `fixture-model-provider: no script entries declared for focus area "${request.focusArea}"`,
          retryable: false,
        },
      };
    }
    const cursor = this.cursors.get(request.focusArea) ?? 0;
    // Once a script is exhausted, repeat its last entry rather than throwing — a caller that
    // retries past the scripted attempts (e.g. a misconfigured retry policy) gets a stable,
    // inspectable result instead of an uncaught exception from the fixture itself.
    const index = Math.min(cursor, script.length - 1);
    this.cursors.set(request.focusArea, cursor + 1);
    const entry = script[index];
    if (entry === undefined) {
      throw new Error(
        `fixture-model-provider: internal invariant violated — no script entry at index ${index}`,
      );
    }
    return entry;
  }
}

/** Convenience builder for a scripted success result — the common case for a fixture script. */
export function fixtureSuccess(
  outputText: string,
  usage: { readonly inputTokens: number; readonly outputTokens: number } = {
    inputTokens: 0,
    outputTokens: 0,
  },
): ModelProviderResult {
  return {
    ok: true,
    response: { outputText, stopReason: "end_turn", usage },
  };
}

/** Convenience builder for a scripted failure result. */
export function fixtureFailure(
  kind: "rate_limited" | "timeout" | "transport_error" | "invalid_response",
  message: string,
  retryable: boolean,
): ModelProviderResult {
  return { ok: false, error: { kind, message, retryable } };
}
