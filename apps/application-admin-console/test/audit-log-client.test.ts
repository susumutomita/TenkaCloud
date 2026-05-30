import { renderHook } from "@testing-library/react";
import { StatusCodes } from "http-status-codes";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildTenantAuditQuery,
  createTenantAuditClient,
  describeTenantAuditError,
  TenantAuditApiError,
  useTenantAuditClient,
} from "../src/api/audit-log-client";
import type { AppConfig } from "../src/config";

/**
 * Issue #1292: Tenant Admin Console 自テナント audit log client。 fetch を stub して
 * query 組み立て / Bearer header / leading-slash path 正規化 / !ok の TenantAuditApiError
 * 変換 / CSV export / hook (tokens 有無で client or null) / error 文言を pin する。
 *
 * 越境防止: client は tenantId を渡さない (= backend が JWT claim で固定) という契約上、
 * URL に tenantId が現れないことも併せて確認する。
 */
const { mockUseAuth } = vi.hoisted(() => ({ mockUseAuth: vi.fn() }));
vi.mock("../src/auth/AuthProvider", () => ({ useAuth: mockUseAuth }));

const config: AppConfig = {
  cognitoDomain: "https://example.auth.ap-northeast-1.amazoncognito.com",
  cognitoClientId: "abc",
  redirectUri: "http://localhost:5174/callback",
  scope: "openid email profile",
  tenantId: "tenant-test",
  tenantName: "Shared Pooled Tenant",
  apiBaseUrl: "https://api.example.com/prod",
  samlIdpDirectory: {},
};

afterEach(() => vi.restoreAllMocks());

describe("buildTenantAuditQuery", () => {
  it("should return an empty string when no params are provided", () => {
    expect(buildTenantAuditQuery({})).toBe("");
  });

  it("should serialize every supported filter (incl. limit=0)", () => {
    const qs = buildTenantAuditQuery({
      limit: 0,
      cursor: "cur",
      from: "2026-01-01T00:00:00Z",
      to: "2026-02-01T00:00:00Z",
      principal: "alice",
      action: "Login",
    });
    const params = new URLSearchParams(qs.replace(/^\?/, ""));
    expect(Object.fromEntries(params)).toEqual({
      limit: "0",
      cursor: "cur",
      from: "2026-01-01T00:00:00Z",
      to: "2026-02-01T00:00:00Z",
      principal: "alice",
      action: "Login",
    });
  });
});

describe("createTenantAuditClient.list", () => {
  it("should hit /admin/audit-log with the query, a Bearer token, and no tenantId", async () => {
    const page = { items: [{ id: "a1" }], nextCursor: "c2" };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(page), { status: StatusCodes.OK }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createTenantAuditClient(config, "TOKEN");
    const result = await client.list({ limit: 10, action: "Login" });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe("/prod/admin/audit-log");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("action")).toBe("Login");
    expect(url.searchParams.has("tenantId")).toBe(false);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer TOKEN");
    expect(result).toEqual(page);
  });

  it("should normalize a base URL that already ends with '/'", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: StatusCodes.OK }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createTenantAuditClient(
      { ...config, apiBaseUrl: "https://api.example.com/prod/" },
      "T",
    );
    await client.list({});

    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(url.toString()).toBe("https://api.example.com/prod/admin/audit-log");
  });
});

describe("createTenantAuditClient.exportCsv", () => {
  it("should hit the export route and return a Blob", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("a,b\n1,2", { status: StatusCodes.OK }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createTenantAuditClient(config, "T");
    const blob = await client.exportCsv({ from: "2026-01-01T00:00:00Z" });

    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(url.pathname).toBe("/prod/admin/audit-log/export");
    expect(url.searchParams.get("from")).toBe("2026-01-01T00:00:00Z");
    expect(blob).toBeInstanceOf(Blob);
  });
});

describe("createTenantAuditClient error handling", () => {
  it("should throw TenantAuditApiError with the parsed errorCode on a non-ok response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid_from" }), {
        status: StatusCodes.BAD_REQUEST,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = createTenantAuditClient(config, "T");
    await expect(client.list({})).rejects.toMatchObject({
      name: "TenantAuditApiError",
      status: StatusCodes.BAD_REQUEST,
      errorCode: "invalid_from",
    });
  });

  it("should leave errorCode undefined when the error body is not JSON", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("<html>", { status: StatusCodes.SERVICE_UNAVAILABLE }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createTenantAuditClient(config, "T");
    await expect(client.exportCsv({})).rejects.toMatchObject({
      status: StatusCodes.SERVICE_UNAVAILABLE,
      errorCode: undefined,
    });
  });

  it("should leave errorCode undefined when the JSON body has no 'error' field", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ note: "x" }), { status: StatusCodes.FORBIDDEN }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = createTenantAuditClient(config, "T");
    await expect(client.list({})).rejects.toMatchObject({
      status: StatusCodes.FORBIDDEN,
      errorCode: undefined,
    });
  });
});

describe("useTenantAuditClient", () => {
  it("should return a client when auth tokens are present", () => {
    mockUseAuth.mockReturnValue({ tokens: { idToken: "tok" } });
    const { result } = renderHook(() => useTenantAuditClient(config));
    expect(result.current).not.toBeNull();
    expect(typeof result.current?.list).toBe("function");
    expect(typeof result.current?.exportCsv).toBe("function");
  });

  it("should return null when there are no auth tokens", () => {
    mockUseAuth.mockReturnValue({ tokens: null });
    const { result } = renderHook(() => useTenantAuditClient(config));
    expect(result.current).toBeNull();
  });
});

describe("TenantAuditApiError", () => {
  it("should compose a message from status + errorCode", () => {
    expect(new TenantAuditApiError(StatusCodes.BAD_REQUEST, "invalid_limit").message).toBe(
      "TenantAudit API 400: invalid_limit",
    );
    expect(new TenantAuditApiError(StatusCodes.FORBIDDEN, undefined).message).toBe(
      "TenantAudit API 403: unknown_error",
    );
  });
});

describe("describeTenantAuditError", () => {
  it("should map 403 / 503 / 401 to their dedicated messages", () => {
    expect(
      describeTenantAuditError(new TenantAuditApiError(StatusCodes.FORBIDDEN, undefined)),
    ).toContain("TenantAdmin");
    expect(
      describeTenantAuditError(new TenantAuditApiError(StatusCodes.SERVICE_UNAVAILABLE, undefined)),
    ).toContain("audit log table");
    expect(
      describeTenantAuditError(new TenantAuditApiError(StatusCodes.UNAUTHORIZED, undefined)),
    ).toContain("再ログイン");
  });

  it("should map 400 invalid_from / invalid_to / invalid_limit / other distinctly", () => {
    expect(
      describeTenantAuditError(new TenantAuditApiError(StatusCodes.BAD_REQUEST, "invalid_from")),
    ).toContain("from");
    expect(
      describeTenantAuditError(new TenantAuditApiError(StatusCodes.BAD_REQUEST, "invalid_to")),
    ).toContain("to");
    expect(
      describeTenantAuditError(new TenantAuditApiError(StatusCodes.BAD_REQUEST, "invalid_limit")),
    ).toContain("limit");
    expect(
      describeTenantAuditError(new TenantAuditApiError(StatusCodes.BAD_REQUEST, "weird")),
    ).toBe("リクエストが無効です");
  });

  it("should fall back to a generic message with the status for other codes", () => {
    expect(
      describeTenantAuditError(
        new TenantAuditApiError(StatusCodes.INTERNAL_SERVER_ERROR, undefined),
      ),
    ).toContain("500");
  });
});
