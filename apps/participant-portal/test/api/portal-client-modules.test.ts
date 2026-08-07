import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getBattleAttacks,
  getCliCredentials,
  getConsoleSigninUrl,
  getProblemCatalog,
  getScoreEvents,
  issueProblemConsoleHandoff,
  resetProblem,
  revealHint,
  startProblem,
  stopProblem,
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

describe("startProblem", () => {
  it("should POST the encoded on-demand start endpoint and return the lifecycle status", async () => {
    const fetchMock = mockFetch({ status: "running" });
    const result = await startProblem(API, KEY, "prob 1");
    expect(result).toEqual({ status: "running" });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("/portal/me/problems/prob%201/start");
    expect((init as RequestInit)?.method).toBe("POST");
  });
});

describe("stopProblem", () => {
  it("should POST the encoded on-demand stop endpoint and return the lifecycle status", async () => {
    const fetchMock = mockFetch({ status: "stopped" });
    const result = await stopProblem(API, KEY, "prob/1");
    expect(result).toEqual({ status: "stopped" });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("/portal/me/problems/prob%2F1/stop");
    expect((init as RequestInit)?.method).toBe("POST");
  });
});

describe("resetProblem", () => {
  it("should POST the encoded simulated-cloud reset endpoint and return the lifecycle status", async () => {
    const fetchMock = mockFetch({ status: "running" });
    const result = await resetProblem(API, KEY, "cloud/prob 1");
    expect(result).toEqual({ status: "running" });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("/portal/me/problems/cloud%2Fprob%201/reset");
    expect((init as RequestInit)?.method).toBe("POST");
  });
});

describe("issueProblemConsoleHandoff", () => {
  it("should authenticate the handoff and return only its one-time URL", async () => {
    const fetchMock = mockFetch({
      handoffPath: "portal/me/problems/cloud%2Fprob/console?ticket=opaque-one-time",
    });
    const result = await issueProblemConsoleHandoff(API, KEY, "cloud/prob");
    expect(result).toBe(
      "https://api.example.com/portal/me/problems/cloud%2Fprob/console?ticket=opaque-one-time",
    );
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("/portal/me/problems/cloud%2Fprob/console-handoff");
    expect((init as RequestInit)?.method).toBe("POST");
    expect((init as RequestInit)?.headers).toMatchObject({ authorization: `Bearer ${KEY}` });
  });

  it("should accept a trailing API slash and reject an untrusted handoff URL", async () => {
    mockFetch({
      handoffPath: "https://attacker.example/portal/me/problems/cloud%2Fprob/console?ticket=stolen",
    });
    await expect(issueProblemConsoleHandoff(`${API}/`, KEY, "cloud/prob")).rejects.toMatchObject({
      name: "PortalNetworkError",
      status: 502,
    });
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

describe("getBattleAttacks", () => {
  it("should GET /portal/me/battle-attacks for the jobId and return the response", async () => {
    const data = { attacks: [] };
    const fetchMock = mockFetch(data);
    const result = await getBattleAttacks(API, KEY, "JOB1");
    expect(result).toEqual(data);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/portal/me/battle-attacks");
  });

  it("should include sinceMin in the query when provided", async () => {
    const fetchMock = mockFetch({ attacks: [] });
    await getBattleAttacks(API, KEY, "JOB1", 15);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("sinceMin=15");
  });
});

/**
 * [#2925 / #2926] The runtime catalog endpoint. Only local mode calls it — the Docker image
 * excludes `problems/` on purpose, so the portal's build-time glob is empty there and this
 * is the sole source for problem narrative, course tracks and plugin slots.
 */
describe("getProblemCatalog", () => {
  it("should GET the catalog endpoint with the participant bearer and return its entries", async () => {
    const fetchMock = mockFetch({ entries: [{ id: "wp-exposed-backup" }] });
    const result = await getProblemCatalog(API, KEY);
    expect(result).toEqual([{ id: "wp-exposed-backup" }]);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("/portal/problem-catalog");
    expect((init as RequestInit)?.method ?? "GET").toBe("GET");
    expect((init as RequestInit)?.headers).toMatchObject({ authorization: `Bearer ${KEY}` });
  });

  it("should treat a response with no entries field as an empty catalog", async () => {
    mockFetch({});
    expect(await getProblemCatalog(API, KEY)).toEqual([]);
  });

  it("should forward an abort signal so boot can be cancelled", async () => {
    const fetchMock = mockFetch({ entries: [] });
    const controller = new AbortController();
    await getProblemCatalog(API, KEY, { signal: controller.signal });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect((init as RequestInit)?.signal).toBe(controller.signal);
  });
});
