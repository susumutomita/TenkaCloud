import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getCliCredentials,
  getConsoleSigninUrl,
  getScoreEvents,
  revealHint,
  updateTeamName,
} from "../../src/api/portal-client";

const KEY = "AbCdEfGhIjKlMnOpQrStUvWx";
const API = "https://api.example.com";

function mockFetch(body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.restoreAllMocks());

describe("revealHint", () => {
  it("should POST the encoded hint-reveal endpoint and return the response", async () => {
    const fetchMock = mockFetch({ hintText: "look at the IAM policy" });
    const result = await revealHint(API, KEY, "prob 1", "hint/2");
    expect(result).toEqual({ hintText: "look at the IAM policy" });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("/portal/me/problems/prob%201/hints/hint%2F2/reveal");
    expect((init as RequestInit)?.method).toBe("POST");
  });
});

describe("updateTeamName", () => {
  it("should PATCH /portal/me with the new team name and return the view", async () => {
    const view = { team: { teamName: "Beta", teamNameSetByCompetitor: true }, problems: [] };
    const fetchMock = mockFetch(view);
    const result = await updateTeamName(API, KEY, "Beta");
    expect(result).toEqual(view);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("/portal/me");
    expect((init as RequestInit)?.method).toBe("PATCH");
  });
});

describe("getScoreEvents", () => {
  it("should GET /portal/me/score-events and return the response", async () => {
    const data = { entries: [] };
    const fetchMock = mockFetch(data);
    const result = await getScoreEvents(API, KEY);
    expect(result).toEqual(data);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/portal/me/score-events");
  });
});

describe("getConsoleSigninUrl", () => {
  it("should return the loginUrl field (not the whole body) for the given jobId", async () => {
    const fetchMock = mockFetch({ loginUrl: "https://console.aws.amazon.com/federated" });
    const result = await getConsoleSigninUrl(API, KEY, "JOB1");
    expect(result).toBe("https://console.aws.amazon.com/federated");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/portal/me/console-signin-url");
  });
});

describe("getCliCredentials", () => {
  it("should return the credentials field (not the whole body) for the given jobId", async () => {
    const creds = {
      accessKeyId: "ASIA-test",
      secretAccessKey: "secret",
      sessionToken: "token",
      expiration: 1_700_000_000,
    };
    const fetchMock = mockFetch({ credentials: creds });
    const result = await getCliCredentials(API, KEY, "JOB1");
    expect(result).toEqual(creds);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/portal/me/cli-credentials");
  });
});
