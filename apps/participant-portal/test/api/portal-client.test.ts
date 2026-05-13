import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteProblemEndpointOverride,
  getNotifications,
  getPortalMe,
  listProblemEndpoints,
  PortalAuthError,
  PortalNetworkError,
  PortalValidationError,
  putProblemEndpointOverride,
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

describe("getNotifications", () => {
  afterEach(() => vi.restoreAllMocks());

  it("/portal/me/notifications を Bearer 付きで GET し response を返すべき", async () => {
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

  it("404 (no_event) は undefined を返すべき (旧 jobId-based deployment 互換)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "no_event" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await getNotifications("https://x", KEY)).toBeUndefined();
  });

  it("limit を渡したら ?limit=N で query に乗せる", async () => {
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

describe("listProblemEndpoints (ADR-012 Phase 3.A / Issue #607)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("/portal/me/problems/<id>/endpoints を Bearer 付きで GET すべき", async () => {
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

  it("problemId に special char を含むときも URL encode して送るべき", async () => {
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

  it("POST /portal/me/problems/<id>/endpoints/<slot> { url } を送り response を返すべき", async () => {
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

  it("400 invalid_url は PortalValidationError(errorCode=invalid_url) を投げるべき", async () => {
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

  it("409 slot_not_overridable も PortalValidationError として扱うべき", async () => {
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

describe("deleteProblemEndpointOverride", () => {
  afterEach(() => vi.restoreAllMocks());

  it("DELETE /portal/me/problems/<id>/endpoints/<slot> を送り response を返すべき", async () => {
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
