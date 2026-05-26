import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTenantIdpClient,
  describeTenantIdpError,
  TenantIdpApiError,
} from "../../src/api/idp-client";
import type { AppConfig } from "../../src/config";

const baseConfig: AppConfig = {
  cognitoDomain: "auth.example.com",
  cognitoClientId: "client-id",
  redirectUri: "http://localhost/callback",
  scope: "openid",
  tenantId: "acme",
  tenantName: "Acme",
  apiBaseUrl: "https://tenant.example.com/",
  isolation: "silo",
  samlIdpDirectory: {},
};

describe("createTenantIdpClient", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should return null when apiBaseUrl is empty", () => {
    expect(createTenantIdpClient({ ...baseConfig, apiBaseUrl: "" }, "t")).toBeNull();
  });

  it("should GET /tenant/idp on list (tenant scope is server-resolved)", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [] }), { status: 200 }),
    );
    const client = createTenantIdpClient(baseConfig, "token");
    await client?.list();
    const [calledUrl] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(calledUrl)).toBe("https://tenant.example.com/tenant/idp");
    // crucially, the URL does NOT include tenantId — it's bound by the JWT.
    expect(String(calledUrl)).not.toContain("acme");
  });

  it("should map 403 to a forbidden message that hints cross-tenant", () => {
    expect(describeTenantIdpError(new TenantIdpApiError(403, "forbidden"))).toContain("tenant");
  });
});
