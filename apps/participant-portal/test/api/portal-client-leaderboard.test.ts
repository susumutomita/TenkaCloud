import { afterEach, describe, expect, it, vi } from "vitest";
import { getLeaderboard, getLeaderboardScoreEvents } from "../../src/api/portal-client";

const KEY = "AbCdEfGhIjKlMnOpQrStUvWx";
const API = "https://api.example.com";

function mockFetch(status: number, body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(status === 404 ? "" : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("getLeaderboard", () => {
  afterEach(() => vi.restoreAllMocks());

  it("should GET /portal/leaderboard with a Bearer key and return the board", async () => {
    const board = { entries: [{ rank: 1, teamName: "Alpha", isMyTeam: true }] };
    const fetchMock = mockFetch(200, board);
    const result = await getLeaderboard(API, KEY);
    expect(result).toEqual(board);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/portal/leaderboard");
  });

  it("should return undefined on 404 (legacy jobId deployment without an eventId)", async () => {
    mockFetch(404, null);
    expect(await getLeaderboard(API, KEY)).toBeUndefined();
  });
});

describe("getLeaderboardScoreEvents", () => {
  afterEach(() => vi.restoreAllMocks());

  it("should GET /portal/leaderboard/score-events and return the response", async () => {
    const data = { teams: [] };
    const fetchMock = mockFetch(200, data);
    const result = await getLeaderboardScoreEvents(API, KEY);
    expect(result).toEqual(data);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/portal/leaderboard/score-events");
  });

  it("should return undefined on 404", async () => {
    mockFetch(404, null);
    expect(await getLeaderboardScoreEvents(API, KEY)).toBeUndefined();
  });
});
