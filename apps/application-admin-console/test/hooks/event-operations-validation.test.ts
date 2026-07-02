import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/api/client";
import {
  formatEndEventError,
  resolveScheduledStartInput,
  validateDeployAtInput,
  validateEndsAtInput,
  validateTeardownAtInput,
} from "../../src/hooks/event-operations-validation";

/**
 * Issue #2221: direct unit tests for the pure module extracted from useEventOperations.ts.
 * The 3 datetime validators are already pinned end-to-end via useEventOperations.test.ts
 * (which re-exports them); this file adds direct-import coverage plus the 2 functions
 * (`resolveScheduledStartInput` / `formatEndEventError`) that were previously module-private
 * inside the hook and only reachable through handler behavior.
 */

const NOW = new Date("2026-05-05T10:00:00.000Z").getTime();
const t = (key: string, params?: Readonly<Record<string, string | number>>) =>
  params ? `${key}|${JSON.stringify(params)}` : key;

describe("validateEndsAtInput (direct import)", () => {
  it("should reject empty input", () => {
    expect(validateEndsAtInput("", "", undefined, NOW)).toEqual({ canSubmit: false });
  });

  it("should accept a valid future end with no startsAt constraint", () => {
    const result = validateEndsAtInput("2999-01-01", "10:00", undefined, NOW);
    expect(result.canSubmit).toBe(true);
    expect(result.value).toBeInstanceOf(Date);
  });
});

describe("validateTeardownAtInput (direct import)", () => {
  it("should reject a teardown before endsAt", () => {
    expect(
      validateTeardownAtInput("2999-01-01", "10:00", "2999-12-31T23:59:59.000Z", NOW).errorKey,
    ).toBe("event_detail.error_teardown_before_ends");
  });
});

describe("validateDeployAtInput (direct import)", () => {
  it("should reject a deploy after endsAt", () => {
    expect(
      validateDeployAtInput("2999-12-31", "23:59", "2999-01-01T00:00:00.000Z", NOW).errorKey,
    ).toBe("event_detail.error_deploy_after_ends");
  });
});

describe("resolveScheduledStartInput", () => {
  it("should require both date and time", () => {
    expect(resolveScheduledStartInput("", "", NOW, t)).toEqual({
      ok: false,
      error: "event_detail.error_date_time_required",
    });
    expect(resolveScheduledStartInput("2999-01-01", "", NOW, t)).toEqual({
      ok: false,
      error: "event_detail.error_date_time_required",
    });
  });

  it("should reject an unparseable date/time combination", () => {
    expect(resolveScheduledStartInput("2026-13-40", "99:99", NOW, t)).toEqual({
      ok: false,
      error: "event_detail.error_date_time_format",
    });
  });

  it("should reject a start time more than 60s in the past", () => {
    expect(resolveScheduledStartInput("2020-01-01", "00:00", NOW, t)).toEqual({
      ok: false,
      error: "event_detail.error_startsat_past",
    });
  });

  it("should resolve a valid future start to its ISO string", () => {
    const result = resolveScheduledStartInput("2999-01-01", "10:00", NOW, t);
    expect(result).toEqual({
      ok: true,
      startsAt: new Date("2999-01-01T10:00:00").toISOString(),
    });
  });
});

describe("formatEndEventError", () => {
  it("should format a 409 with a currentStatus payload into the with-current message", () => {
    const err = new ApiError(409, JSON.stringify({ currentStatus: "ARCHIVED" }));
    expect(formatEndEventError(err, t)).toBe(
      'event_detail.error_end_status_with_current|{"current":"ARCHIVED"}',
    );
  });

  it("should fall back to the generic status message when currentStatus is missing", () => {
    const err = new ApiError(409, JSON.stringify({ error: "conflict" }));
    expect(formatEndEventError(err, t)).toBe("event_detail.error_end_status");
  });

  it("should not special-case a non-409 ApiError", () => {
    const err = new ApiError(500, "server error");
    expect(formatEndEventError(err, t)).toBe(err.message);
  });

  it("should format a non-ApiError via toErrorMessage", () => {
    expect(formatEndEventError(new Error("boom"), t)).toBe("boom");
  });
});
