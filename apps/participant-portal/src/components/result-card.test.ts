import { describe, expect, it, vi } from "vitest";
import type { LeaderboardResponse } from "../api/portal-client";
import {
  buildResultCardFilename,
  buildResultCardModel,
  escapeXml,
  renderResultCardPng,
  renderResultCardSvg,
  resultCardSvgDataUrl,
  ResultCardError,
  truncateCodePoints,
  type ResultCardBrowserAdapters,
  type ResultCardModel,
} from "./result-card";

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

  it.each([
    ["invalid-rank", { rank: 0 }],
    ["invalid-rank", { rank: 1.5 }],
    ["invalid-score", { score: Number.NaN }],
    ["invalid-score", { score: -1 }],
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
});

describe("Result Card rendering", () => {
  it("escapes XML, truncates by code point, and produces deterministic SVG", () => {
    expect(escapeXml(`<tag a="b">&'</tag>`)).toBe(
      "&lt;tag a=&quot;b&quot;&gt;&amp;&apos;&lt;/tag&gt;",
    );
    expect(truncateCodePoints("😀😀😀", 2)).toBe("😀…");

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
  });

  it(
    "normalizes untrusted display text without splitting emoji or preserving bidi controls",
    () => {
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
    },
  );

  it("builds a path-safe stable filename", () => {
    const result = build({
      leaderboard: leaderboard({
        entries: [{ ...leaderboard().entries[0], teamName: "../../ 天花 Team" }],
      }),
    });
    if (!result.ok) throw result.error;
    expect(buildResultCardFilename(result.value)).toBe(
      "tenkacloud-team-live-20260812T130000Z.png",
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

    const noContext = await renderResultCardPng(model(), {
      createImage: () => image,
      createCanvas: () =>
        ({ getContext: () => null } as unknown as HTMLCanvasElement),
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
});
