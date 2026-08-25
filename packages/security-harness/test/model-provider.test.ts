import { describe, expect, it } from "vitest";
import type { ModelProviderError } from "../src/model-provider.js";
import { isRetryableModelProviderError } from "../src/model-provider.js";

function error(overrides: Partial<ModelProviderError>): ModelProviderError {
  return { kind: "transport_error", message: "boom", retryable: false, ...overrides };
}

describe("isRetryableModelProviderError", () => {
  it("should trust the adapter's own retryable flag when true", () => {
    expect(isRetryableModelProviderError(error({ kind: "rate_limited", retryable: true }))).toBe(
      true,
    );
  });

  it("should trust the adapter's own retryable flag when false", () => {
    expect(isRetryableModelProviderError(error({ kind: "rate_limited", retryable: false }))).toBe(
      false,
    );
  });

  it("should never retry a non-retryable transport_error or invalid_response", () => {
    expect(
      isRetryableModelProviderError(error({ kind: "transport_error", retryable: false })),
    ).toBe(false);
    expect(
      isRetryableModelProviderError(error({ kind: "invalid_response", retryable: false })),
    ).toBe(false);
  });
});
