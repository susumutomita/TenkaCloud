import { afterEach, describe, expect, it, vi } from "vitest";
import type { LeaderboardResponse } from "../api/portal-client";
import {
  buildResultCardFilename,
  buildResultCardModel,
  escapeXml,
  type ResultCardBrowserAdapters,
  ResultCardError,
  type ResultCardModel,
  renderResultCardPng,
  renderResultCardSvg,
  resultCardSvgDataUrl,
  truncateCodePoints,
} from "./result-card";

afterEach(() => {
  vi.unstubAllGlobals();
});

function leaderboard(overrides: Partial<LeaderboardResponse> = {}): LeaderboardResponse {
  return {
    eventId: "event-secret-id",
    entries: [
      {
        rank: 2,
        teamId: "team-secret-id",
        teamName: "Tenka Builders 🚀",
        score: 842,
        completedProblems: 4,
        totalProblems: 6,
        isMyTeam: true,
      },
    ],
    ...overrides,
  };
}

function build(overrides: Partial<Parameters<typeof buildResultCardModel>[0]> = {}) {
  return buildResultCardModel({
    leaderboard: leaderboard(),
    eventTitle: "TenkaCloud Battle <Final>",
    generatedAt: "2026-08-12T13:00:00.000Z",
    locale: "en",
    ...overrides,
  });
}

function model(): ResultCardModel {
  const result = build();
  if (!result.ok) throw result.error;
  return result.value;
}

describe("buildResultCardModel", () => {
  it("builds an allowlisted model from exactly one current-team entry", () => {
    const result = build();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toEqual({
      eventTitle: "TenkaCloud Battle <Final>",
      teamName: "Tenka Builders 🚀",
      rank: 2,
      score: 842,
      completedProblems: 4,
      totalProblems: 6,
      status: "live",
      generatedAt: "2026-08-12T13:00:00.000Z",
      locale: "en",
    });
    expect(result.value).not.toHaveProperty("eventId");
    expect(result.value).not.toHaveProperty("teamId");
  });

  it("marks a snapshot final only when a valid event end is not later than generatedAt", () => {
    const final = build({
      leaderboard: leaderboard({ endsAt: "2026-08-12T12:59:59.000Z" }),
    });
    const future = build({
      leaderboard: leaderboard({ endsAt: "2026-08-12T13:00:01.000Z" }),
    });
    const invalid = build({ leaderboard: leaderboard({ endsAt: "not-a-date" }) });

    expect(final.ok && final.value.status).toBe("final");
    expect(future.ok && future.value.status).toBe("live");
    expect(invalid.ok && invalid.value.status).toBe("live");
  });

  it.each([
    ["scoreboard-frozen", leaderboard({ scoreboardFrozen: true, entries: [] })],
    ["missing-own-team", leaderboard({ entries: [] })],
    [
      "missing-team-name",
      leaderboard({ entries: [{ ...leaderboard().entries[0], teamName: "  " }] }),
    ],
    [
      "ambiguous-own-team",
      leaderboard({
        entries: [
          ...leaderboard().entries,
          { ...leaderboard().entries[0], teamId: "duplicate-team" },
        ],
      }),
    ],
  ] as const)("fails closed with %s", (expectedCode, source) => {
    const result = build({ leaderboard: source });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(expectedCode);
  });

  it("fails closed when the event title is blank after normalization", () => {
    const result = build({ eventTitle: "   " });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("missing-event-title");
  });

  it("fails closed when generatedAt itself is not a valid timestamp", () => {
    const result = build({ generatedAt: "not-a-date" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid-generated-at");
  });

  it.each([
    ["invalid-rank", { rank: 0 }],
    ["invalid-rank", { rank: 1.5 }],
    ["invalid-score", { score: Number.NaN }],
    ["invalid-progress", { completedProblems: 7, totalProblems: 6 }],
    ["invalid-progress", { completedProblems: 1.5 }],
  ] as const)("rejects malformed official values with %s", (expectedCode, entryPatch) => {
    const source = leaderboard({
      entries: [{ ...leaderboard().entries[0], ...entryPatch }],
    });
    const result = build({ leaderboard: source });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(expectedCode);
  });

  it("accepts negative safe-integer scores and NFC-normalizes display text", () => {
    const result = build({
      eventTitle: "Cafe\u0301",
      leaderboard: leaderboard({
        entries: [
          {
            ...leaderboard().entries[0],
            teamName: "Te\u0301am",
            score: -75,
          },
        ],
      }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.score).toBe(-75);
    expect(result.value.eventTitle).toBe("Café");
    expect(result.value.teamName).toBe("Téam");
  });
});

describe("Result Card rendering", () => {
  it("escapes XML, truncates by code point, and produces deterministic SVG", () => {
    expect(escapeXml(`<tag a="b">&'</tag>`)).toBe(
      "&lt;tag a=&quot;b&quot;&gt;&amp;&apos;&lt;/tag&gt;",
    );
    expect(truncateCodePoints("😀😀😀", 2)).toBe("😀…");
    expect(truncateCodePoints("hello", 1)).toBe("…");
    expect(truncateCodePoints("hello", 0)).toBe("…");

    const first = renderResultCardSvg(model());
    const second = renderResultCardSvg(model());
    expect(first).toBe(second);
    expect(first).toContain("TenkaCloud Battle &lt;Final&gt;");
    expect(first).not.toContain("event-secret-id");
    expect(first).not.toContain("team-secret-id");
    expect(first).not.toContain("teamLoginKey");

    const malformed = build({ eventTitle: `broken-${String.fromCharCode(0xd800)}` });
    if (!malformed.ok) throw malformed.error;
    expect(() => resultCardSvgDataUrl(malformed.value)).not.toThrow();
    expect(malformed.value.eventTitle).toContain("�");

    // A lone LOW surrogate (unpaired, no preceding high surrogate) is a distinct
    // malformed-input shape from a lone high surrogate: it must also become the
    // replacement character rather than being passed through or throwing.
    const malformedLow = build({ eventTitle: `broken-${String.fromCharCode(0xdc00)}-tail` });
    if (!malformedLow.ok) throw malformedLow.error;
    expect(malformedLow.value.eventTitle).toContain("�");
    expect(() => renderResultCardSvg(malformedLow.value)).not.toThrow();
  });

  it("normalizes untrusted display text without splitting emoji or preserving bidi controls", () => {
    const result = build({
      eventTitle: `  大会\u202e名 ${"界".repeat(60)}  `,
      leaderboard: leaderboard({
        entries: [
          {
            ...leaderboard().entries[0],
            teamName: `${"🚀".repeat(48)}\uffff`,
          },
        ],
      }),
    });
    if (!result.ok) throw result.error;

    expect(result.value.eventTitle).not.toContain("\u202e");
    expect(result.value.teamName).not.toContain("\uffff");
    expect(Array.from(result.value.teamName)).toHaveLength(48);
    expect(() => renderResultCardSvg(result.value)).not.toThrow();
  });

  it("builds a path-safe stable filename", () => {
    const result = build({
      leaderboard: leaderboard({
        entries: [{ ...leaderboard().entries[0], teamName: "../../ 天花 Team" }],
      }),
    });
    if (!result.ok) throw result.error;
    expect(buildResultCardFilename(result.value)).toBe("tenkacloud-team-live-20260812T130000Z.png");
  });

  it("falls back to a generic slug when the team name has no ASCII/digit characters", () => {
    const result = build({
      leaderboard: leaderboard({
        entries: [{ ...leaderboard().entries[0], teamName: "こんにちは" }],
      }),
    });
    if (!result.ok) throw result.error;
    expect(buildResultCardFilename(result.value)).toBe("tenkacloud-team-live-20260812T130000Z.png");
  });

  it("trims a trailing hyphen left by normalizing trailing punctuation", () => {
    const result = build({
      leaderboard: leaderboard({
        entries: [{ ...leaderboard().entries[0], teamName: "Tenka!!!" }],
      }),
    });
    if (!result.ok) throw result.error;
    expect(buildResultCardFilename(result.value)).toBe(
      "tenkacloud-tenka-live-20260812T130000Z.png",
    );
  });

  it("scales score, rank, event title, and team name font sizes at each length threshold", () => {
    // eventTitle is displayed truncated to 44 code points, teamName to 28: these lengths
    // are chosen to land in the middle bracket of each after that truncation.
    const midEventTitle = "x".repeat(35);
    const midTeamName = "y".repeat(22);

    const cases: readonly {
      readonly score: number;
      readonly rank: number;
      readonly scoreFontSize: number;
      readonly rankFontSize: number;
    }[] = [
      { score: 1234567, rank: 1234, scoreFontSize: 104, rankFontSize: 84 },
      { score: 12345678, rank: 123456, scoreFontSize: 84, rankFontSize: 64 },
      { score: 12345678901, rank: 12345, scoreFontSize: 68, rankFontSize: 84 },
    ];

    for (const testCase of cases) {
      const result = build({
        leaderboard: leaderboard({
          entries: [
            {
              ...leaderboard().entries[0],
              score: testCase.score,
              rank: testCase.rank,
              completedProblems: 0,
              totalProblems: 0,
              teamName: midTeamName,
            },
          ],
        }),
        eventTitle: midEventTitle,
      });
      if (!result.ok) throw result.error;
      const svg = renderResultCardSvg(result.value);
      expect(svg).toContain(
        `font-size="${testCase.scoreFontSize}" font-weight="800">${testCase.score}`,
      );
      expect(svg).toContain(
        `font-size="${testCase.rankFontSize}" font-weight="800">#${testCase.rank}`,
      );
      expect(svg).toContain(`font-size="24" font-weight="600">${midEventTitle}`);
      expect(svg).toContain(`font-size="44" font-weight="800">${midTeamName}`);
    }
  });

  it("renders Japanese labels and alt text for the ja locale", () => {
    const result = build({ locale: "ja" });
    if (!result.ok) throw result.error;
    const svg = renderResultCardSvg(result.value);
    expect(svg).toContain("順位");
    expect(svg).toContain("スコア");
    expect(svg).toContain("完了");
    expect(svg).toContain("生成");
    expect(svg).toContain(
      "TenkaCloud Battle &lt;Final&gt;、Tenka Builders 🚀、順位 2 位、842 点、4/6 問完了",
    );
  });

  it("rasterizes the deterministic SVG into a PNG blob", async () => {
    const png = new Blob(["png"], { type: "image/png" });
    const drawImage = vi.fn();
    const image = {
      onload: null,
      onerror: null,
      decoding: "auto",
      complete: true,
      naturalWidth: 1200,
      src: "",
      decode: vi.fn().mockResolvedValue(undefined),
    } as unknown as HTMLImageElement;
    const canvas = {
      width: 1200,
      height: 630,
      getContext: vi.fn(() => ({ clearRect: vi.fn(), drawImage })),
      toBlob: vi.fn((callback: BlobCallback) => callback(png)),
    } as unknown as HTMLCanvasElement;
    const adapters: ResultCardBrowserAdapters = {
      createImage: () => image,
      createCanvas: () => canvas,
    };

    const result = await renderResultCardPng(model(), adapters);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.type).toBe("image/png");
    expect(drawImage).toHaveBeenCalledWith(image, 0, 0, 1200, 630);
  });

  it("returns typed errors for unavailable canvas and PNG encoding", async () => {
    const image = {
      onload: null,
      onerror: null,
      decoding: "auto",
      complete: true,
      naturalWidth: 1200,
      src: "",
      decode: vi.fn().mockResolvedValue(undefined),
    } as unknown as HTMLImageElement;

    const throwingCanvas = await renderResultCardPng(model(), {
      createImage: () => image,
      createCanvas: () => {
        throw new Error("canvas creation is blocked");
      },
    });
    expect(throwingCanvas.ok).toBe(false);
    if (!throwingCanvas.ok) expect(throwingCanvas.error.code).toBe("canvas-context-unavailable");

    const noContext = await renderResultCardPng(model(), {
      createImage: () => image,
      createCanvas: () => ({ getContext: () => null }) as unknown as HTMLCanvasElement,
    });
    expect(noContext.ok).toBe(false);
    if (!noContext.ok) expect(noContext.error.code).toBe("canvas-context-unavailable");

    const drawFailure = await renderResultCardPng(model(), {
      createImage: () => image,
      createCanvas: () =>
        ({
          getContext: () => ({
            clearRect: vi.fn(),
            drawImage: () => {
              throw new Error("draw failed");
            },
          }),
        }) as unknown as HTMLCanvasElement,
    });
    expect(drawFailure.ok).toBe(false);
    if (!drawFailure.ok) expect(drawFailure.error.code).toBe("canvas-render-failed");

    const emptyBlob = await renderResultCardPng(model(), {
      createImage: () => image,
      createCanvas: () =>
        ({
          getContext: () => ({ clearRect: vi.fn(), drawImage: vi.fn() }),
          toBlob: (callback: BlobCallback) => callback(null),
        }) as unknown as HTMLCanvasElement,
    });
    expect(emptyBlob.ok).toBe(false);
    if (!emptyBlob.ok) {
      expect(emptyBlob.error).toBeInstanceOf(ResultCardError);
      expect(emptyBlob.error.code).toBe("png-encoding-failed");
    }
  });

  it("wraps a non-ResultCardError failure from canvas encoding as png-encoding-failed", async () => {
    const image = {
      onload: null,
      onerror: null,
      decoding: "auto",
      complete: true,
      naturalWidth: 1200,
      src: "",
      decode: vi.fn().mockResolvedValue(undefined),
    } as unknown as HTMLImageElement;

    const result = await renderResultCardPng(model(), {
      createImage: () => image,
      createCanvas: () =>
        ({
          getContext: () => ({ clearRect: vi.fn(), drawImage: vi.fn() }),
          toBlob: () => {
            throw new Error("toBlob crashed");
          },
        }) as unknown as HTMLCanvasElement,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ResultCardError);
      expect(result.error.code).toBe("png-encoding-failed");
      expect(result.error.cause).toBeInstanceOf(Error);
    }
  });

  it("falls back to the load event when the image has no decode() method", async () => {
    const png = new Blob(["png"], { type: "image/png" });
    const image = {
      onload: null,
      onerror: null,
      decoding: "auto",
      complete: false,
      naturalWidth: 0,
      src: "",
    } as unknown as HTMLImageElement;
    const canvas = {
      getContext: () => ({ clearRect: vi.fn(), drawImage: vi.fn() }),
      toBlob: (callback: BlobCallback) => callback(png),
    } as unknown as HTMLCanvasElement;

    const pending = renderResultCardPng(model(), {
      createImage: () => image,
      createCanvas: () => canvas,
    });
    await Promise.resolve();
    (image as unknown as { onload: () => void }).onload();

    const result = await pending;
    expect(result.ok).toBe(true);
  });

  it("recovers from a decode() rejection when the image already finished loading", async () => {
    const png = new Blob(["png"], { type: "image/png" });
    const image = {
      onload: null,
      onerror: null,
      decoding: "auto",
      complete: true,
      naturalWidth: 1200,
      src: "",
      decode: vi.fn().mockRejectedValue(new Error("decode unsupported")),
    } as unknown as HTMLImageElement;
    const canvas = {
      getContext: () => ({ clearRect: vi.fn(), drawImage: vi.fn() }),
      toBlob: (callback: BlobCallback) => callback(png),
    } as unknown as HTMLCanvasElement;

    const result = await renderResultCardPng(model(), {
      createImage: () => image,
      createCanvas: () => canvas,
    });
    expect(result.ok).toBe(true);
  });

  it("falls back to the load event when decode() rejects on an incomplete image, and rethrows the original error if loading also fails", async () => {
    const decodeError = new Error("decode failed");
    const image = {
      onload: null,
      onerror: null,
      decoding: "auto",
      complete: false,
      naturalWidth: 0,
      src: "",
      decode: vi.fn().mockRejectedValue(decodeError),
    } as unknown as HTMLImageElement;

    const pending = renderResultCardPng(model(), {
      createImage: () => image,
      createCanvas: () => ({ getContext: () => null }) as unknown as HTMLCanvasElement,
    });
    await Promise.resolve();
    await Promise.resolve();
    (image as unknown as { onerror: (event: unknown) => void }).onerror(new Event("error"));

    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("image-decode-failed");
      expect(result.error.cause).toBe(decodeError);
    }
  });

  it("returns browser-unavailable when no adapters are supplied and Image is undefined", async () => {
    // Whether document/window are visible to this module varies with which other
    // test files ran earlier in the same worker (observed empirically), so force
    // the condition explicitly rather than relying on ambient state.
    vi.stubGlobal("Image", undefined);
    const result = await renderResultCardPng(model());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("browser-unavailable");
  });
});
