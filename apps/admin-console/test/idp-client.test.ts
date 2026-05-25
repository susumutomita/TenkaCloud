import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdpClient, describeIdpError, IdpApiError } from "../src/api/idp-client";
import type { AppConfig } from "../src/config";

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
});

describe("describeIdpError", () => {
  it("should produce a user-friendly message for known statuses", () => {
    expect(describeIdpError(new IdpApiError(403, "forbidden"))).toContain("SystemAdmin");
    expect(describeIdpError(new IdpApiError(404, "not_found"))).toContain("not found");
    expect(describeIdpError(new IdpApiError(409, "conflict"))).toContain("already exists");
    expect(describeIdpError(new IdpApiError(400, "invalid_metadata"))).toContain("metadata XML");
  });

  it("should fall back to Error.message for non-API errors", () => {
    expect(describeIdpError(new Error("boom"))).toBe("boom");
    expect(describeIdpError("garbage")).toBe("unknown error");
  });
});
