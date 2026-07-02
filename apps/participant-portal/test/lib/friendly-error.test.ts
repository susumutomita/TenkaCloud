import { describe, expect, it } from "vitest";
import {
  PortalAuthError,
  PortalNetworkError,
  PortalValidationError,
} from "../../src/api/portal-client";
import { friendlyErrorMessage } from "../../src/lib/friendly-error";

/**
 * Issue #1349: 競技者向け friendly error message を pin する。
 * raw HTTP status code / stack trace を出さない、 i18n key を呼ぶ pure 関数。
 */
function pseudoT(key: string, params?: Readonly<Record<string, string | number>>): string {
  // unit test では i18n の lookup は経由せず、 key + params をそのまま echo する。
  if (!params) return `[${key}]`;
  const paramStr = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  return `[${key}|${paramStr}]`;
}

describe("friendlyErrorMessage", () => {
  it("should translate PortalAuthError to a re-login prompt (= no raw 401 leak)", () => {
    expect(friendlyErrorMessage(new PortalAuthError(), pseudoT)).toBe(
      "[friendly_error.auth_expired]",
    );
  });

  it("should include remaining attempts when invalid_flag and ctx.flagRemainingAttempts is provided", () => {
    expect(
      friendlyErrorMessage(new PortalValidationError("invalid_flag"), pseudoT, {
        flagRemainingAttempts: 4,
      }),
    ).toBe("[friendly_error.invalid_flag_with_remaining|remaining=4]");
  });

  it("should fall back to generic invalid_flag when remaining attempts unknown", () => {
    expect(friendlyErrorMessage(new PortalValidationError("invalid_flag"), pseudoT)).toBe(
      "[friendly_error.invalid_flag]",
    );
  });

  it("should translate invalid_url validation errors", () => {
    expect(friendlyErrorMessage(new PortalValidationError("invalid_url"), pseudoT)).toBe(
      "[friendly_error.invalid_url]",
    );
  });

  it("should preserve the validation code in the generic case", () => {
    expect(friendlyErrorMessage(new PortalValidationError("unknown_slot"), pseudoT)).toBe(
      "[friendly_error.validation_generic|code=unknown_slot]",
    );
  });

  it("should translate challenge_prerequisite_not_met to the gate guidance (Issue #2283)", () => {
    expect(
      friendlyErrorMessage(
        new PortalValidationError("challenge_prerequisite_not_met", { gateProblemId: "gate-1" }),
        pseudoT,
      ),
    ).toBe("[friendly_error.prerequisite_locked]");
  });

  it("should include correlation id for PortalNetworkError when provided", () => {
    expect(
      friendlyErrorMessage(new PortalNetworkError(502, "bad gateway"), pseudoT, {
        correlationId: "corr-abc",
      }),
    ).toBe("[friendly_error.network_with_correlation|correlationId=corr-abc]");
  });

  it("should hide raw HTTP status for PortalNetworkError when no correlation id", () => {
    const out = friendlyErrorMessage(new PortalNetworkError(502, "bad gateway"), pseudoT);
    expect(out).toBe("[friendly_error.network]");
    expect(out).not.toContain("502");
  });

  it("should return the message field for vanilla Error", () => {
    expect(friendlyErrorMessage(new Error("oops"), pseudoT)).toBe("oops");
  });

  it("should fall back to unknown for non-Error throws", () => {
    expect(friendlyErrorMessage("string thrown", pseudoT)).toBe("[friendly_error.unknown]");
    expect(friendlyErrorMessage(null, pseudoT)).toBe("[friendly_error.unknown]");
  });
});
