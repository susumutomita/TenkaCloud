import { StatusCodes } from "http-status-codes";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditApiError, createAuditClient, describeAuditError } from "../src/api/audit-client";
import type { AppConfig } from "../src/config";

/**
 * Issue #950 admin-insight audit client。 fetch を stub して
 * URL 構築 (= scope / tenantId / limit / cursor / #1292 filter params) / Bearer header /
 * !ok の AuditApiError 変換 / CSV export / 未配線時の null / error 文言を pin する。
 */
function makeConfig(adminInsightApiUrl: string): AppConfig {
  return {
    cognitoDomain: "https://example.com",
    cognitoClientId: "id",
    redirectUri: "http://localhost/callback",
    apiBaseUrl: "https://api.example.com/prod",
    scope: "openid",
    pooledApplicationAdminConsoleUrl: "",
    provisioningCodeBuildProject: "unknown",
    awsRegion: "",
    awsAccountId: "",
    adminInsightApiUrl,
    cloudWatchDashboardName: "",
    samlIdpDirectory: {},
  };
}

const BASE = "https://insight.example.com/prod";

afterEach(() => vi.restoreAllMocks());

describe("createAuditClient", () => {
  it("should return null when adminInsightApiUrl is not wired up", () => {
    expect(createAuditClient(makeConfig(""), "T")).toBeNull();
  });

  it("should still build a valid URL when the base already ends with '/'", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: StatusCodes.OK }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createAuditClient(makeConfig(`${BASE}/`), "T");
    await client?.list({ scope: "system" });

    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(url.toString()).toBe(`${BASE}/admin/insight/audit?scope=system`);
  });
});

describe("AuditClient.list", () => {
  it("should build the audit URL with scope + all filters and attach the Bearer token", async () => {
    const page = { items: [{ id: "a1" }], nextCursor: "c2" };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(page), { status: StatusCodes.OK }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createAuditClient(makeConfig(BASE), "TOKEN");
    const result = await client?.list({
      scope: "tenant",
      tenantId: "t-1",
      limit: 25,
      cursor: "cur",
      from: "2026-01-01T00:00:00Z",
      to: "2026-02-01T00:00:00Z",
      principal: "alice",
      action: "TenantCreated",
    });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe("/prod/admin/insight/audit");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      scope: "tenant",
      tenantId: "t-1",
      limit: "25",
      cursor: "cur",
      from: "2026-01-01T00:00:00Z",
      to: "2026-02-01T00:00:00Z",
      principal: "alice",
      action: "TenantCreated",
    });
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer TOKEN");
    expect(result).toEqual(page);
  });

  it("should omit optional params when only scope is provided", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: StatusCodes.OK }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createAuditClient(makeConfig(BASE), "T");
    await client?.list({ scope: "system" });

    const [url] = fetchMock.mock.calls[0] as [URL];
    expect([...url.searchParams.keys()]).toEqual(["scope"]);
  });

  it("should set limit even when it is 0 (!== undefined guard)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: StatusCodes.OK }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createAuditClient(makeConfig(BASE), "T");
    await client?.list({ scope: "system", limit: 0 });

    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(url.searchParams.get("limit")).toBe("0");
  });
});

describe("AuditClient.exportCsv", () => {
  it("should hit the export route and return a Blob", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("a,b\n1,2", { status: StatusCodes.OK }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createAuditClient(makeConfig(BASE), "T");
    const blob = await client?.exportCsv({ scope: "tenant", tenantId: "t-1", action: "Login" });

    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(url.pathname).toBe("/prod/admin/insight/audit/export");
    expect(url.searchParams.get("tenantId")).toBe("t-1");
    expect(url.searchParams.get("action")).toBe("Login");
    // instanceof Blob は fetch 実装 (undici) と global Blob が別 realm だと CI で落ち、
    // jsdom Blob は .text() を持たない。 両 impl 共通の .size で blob を realm 非依存に検証。
    expect(blob?.size).toBeGreaterThan(0);
  });

  it("should omit tenantId from the export URL for a system-scope export", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: StatusCodes.OK }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createAuditClient(makeConfig(BASE), "T");
    await client?.exportCsv({ scope: "system" });

    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(url.searchParams.has("tenantId")).toBe(false);
    expect([...url.searchParams.keys()]).toEqual(["scope"]);
  });
});

describe("AuditClient error handling", () => {
  it("should throw AuditApiError carrying the parsed errorCode on a non-ok response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid_scope" }), {
        status: StatusCodes.BAD_REQUEST,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = createAuditClient(makeConfig(BASE), "T");
    await expect(client?.list({ scope: "system" })).rejects.toMatchObject({
      name: "AuditApiError",
      status: StatusCodes.BAD_REQUEST,
      errorCode: "invalid_scope",
    });
  });

  it("should leave errorCode undefined when the error body is not JSON", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response("<html>503</html>", { status: StatusCodes.SERVICE_UNAVAILABLE }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = createAuditClient(makeConfig(BASE), "T");
    await expect(client?.list({ scope: "system" })).rejects.toMatchObject({
      status: StatusCodes.SERVICE_UNAVAILABLE,
      errorCode: undefined,
    });
  });

  it("should leave errorCode undefined when the JSON body has no 'error' field", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ message: "nope" }), { status: StatusCodes.FORBIDDEN }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = createAuditClient(makeConfig(BASE), "T");
    await expect(client?.list({ scope: "system" })).rejects.toMatchObject({
      status: StatusCodes.FORBIDDEN,
      errorCode: undefined,
    });
  });
});

describe("AuditApiError", () => {
  it("should compose a message from status + errorCode", () => {
    expect(new AuditApiError(StatusCodes.BAD_REQUEST, "invalid_tenant_id").message).toBe(
      "Audit API 400: invalid_tenant_id",
    );
    expect(new AuditApiError(StatusCodes.FORBIDDEN, undefined).message).toBe(
      "Audit API 403: unknown_error",
    );
  });
});

describe("describeAuditError", () => {
  it("should map 403 to a role-required message", () => {
    expect(describeAuditError(new AuditApiError(StatusCodes.FORBIDDEN, undefined))).toContain(
      "SystemAdmin",
    );
  });

  it("should map 503 to an unwired-table message", () => {
    expect(
      describeAuditError(new AuditApiError(StatusCodes.SERVICE_UNAVAILABLE, undefined)),
    ).toContain("AdminAuditLog");
  });

  it("should map 400 invalid_scope / invalid_tenant_id / other distinctly", () => {
    expect(
      describeAuditError(new AuditApiError(StatusCodes.BAD_REQUEST, "invalid_scope")),
    ).toContain("scope");
    expect(
      describeAuditError(new AuditApiError(StatusCodes.BAD_REQUEST, "invalid_tenant_id")),
    ).toContain("tenantId");
    expect(describeAuditError(new AuditApiError(StatusCodes.BAD_REQUEST, "something_else"))).toBe(
      "リクエストが無効です",
    );
  });

  it("should fall back to a generic message with the status for other codes", () => {
    expect(
      describeAuditError(new AuditApiError(StatusCodes.INTERNAL_SERVER_ERROR, undefined)),
    ).toContain("500");
  });
});
