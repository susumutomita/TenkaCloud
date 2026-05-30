import { StatusCodes } from "http-status-codes";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTenantIdpClient,
  describeTenantIdpError,
  TenantIdpApiError,
} from "../src/api/idp-client";
import type { AppConfig } from "../src/config";

/**
 * Issue #1294: Tenant-scoped SAML IdP CRUD client。 fetch を stub して REST verb / path
 * (= idpId の encodeURIComponent) / Bearer + content-type header / create の 201 厳格判定 /
 * !ok の TenantIdpApiError 変換 / error 文言を pin する。
 *
 * 越境防止: client は tenantId を body / path に載せない (= server が JWT claim で固定)。
 */
function makeConfig(apiBaseUrl: string): AppConfig {
  return {
    cognitoDomain: "https://example.auth.ap-northeast-1.amazoncognito.com",
    cognitoClientId: "abc",
    redirectUri: "http://localhost:5174/callback",
    scope: "openid email profile",
    tenantId: "tenant-test",
    tenantName: "Shared Pooled Tenant",
    apiBaseUrl,
    samlIdpDirectory: {},
  };
}

const BASE = "https://api.example.com/prod";
const DETAIL = {
  idpId: "entra",
  displayName: "Entra ID",
  tenantId: "t-1",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  metadataXml: "<xml/>",
  attributeMapping: { email: "email" },
  groupToRole: {},
};

afterEach(() => vi.restoreAllMocks());

describe("createTenantIdpClient", () => {
  it("should return null when apiBaseUrl is not wired up", () => {
    expect(createTenantIdpClient(makeConfig(""), "T")).toBeNull();
  });

  it("should normalize a base URL that already ends with '/'", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: StatusCodes.OK }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createTenantIdpClient(makeConfig(`${BASE}/`), "T");
    await client?.list();

    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(url.toString()).toBe(`${BASE}/tenant/idp`);
  });
});

describe("TenantIdpClient verbs", () => {
  it("list() should GET tenant/idp with a Bearer token and unwrap items", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ items: [DETAIL] }), { status: StatusCodes.OK }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = createTenantIdpClient(makeConfig(BASE), "TOKEN");
    const items = await client?.list();

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe("/prod/tenant/idp");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer TOKEN");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(items).toEqual([DETAIL]);
  });

  it("get() should percent-encode the idpId in the path", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(DETAIL), { status: StatusCodes.OK }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createTenantIdpClient(makeConfig(BASE), "T");
    await client?.get("a/b c");

    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(url.pathname).toBe("/prod/tenant/idp/a%2Fb%20c");
  });

  it("create() should POST the JSON body and require a 201 response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(DETAIL), { status: StatusCodes.CREATED }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createTenantIdpClient(makeConfig(BASE), "T");
    const input = {
      idpId: "entra",
      displayName: "Entra ID",
      metadataXml: "<xml/>",
      attributeMapping: { email: "email" },
      groupToRole: {},
    };
    const created = await client?.create(input);

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe("/prod/tenant/idp");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(input);
    expect(created).toEqual(DETAIL);
  });

  it("create() should throw unexpected_status when the response is 200 instead of 201", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(DETAIL), { status: StatusCodes.OK }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createTenantIdpClient(makeConfig(BASE), "T");
    await expect(
      client?.create({
        idpId: "x",
        displayName: "x",
        metadataXml: "<x/>",
        attributeMapping: { email: "email" },
        groupToRole: {},
      }),
    ).rejects.toMatchObject({ status: StatusCodes.OK, errorCode: "unexpected_status" });
  });

  it("update() should PATCH the JSON body and return the detail", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(DETAIL), { status: StatusCodes.OK }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createTenantIdpClient(makeConfig(BASE), "T");
    await client?.update("entra", { displayName: "Renamed" });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe("/prod/tenant/idp/entra");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ displayName: "Renamed" });
  });

  it("remove() should DELETE and resolve void", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: StatusCodes.NO_CONTENT }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createTenantIdpClient(makeConfig(BASE), "T");
    await expect(client?.remove("entra")).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe("/prod/tenant/idp/entra");
    expect(init.method).toBe("DELETE");
  });
});

describe("fetchOrThrow error handling", () => {
  it("should throw TenantIdpApiError with errorCode parsed from a JSON body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid_metadata" }), {
        status: StatusCodes.BAD_REQUEST,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = createTenantIdpClient(makeConfig(BASE), "T");
    await expect(client?.list()).rejects.toMatchObject({
      name: "TenantIdpApiError",
      status: StatusCodes.BAD_REQUEST,
      errorCode: "invalid_metadata",
    });
  });

  it("should leave errorCode undefined when the body is not JSON", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("<html>", { status: StatusCodes.FORBIDDEN }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createTenantIdpClient(makeConfig(BASE), "T");
    await expect(client?.list()).rejects.toMatchObject({
      status: StatusCodes.FORBIDDEN,
      errorCode: undefined,
    });
  });

  it("should leave errorCode undefined when the body has a non-string error field", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: 42 }), { status: StatusCodes.CONFLICT }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = createTenantIdpClient(makeConfig(BASE), "T");
    await expect(client?.list()).rejects.toMatchObject({
      status: StatusCodes.CONFLICT,
      errorCode: undefined,
    });
  });
});

describe("TenantIdpApiError", () => {
  it("should compose a message from status + errorCode", () => {
    expect(new TenantIdpApiError(StatusCodes.NOT_FOUND, "missing").message).toBe(
      "Tenant IdP API 404: missing",
    );
    expect(new TenantIdpApiError(StatusCodes.FORBIDDEN, undefined).message).toBe(
      "Tenant IdP API 403: unknown_error",
    );
  });
});

describe("describeTenantIdpError", () => {
  it("should map each TenantIdpApiError status to a dedicated message", () => {
    expect(
      describeTenantIdpError(new TenantIdpApiError(StatusCodes.FORBIDDEN, undefined)),
    ).toContain("forbidden");
    expect(
      describeTenantIdpError(new TenantIdpApiError(StatusCodes.NOT_FOUND, undefined)),
    ).toContain("not found");
    expect(
      describeTenantIdpError(new TenantIdpApiError(StatusCodes.CONFLICT, undefined)),
    ).toContain("already exists");
  });

  it("should distinguish invalid_metadata from other 400 error codes", () => {
    expect(
      describeTenantIdpError(new TenantIdpApiError(StatusCodes.BAD_REQUEST, "invalid_metadata")),
    ).toContain("metadata XML rejected");
    expect(
      describeTenantIdpError(new TenantIdpApiError(StatusCodes.BAD_REQUEST, "bad_field")),
    ).toContain("bad_field");
    // errorCode 不明な 400 は validation_failed に倒す。
    expect(
      describeTenantIdpError(new TenantIdpApiError(StatusCodes.BAD_REQUEST, undefined)),
    ).toContain("validation_failed");
  });

  it("should fall back to status + errorCode for other API statuses", () => {
    expect(
      describeTenantIdpError(new TenantIdpApiError(StatusCodes.INTERNAL_SERVER_ERROR, "boom")),
    ).toContain("500");
    // errorCode 不在の default は unknown_error に倒す。
    expect(
      describeTenantIdpError(new TenantIdpApiError(StatusCodes.INTERNAL_SERVER_ERROR, undefined)),
    ).toContain("unknown_error");
  });

  it("should pass through a plain Error message and label unknown throwables", () => {
    expect(describeTenantIdpError(new Error("network down"))).toBe("network down");
    expect(describeTenantIdpError("weird")).toBe("unknown error");
  });
});
