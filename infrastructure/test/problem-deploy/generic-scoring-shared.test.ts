import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isScoringActive } from "../../lib/problem-deploy/handlers/generic-scoring-handler/scoring-active";
import {
  buildSharedResources,
  joinUrl,
  parseScoringState,
  probeUrl,
} from "../../lib/problem-deploy/handlers/generic-scoring-handler/shared";
import {
  computeSince,
  type EndpointHealth,
  parseEndpointsHealth,
} from "../../lib/problem-deploy/handlers/shared/endpoints-health";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

/**
 * 旧 health-check-handler から `generic-scoring-handler/` に relocate された helper の test。
 * 動作不変 (= health-check-handler.test.ts と同一 assertion)。
 */

describe("buildSharedResources cold start (#2440 / #2442)", () => {
  const REQUIRED_ENV = {
    DEPLOYMENTS_TABLE_NAME: "Deployments",
  };

  beforeEach(() => {
    for (const [k, v] of Object.entries(REQUIRED_ENV)) process.env[k] = v;
    delete process.env.EVENTS_TABLE_NAME;
    delete process.env.PROBLEM_ENDPOINTS_TABLE_NAME;
  });
  afterEach(() => {
    for (const k of Object.keys(REQUIRED_ENV)) delete process.env[k];
    delete process.env.PROBLEM_ENDPOINTS_TABLE_NAME;
  });

  it("should not throw and should default eventsTableName to '' when EVENTS_TABLE_NAME is unset (pure SQL backend cold start)", () => {
    expect(() => buildSharedResources(makeTestControlDataRuntime())).not.toThrow();
    expect(buildSharedResources(makeTestControlDataRuntime()).eventsTableName).toBe("");
  });

  it("should still read EVENTS_TABLE_NAME when present (dynamodb/mirror backend)", () => {
    process.env.EVENTS_TABLE_NAME = "Events";
    expect(buildSharedResources(makeTestControlDataRuntime()).eventsTableName).toBe("Events");
  });

  it("should not throw and should default endpointsTableName to '' when PROBLEM_ENDPOINTS_TABLE_NAME is unset (#2442 pure SQL backend cold start)", () => {
    expect(() => buildSharedResources(makeTestControlDataRuntime())).not.toThrow();
    expect(buildSharedResources(makeTestControlDataRuntime()).endpointsTableName).toBe("");
  });

  it("should still read PROBLEM_ENDPOINTS_TABLE_NAME when present (dynamodb/mirror backend)", () => {
    process.env.PROBLEM_ENDPOINTS_TABLE_NAME = "ProblemEndpoints";
    expect(buildSharedResources(makeTestControlDataRuntime()).endpointsTableName).toBe(
      "ProblemEndpoints",
    );
  });
});

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
  });

  it("should return true with no end-gate when eventEndsAt is unset and within the liveness cap", () => {
    expect(isScoringActive({ eventStartsAt: "2026-05-08T09:00:00.000Z" }, NOW)).toBe(true);
    expect(
      isScoringActive({ eventStartsAt: "2026-05-08T09:00:00.000Z", eventEndsAt: undefined }, NOW),
    ).toBe(true);
  });

  it("should terminate a no-endsAt round once past the MAX_ROUND_DURATION cap (#1421 liveness)", () => {
    // 開始から 16 ヶ月後 (>> 30 日 cap) は endsAt 未設定でも terminal 扱い → 無限採点を排除。
    expect(isScoringActive({ eventStartsAt: "2025-01-01T00:00:00.000Z" }, NOW)).toBe(false);
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

describe("parseScoringState dispatcher state persistence", () => {
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

  it("should decode activeEffects and drop malformed entries (#1665)", () => {
    const state = parseScoringState(
      JSON.stringify({
        activeEffects: [
          { disruptionId: "d1", points: 40, expiresAtMs: 1_700_000_060_000 },
          { disruptionId: "", points: 1, expiresAtMs: 1 }, // empty id → dropped
          { disruptionId: "d2", points: "x", expiresAtMs: 1 }, // non-number points → dropped
          { disruptionId: "d3", points: 5 }, // missing expiresAtMs → dropped
          "nope", // non-object → dropped
        ],
      }),
    );
    expect(state.activeEffects).toEqual([
      { disruptionId: "d1", points: 40, expiresAtMs: 1_700_000_060_000 },
    ]);
  });

  it("should omit activeEffects when none survive parsing", () => {
    expect(parseScoringState(JSON.stringify({ activeEffects: [] })).activeEffects).toBeUndefined();
    expect(parseScoringState(JSON.stringify({ activeEffects: "x" })).activeEffects).toBeUndefined();
  });
});

describe("probeUrl (SSRF revalidation + bounded body read)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** stream-backed Response stub returning the given byte chunks via getReader(). */
  function streamResponse(status: number, chunks: readonly Uint8Array[], url?: string): unknown {
    let i = 0;
    const cancel = vi.fn(async () => undefined);
    return {
      status,
      url,
      body: {
        getReader() {
          return {
            read: async () =>
              i < chunks.length
                ? { done: false, value: chunks[i++] }
                : { done: true, value: undefined },
            cancel,
          };
        },
      },
      text: async () => chunks.map((c) => new TextDecoder().decode(c)).join(""),
    };
  }

  it("should not call fetch and return not-ok when the URL host is SSRF-blocked", async () => {
    const result = await probeUrl("http://169.254.169.254/latest/meta-data/", {
      readBody: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.status).toBeUndefined();
  });

  it("should cap the read body at MAX_BODY_BYTES (4096) for an oversized streamed response", async () => {
    const huge = new Uint8Array(5000).fill(0x61); // 5000 × 'a'
    fetchMock.mockResolvedValue(streamResponse(200, [huge]));
    const result = await probeUrl("https://team.example.com/meta", { readBody: true });
    expect(result.ok).toBe(true);
    expect(result.body).toBeDefined();
    expect((result.body as string).length).toBe(4096);
  });

  it("should treat a redirect that lands on a blocked host as not-ok and not reflect its body", async () => {
    const secret = new TextEncoder().encode("AWS_SECRET_ACCESS_KEY=leak");
    fetchMock.mockResolvedValue(
      streamResponse(200, [secret], "http://169.254.169.254/latest/meta-data/iam/"),
    );
    const result = await probeUrl("https://team.example.com/meta", { readBody: true });
    expect(result.ok).toBe(false);
    expect(result.body).toBeUndefined();
  });

  it("should read a small body via the res.text() fallback for non-stream mock responses", async () => {
    fetchMock.mockResolvedValue({ status: 200, text: async () => "platform=ok" });
    const result = await probeUrl("https://team.example.com/meta", { readBody: true });
    expect(result.ok).toBe(true);
    expect(result.body).toBe("platform=ok");
  });
});
