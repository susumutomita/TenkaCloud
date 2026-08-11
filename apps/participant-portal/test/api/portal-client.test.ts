import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteProblemEndpointOverride,
  getDeployLogs,
  getNotifications,
  getPortalMe,
  listProblemEndpoints,
  PortalAuthError,
  PortalNetworkError,
  PortalScoringGateError,
  PortalValidationError,
  putProblemEndpointOverride,
  submitFlag,
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

  it("should GET apiBaseUrl + /portal/me with Bearer and return the view", async () => {
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
    // Issue #2190: without cache:"no-store" the browser HTTP cache can serve a
    // stale response for a manual refetch (refresh button / post-publish
    // reload) even though a full page reload would revalidate.
    expect(init.cache).toBe("no-store");
  });

  it("should produce the same URL regardless of trailing slash", async () => {
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

  it("should throw PortalAuthError on 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
    await expect(getPortalMe("https://x", KEY)).rejects.toBeInstanceOf(PortalAuthError);
  });

  it("should throw PortalNetworkError on 500 (with status and body)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => Promise.resolve(new Response("ddb down", { status: 500 }))),
    );
    await expect(getPortalMe("https://x", KEY)).rejects.toBeInstanceOf(PortalNetworkError);
    // Issue #873: regex regression を回避。
    await expect(getPortalMe("https://x", KEY)).rejects.toMatchObject({
      message: expect.stringMatching(/500.*ddb down/),
    });
  });

  it("should propagate AbortSignal to fetch", async () => {
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

describe("getNotifications", () => {
  afterEach(() => vi.restoreAllMocks());

  it("should GET /portal/me/notifications with Bearer and return the response", async () => {
    const payload = {
      eventId: "01HZX",
      items: [
        {
          notificationId: "01J0",
          title: "scoring 再開",
          body: "メンテ完了",
          severity: "info",
          occurredAt: "2026-05-10T14:42:00.000Z",
        },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const out = await getNotifications("https://api.example.com", KEY);
    expect(out?.eventId).toBe("01HZX");
    expect(out?.items).toHaveLength(1);

    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(url.toString()).toBe("https://api.example.com/portal/me/notifications");
  });

  it("should return undefined on 404 (no_event) (legacy jobId-based deployment compatibility)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "no_event" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await getNotifications("https://x", KEY)).toBeUndefined();
  });

  it("should include ?limit=N in the query when limit is passed", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ eventId: "X", items: [] }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await getNotifications("https://x", KEY, 50);
    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(url.searchParams.get("limit")).toBe("50");
  });
});

describe("getDeployLogs", () => {
  afterEach(() => vi.restoreAllMocks());

  it("should put jobId / nextToken / limit on the query and return the CodeBuild log response", async () => {
    const payload = {
      jobId: "01H8XGJWBWBAQ4N6RZHM4S2KMV",
      buildStatus: "IN_PROGRESS",
      complete: false,
      nextToken: "next",
      entries: [
        {
          id: "1",
          timestamp: "2026-05-20T10:00:00.000Z",
          source: "codebuild",
          message: "install phase",
        },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const out = await getDeployLogs("https://api.example.com", KEY, payload.jobId, {
      nextToken: "prev",
      limit: 25,
    });

    expect(out.entries[0]?.message).toBe("install phase");
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://api.example.com/portal/me/deploy-logs?jobId=01H8XGJWBWBAQ4N6RZHM4S2KMV&nextToken=prev&limit=25",
    );
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
  });

  it("should treat 400 invalid_jobid as PortalValidationError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "invalid_jobid" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(getDeployLogs("https://x", KEY, "bad")).rejects.toMatchObject({
      errorCode: "invalid_jobid",
    });
  });
});

describe("listProblemEndpoints", () => {
  afterEach(() => vi.restoreAllMocks());

  it("should GET /portal/me/problems/<id>/endpoints with Bearer", async () => {
    const payload = {
      teamId: "team-x",
      endpoints: [
        {
          slot: "users",
          overridable: true,
          defaultUrl: "https://ec2.example.com/users",
          effectiveUrl: "https://ec2.example.com/users",
        },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const out = await listProblemEndpoints("https://api.x", KEY, "microservice-migration-battle");
    expect(out.endpoints[0]?.slot).toBe("users");
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://api.x/portal/me/problems/microservice-migration-battle/endpoints",
    );
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
  });

  it("should URL encode problemId when it contains special chars", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ teamId: "t", endpoints: [] }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    // pattern 違反だが encode は client が責任を持つ
    await listProblemEndpoints("https://x", KEY, "a/b");
    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(url.pathname).toBe("/portal/me/problems/a%2Fb/endpoints");
  });
});

describe("putProblemEndpointOverride", () => {
  afterEach(() => vi.restoreAllMocks());

  it("should POST /portal/me/problems/<id>/endpoints/<slot> { url } and return the response", async () => {
    const payload = {
      teamId: "team-x",
      endpoints: [{ slot: "users", overridable: true, effectiveUrl: "https://my-lambda.example/" }],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await putProblemEndpointOverride(
      "https://api.x",
      KEY,
      "p1",
      "users",
      "https://my-lambda.example/",
    );
    expect(out.endpoints[0]?.effectiveUrl).toBe("https://my-lambda.example/");
    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ url: "https://my-lambda.example/" });
  });

  it("should throw PortalValidationError(errorCode=invalid_url) on 400 invalid_url", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "invalid_url" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    try {
      await putProblemEndpointOverride("https://x", KEY, "p1", "users", "garbage");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PortalValidationError);
      expect((err as PortalValidationError).errorCode).toBe("invalid_url");
    }
  });

  it("should treat 409 slot_not_overridable as PortalValidationError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "slot_not_overridable" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    await expect(
      putProblemEndpointOverride("https://x", KEY, "p1", "fixed-slot", "https://x.com"),
    ).rejects.toBeInstanceOf(PortalValidationError);
  });
});

describe("submitFlag", () => {
  afterEach(() => vi.restoreAllMocks());

  it("should retain startsAt as PortalScoringGateError on 409 scoring_not_started", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: "scoring_not_started",
              startsAt: "2026-05-21T10:00:00.000Z",
            }),
            {
              status: 409,
              headers: { "content-type": "application/json" },
            },
          ),
        ),
      ),
    );

    await expect(submitFlag("https://x", KEY, "hello-world", "FLAG{demo}")).rejects.toMatchObject({
      kind: "scoring_not_started",
      startsAt: "2026-05-21T10:00:00.000Z",
    });
    await expect(submitFlag("https://x", KEY, "hello-world", "FLAG{demo}")).rejects.toBeInstanceOf(
      PortalScoringGateError,
    );
  });

  it("should omit flagId from the body for the single flag kind", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ kind: "ok", scoreDelta: 100, totalScore: 100 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await submitFlag("https://x", KEY, "hello-world", "FLAG{demo}");
    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ problemId: "hello-world", flag: "FLAG{demo}" });
  });

  it("should include flagId in the body for multi-flag submissions (Issue #1796)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ kind: "ok", scoreDelta: 300, totalScore: 300, flagId: "ep01" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const out = await submitFlag("https://x", KEY, "net-evo", "answer", "ep01");
    expect(out).toEqual({ kind: "ok", scoreDelta: 300, totalScore: 300, flagId: "ep01" });
    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ problemId: "net-evo", flag: "answer", flagId: "ep01" });
  });
});

describe("deleteProblemEndpointOverride", () => {
  afterEach(() => vi.restoreAllMocks());

  it("should DELETE /portal/me/problems/<id>/endpoints/<slot> and return the response", async () => {
    const payload = { teamId: "team-x", endpoints: [{ slot: "users", overridable: true }] };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await deleteProblemEndpointOverride("https://api.x", KEY, "p1", "users");
    expect(out.endpoints[0]?.slot).toBe("users");
    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(init.method).toBe("DELETE");
  });
});

describe("TERMINAL_STATUSES", () => {
  it("should include COMPLETE / FAILED / DELETED (for poll stop decision)", () => {
    expect(TERMINAL_STATUSES.has("COMPLETE")).toBe(true);
    expect(TERMINAL_STATUSES.has("FAILED")).toBe(true);
    expect(TERMINAL_STATUSES.has("DELETED")).toBe(true);
  });

  it("should not include PENDING / IN_PROGRESS / DELETING", () => {
    expect(TERMINAL_STATUSES.has("PENDING")).toBe(false);
    expect(TERMINAL_STATUSES.has("IN_PROGRESS")).toBe(false);
    expect(TERMINAL_STATUSES.has("DELETING")).toBe(false);
  });
});
