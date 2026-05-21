import { describe, expect, it } from "vitest";
import { isScoringActive } from "../../lib/problem-deploy/handlers/generic-scoring-handler/scoring-active";
import {
  joinUrl,
  parseScoringState,
} from "../../lib/problem-deploy/handlers/generic-scoring-handler/shared";
import {
  computeSince,
  type EndpointHealth,
  parseEndpointsHealth,
} from "../../lib/problem-deploy/handlers/shared/endpoints-health";

/**
 * 旧 health-check-handler から `generic-scoring-handler/` に relocate された helper の test。
 * 動作不変 (= health-check-handler.test.ts と同一 assertion)。
 */

describe("isScoringActive (relocated from health-check-handler)", () => {
  const NOW = "2026-05-08T10:00:00.000Z";

  it("should return false when eventStartsAt is unset (prevent unintended scoring right after deploy)", () => {
    expect(isScoringActive({}, NOW)).toBe(false);
    expect(isScoringActive({ eventStartsAt: undefined }, NOW)).toBe(false);
  });

  it("should return false when eventStartsAt is in the future (operator scheduled but time not reached)", () => {
    expect(isScoringActive({ eventStartsAt: "2026-05-08T10:00:00.001Z" }, NOW)).toBe(false);
    expect(isScoringActive({ eventStartsAt: "2026-05-08T11:00:00.000Z" }, NOW)).toBe(false);
  });

  it("should return true when eventStartsAt is at or before now (competition started, scoring active)", () => {
    expect(isScoringActive({ eventStartsAt: NOW }, NOW)).toBe(true);
    expect(isScoringActive({ eventStartsAt: "2026-05-08T09:00:00.000Z" }, NOW)).toBe(true);
    expect(isScoringActive({ eventStartsAt: "2025-01-01T00:00:00.000Z" }, NOW)).toBe(true);
  });

  it("should return true with no end-gate when eventEndsAt is unset (legacy deployment / no-end event existing behavior)", () => {
    expect(isScoringActive({ eventStartsAt: "2026-05-08T09:00:00.000Z" }, NOW)).toBe(true);
    expect(
      isScoringActive({ eventStartsAt: "2026-05-08T09:00:00.000Z", eventEndsAt: undefined }, NOW),
    ).toBe(true);
  });

  it("should return true when eventEndsAt is set and now < eventEndsAt (still competing)", () => {
    expect(
      isScoringActive(
        {
          eventStartsAt: "2026-05-08T09:00:00.000Z",
          eventEndsAt: "2026-05-08T11:00:00.000Z",
        },
        NOW,
      ),
    ).toBe(true);
  });

  it("should return false when eventEndsAt is set and now >= eventEndsAt (operator ended, scoring stopped)", () => {
    expect(
      isScoringActive({ eventStartsAt: "2026-05-08T09:00:00.000Z", eventEndsAt: NOW }, NOW),
    ).toBe(false);
    expect(
      isScoringActive(
        {
          eventStartsAt: "2026-05-08T09:00:00.000Z",
          eventEndsAt: "2026-05-08T09:30:00.000Z",
        },
        NOW,
      ),
    ).toBe(false);
  });

  it("should return false when eventStartsAt is not yet reached, even if eventEndsAt is unset (start gate takes precedence)", () => {
    expect(
      isScoringActive({ eventStartsAt: "2026-05-08T11:00:00.000Z", eventEndsAt: undefined }, NOW),
    ).toBe(false);
  });
});

describe("joinUrl (relocated from health-check-handler)", () => {
  it("should return base as-is when path is empty", () => {
    expect(joinUrl("https://x.example.com", "")).toBe("https://x.example.com");
  });

  it("should normalize the double slash between trailing / on base and leading / on path", () => {
    expect(joinUrl("https://x.example.com/", "/foo")).toBe("https://x.example.com/foo");
  });

  it("should insert a / between base without trailing / and path without leading /", () => {
    expect(joinUrl("https://x.example.com", "foo")).toBe("https://x.example.com/foo");
  });

  it("should use the path as-is when it is an absolute URL (override)", () => {
    expect(joinUrl("https://x.example.com", "https://other.example.com/health")).toBe(
      "https://other.example.com/health",
    );
  });

  it("normal case (base without trailing / + path with leading /) should join as base/path", () => {
    expect(joinUrl("https://x.example.com", "/healthz")).toBe("https://x.example.com/healthz");
  });
});

describe("parseEndpointsHealth", () => {
  it("should return an empty map for undefined / empty string / broken JSON", () => {
    expect(parseEndpointsHealth(undefined)).toEqual({});
    expect(parseEndpointsHealth("")).toEqual({});
    expect(parseEndpointsHealth("{not-json")).toEqual({});
  });

  it("should decode a valid health map", () => {
    const raw = JSON.stringify({
      FrontendUrl: { ok: true, checkedAt: "2026-05-05T10:00:00.000Z" },
      ApiUrl: {
        ok: false,
        checkedAt: "2026-05-05T10:00:00.000Z",
        since: "2026-05-05T09:55:00.000Z",
      },
    });
    expect(parseEndpointsHealth(raw)).toEqual({
      FrontendUrl: { ok: true, checkedAt: "2026-05-05T10:00:00.000Z" },
      ApiUrl: {
        ok: false,
        checkedAt: "2026-05-05T10:00:00.000Z",
        since: "2026-05-05T09:55:00.000Z",
      },
    });
  });
});

describe("computeSince", () => {
  const NOW = "2026-05-05T10:05:00.000Z";

  it("should return undefined when ok=true", () => {
    expect(computeSince(true, undefined, NOW)).toBeUndefined();
    expect(computeSince(true, { ok: false, checkedAt: "x", since: "y" }, NOW)).toBeUndefined();
  });

  it("should return now when ok=false starts fresh (prev=undefined)", () => {
    expect(computeSince(false, undefined, NOW)).toBe(NOW);
  });

  it("should return now when ok=false starts fresh (prev.ok=true)", () => {
    const prev: EndpointHealth = { ok: true, checkedAt: "2026-05-05T10:04:00.000Z" };
    expect(computeSince(false, prev, NOW)).toBe(NOW);
  });

  it("should preserve prev.since when ok=false continues (prev.ok=false with prev.since)", () => {
    const prev: EndpointHealth = {
      ok: false,
      checkedAt: "2026-05-05T10:04:00.000Z",
      since: "2026-05-05T09:50:00.000Z",
    };
    expect(computeSince(false, prev, NOW)).toBe("2026-05-05T09:50:00.000Z");
  });
});

describe("parseScoringState (ADR-012 Phase 3.B、 dispatcher state persistence)", () => {
  it("should return empty state for undefined / empty string / broken JSON", () => {
    expect(parseScoringState(undefined)).toEqual({});
    expect(parseScoringState("")).toEqual({});
    expect(parseScoringState("{not-json")).toEqual({});
  });

  it("should decode attackCount as a number", () => {
    expect(parseScoringState(JSON.stringify({ attackCount: 42 }))).toEqual({ attackCount: 42 });
  });

  it("should decode bonusAwarded only from boolean=true entries", () => {
    expect(
      parseScoringState(
        JSON.stringify({ bonusAwarded: { "all-slots": true, other: false, x: "no" } }),
      ),
    ).toEqual({ bonusAwarded: { "all-slots": true } });
  });

  it("should decode mixed-field cases", () => {
    expect(
      parseScoringState(JSON.stringify({ attackCount: 1, bonusAwarded: { x: true } })),
    ).toEqual({ attackCount: 1, bonusAwarded: { x: true } });
  });

  it("should return empty state for arrays or primitives", () => {
    expect(parseScoringState(JSON.stringify([1, 2]))).toEqual({});
    expect(parseScoringState(JSON.stringify(123))).toEqual({});
  });
});
