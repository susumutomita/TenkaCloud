import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getPortalMe,
  PortalAuthError,
  PortalNetworkError,
  TERMINAL_STATUSES,
} from "../../src/api/portal-client";

const KEY = "AbCdEfGhIjKlMnOpQrStUvWx";
const VIEW = {
  team: { teamName: "Alpha", teamNameSetByCompetitor: false },
  problems: [
    {
      jobId: "JOB1",
      problemId: "p",
      region: "ap-northeast-1",
      status: "COMPLETE",
      stackOutputs: { FrontendUrl: "https://x" },
      expiresAt: 1_700_000_000,
      score: 0,
    },
  ],
};

describe("getPortalMe", () => {
  afterEach(() => vi.restoreAllMocks());

  it("apiBaseUrl + /portal/me を Bearer 付きで GET し view を返すべき", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(VIEW), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const view = await getPortalMe("https://api.example.com", KEY);
    expect(view.team.teamName).toBe("Alpha");
    expect(view.problems[0]?.jobId).toBe("JOB1");

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://api.example.com/portal/me");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
  });

  it("末尾スラッシュの有無で URL は同じになるべき", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify(VIEW), { status: 200 })),
      );
    vi.stubGlobal("fetch", fetchMock);

    await getPortalMe("https://api.example.com/", KEY);
    await getPortalMe("https://api.example.com", KEY);

    const url1 = (fetchMock.mock.calls[0] as [URL])[0].toString();
    const url2 = (fetchMock.mock.calls[1] as [URL])[0].toString();
    expect(url1).toBe(url2);
  });

  it("401 は PortalAuthError を投げるべき", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
    await expect(getPortalMe("https://x", KEY)).rejects.toBeInstanceOf(PortalAuthError);
  });

  it("500 は PortalNetworkError (status と body 含む)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => Promise.resolve(new Response("ddb down", { status: 500 }))),
    );
    await expect(getPortalMe("https://x", KEY)).rejects.toBeInstanceOf(PortalNetworkError);
    await expect(getPortalMe("https://x", KEY)).rejects.toThrow(/500.*ddb down/);
  });

  it("AbortSignal を fetch に伝播するべき", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify(VIEW), { status: 200 })),
      );
    vi.stubGlobal("fetch", fetchMock);
    const ctrl = new AbortController();
    await getPortalMe("https://x", KEY, ctrl.signal);
    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(init.signal).toBe(ctrl.signal);
  });
});

describe("TERMINAL_STATUSES", () => {
  it("COMPLETE / FAILED / DELETED を含むべき (poll 停止判定用)", () => {
    expect(TERMINAL_STATUSES.has("COMPLETE")).toBe(true);
    expect(TERMINAL_STATUSES.has("FAILED")).toBe(true);
    expect(TERMINAL_STATUSES.has("DELETED")).toBe(true);
  });

  it("PENDING / IN_PROGRESS / DELETING は含まないべき", () => {
    expect(TERMINAL_STATUSES.has("PENDING")).toBe(false);
    expect(TERMINAL_STATUSES.has("IN_PROGRESS")).toBe(false);
    expect(TERMINAL_STATUSES.has("DELETING")).toBe(false);
  });
});
