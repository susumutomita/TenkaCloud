import { afterEach, describe, expect, it, vi } from "vitest";
import { buildResultCardModel } from "./result-card";
import { browserSupportsFileShare, defaultResultCardRuntime } from "./ResultCard";

// A plain .ts module (no React/testing-library import), matching result-card.test.ts's
// stable pattern: exercising defaultResultCardRuntime alongside ResultCard.test.tsx's
// render()-based tests in the same file was observed to leave document undefined for
// every later test there, non-deterministically depending on run order — an
// environment race this project's test setup cannot control. Keeping the two apart
// avoids it entirely.

function leaderboard() {
  return {
    eventId: "event-id",
    entries: [
      {
        rank: 1,
        teamId: "team-id",
        teamName: "Cloud Ninjas",
        score: 500,
        completedProblems: 5,
        totalProblems: 5,
        isMyTeam: true,
      },
    ],
  };
}

function model() {
  const result = buildResultCardModel({
    leaderboard: leaderboard(),
    eventTitle: "TenkaCloud Battle",
    generatedAt: "2026-08-12T13:00:00.000Z",
    locale: "en" as const,
  });
  if (!result.ok) throw result.error;
  return result.value;
}

describe("browserSupportsFileShare (default runtime)", () => {
  it("is false when the browser has no Web Share API", () => {
    expect(browserSupportsFileShare()).toBe(false);
  });
});

describe("defaultResultCardRuntime", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("now() returns the current instant as an ISO-8601 string", () => {
    const before = Date.now();
    const iso = defaultResultCardRuntime.now();
    expect(Number.isFinite(Date.parse(iso))).toBe(true);
    expect(Date.parse(iso)).toBeGreaterThanOrEqual(before);
  });

  it("renderPng() delegates to the shared PNG renderer", async () => {
    // Whether document/window are visible to this module varies with which other
    // test files ran earlier in the same worker (observed empirically) — when they
    // are, the real jsdom Image would hang forever on a data: URL (it never fires
    // load/error/decode). Force Image unavailable so this stays deterministic; the
    // "real adapters, real document" branch is covered on its own terms in
    // result-card.test.ts.
    vi.stubGlobal("Image", undefined);
    const result = await defaultResultCardRuntime.renderPng(model());
    // This exercises the delegation itself. renderResultCardPng's own branches —
    // including both of defaultBrowserAdapters' failure paths — are covered with
    // controlled adapters in result-card.test.ts.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("browser-unavailable");
  });

  it("share() rejects when the Web Share API cannot accept this file", async () => {
    const file = new File(["png"], "card.png", { type: "image/png" });
    await expect(defaultResultCardRuntime.share(file)).rejects.toThrow(
      "File sharing is unavailable in this browser.",
    );
  });
});
