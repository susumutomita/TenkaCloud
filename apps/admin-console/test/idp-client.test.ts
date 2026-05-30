import { StatusCodes } from "http-status-codes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdpClient, describeIdpError, IdpApiError } from "../src/api/idp-client";
import type { AppConfig } from "../src/config";

const DETAIL = {
  idpId: "okta-acme",
  displayName: "Okta",
  metadataXml: "<x/>",
  attributeMapping: { email: "email" },
  groupToRole: {},
};

const baseConfig: AppConfig = {
  cognitoDomain: "auth.example.com",
  cognitoClientId: "client-id",
  redirectUri: "http://localhost/callback",
  apiBaseUrl: "https://control.example.com/",
  scope: "openid",
  pooledApplicationAdminConsoleUrl: "",
  provisioningCodeBuildProject: "unknown",
  awsRegion: "",
  awsAccountId: "",
  adminInsightApiUrl: "",
  cloudWatchDashboardName: "",
  samlIdpDirectory: {},
};

describe("createIdpClient", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should return null when apiBaseUrl is not configured", () => {
    expect(createIdpClient({ ...baseConfig, apiBaseUrl: "" }, "token")).toBeNull();
  });

  it("should GET /admin/idp with bearer auth", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [] }), { status: 200 }),
    );
    const client = createIdpClient(baseConfig, "id-token");
    await client?.list();
    const [calledUrl, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(calledUrl)).toBe("https://control.example.com/admin/idp");
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer id-token" });
  });

  it("should throw IdpApiError with the error code on 4xx", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "conflict" }), { status: 409 }),
    );
    const client = createIdpClient(baseConfig, "id-token");
    await expect(
      client?.create({
        idpId: "okta-acme",
        displayName: "Okta",
        metadataXml: "<x/>",
        attributeMapping: { email: "x" },
        groupToRole: {},
      }),
    ).rejects.toMatchObject({ status: 409, errorCode: "conflict" });
  });

  it("should encode idpId in path params", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(null, { status: 204 }),
    );
    const client = createIdpClient(baseConfig, "id-token");
    await client?.remove("okta acme"); // space exercises encoding
    const [calledUrl] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(calledUrl)).toBe("https://control.example.com/admin/idp/okta%20acme");
  });

  it("should append a trailing slash when apiBaseUrl lacks one", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [] }), { status: StatusCodes.OK }),
    );
    const client = createIdpClient(
      { ...baseConfig, apiBaseUrl: "https://control.example.com" },
      "id-token",
    );
    await client?.list();
    const [calledUrl] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(calledUrl)).toBe("https://control.example.com/admin/idp");
  });

  it("should leave errorCode undefined when the error body has a non-string error field", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 42 }), { status: StatusCodes.FORBIDDEN }),
    );
    const client = createIdpClient(baseConfig, "id-token");
    await expect(client?.list()).rejects.toMatchObject({
      status: StatusCodes.FORBIDDEN,
      errorCode: undefined,
    });
  });

  it("should GET a single IdP by (encoded) id", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify(DETAIL), { status: StatusCodes.OK }),
    );
    const client = createIdpClient(baseConfig, "id-token");
    const detail = await client?.get("okta acme");
    const [calledUrl, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(calledUrl)).toBe("https://control.example.com/admin/idp/okta%20acme");
    expect((init as RequestInit).method).toBe("GET");
    expect(detail).toEqual(DETAIL);
  });

  it("should POST create and return the detail on 201", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify(DETAIL), { status: StatusCodes.CREATED }),
    );
    const client = createIdpClient(baseConfig, "id-token");
    const created = await client?.create({
      idpId: "okta-acme",
      displayName: "Okta",
      metadataXml: "<x/>",
      attributeMapping: { email: "email" },
      groupToRole: {},
    });
    const [calledUrl, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(calledUrl)).toBe("https://control.example.com/admin/idp");
    expect((init as RequestInit).method).toBe("POST");
    expect(created).toEqual(DETAIL);
  });

  it("should throw unexpected_status when create returns 200 instead of 201", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify(DETAIL), { status: StatusCodes.OK }),
    );
    const client = createIdpClient(baseConfig, "id-token");
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

  it("should PATCH update and return the detail", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify(DETAIL), { status: StatusCodes.OK }),
    );
    const client = createIdpClient(baseConfig, "id-token");
    const updated = await client?.update("okta-acme", { displayName: "Renamed" });
    const [calledUrl, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(calledUrl)).toBe("https://control.example.com/admin/idp/okta-acme");
    expect((init as RequestInit).method).toBe("PATCH");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ displayName: "Renamed" });
    expect(updated).toEqual(DETAIL);
  });
});

describe("describeIdpError", () => {
  it("should produce a user-friendly message for known statuses", () => {
    expect(describeIdpError(new IdpApiError(403, "forbidden"))).toContain("SystemAdmin");
    expect(describeIdpError(new IdpApiError(404, "not_found"))).toContain("not found");
    expect(describeIdpError(new IdpApiError(409, "conflict"))).toContain("already exists");
    expect(describeIdpError(new IdpApiError(400, "invalid_metadata"))).toContain("metadata XML");
  });

  it("should distinguish a non-invalid_metadata 400 from the metadata case", () => {
    expect(describeIdpError(new IdpApiError(StatusCodes.BAD_REQUEST, "bad_field"))).toContain(
      "bad_field",
    );
    // errorCode 不在の 400 は validation_failed に倒す。
    expect(describeIdpError(new IdpApiError(StatusCodes.BAD_REQUEST, undefined))).toContain(
      "validation_failed",
    );
  });

  it("should fall back to status + errorCode for other API statuses", () => {
    expect(describeIdpError(new IdpApiError(StatusCodes.INTERNAL_SERVER_ERROR, "boom"))).toContain(
      "500",
    );
    // default の errorCode 不在は unknown_error に倒す。
    expect(
      describeIdpError(new IdpApiError(StatusCodes.INTERNAL_SERVER_ERROR, undefined)),
    ).toContain("unknown_error");
  });

  it("should fall back to Error.message for non-API errors", () => {
    expect(describeIdpError(new Error("boom"))).toBe("boom");
    expect(describeIdpError("garbage")).toBe("unknown error");
  });
});
