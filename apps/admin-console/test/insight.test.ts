import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchTenantsInsightSummary,
  indexSummaryByTenantId,
  type TenantInsightSummary,
} from "../src/api/insight";
import type { AppConfig } from "../src/config";

const baseConfig: AppConfig = {
  cognitoDomain: "https://example.com",
  cognitoClientId: "client-id",
  redirectUri: "http://localhost/callback",
  apiBaseUrl: "https://control.example.com/",
  scope: "openid",
  pooledApplicationAdminConsoleUrl: "",
  provisioningCodeBuildProject: "unknown",
  awsRegion: "",
  awsAccountId: "",
  adminInsightApiUrl: "https://insight.example.com",
  cloudWatchDashboardName: "",
  samlIdpDirectory: {},
};

describe("fetchTenantsInsightSummary", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should return null when the AdminInsight URL is empty (= not wired)", async () => {
    const res = await fetchTenantsInsightSummary(
      { ...baseConfig, adminInsightApiUrl: "" },
      "id-token",
      ["t-1"],
    );
    expect(res).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("should return { items: [] } without fetching when tenantIds is an empty array", async () => {
    const res = await fetchTenantsInsightSummary(baseConfig, "id-token", []);
    expect(res).toEqual({ items: [] });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("should call the AdminInsight API with bearer authentication on the happy path", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          items: [{ tenantId: "t-1", activeDeploys: 1, failedDeploys: 0, totalEvents: 2 }],
        }),
        { status: 200 },
      ),
    );
    const res = await fetchTenantsInsightSummary(baseConfig, "id-token", ["t-1", "t-2"]);
    expect(res?.items[0].tenantId).toBe("t-1");
    const [calledUrl, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(calledUrl)).toContain("admin/insight/tenants/summary");
    expect(String(calledUrl)).toContain("tenantIds=t-1%2Ct-2");
    expect((init as RequestInit).headers).toMatchObject({
      authorization: "Bearer id-token",
    });
  });

  it("should return null on 403 (no SystemAdmin claim) (= column hide)", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
    );
    const res = await fetchTenantsInsightSummary(baseConfig, "id-token", ["t-1"]);
    expect(res).toBeNull();
  });

  it("should throw on non-403 errors such as 500", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "internal" }), { status: 500 }),
    );
    // Issue #873: regex regression を回避。
    await expect(fetchTenantsInsightSummary(baseConfig, "id-token", ["t-1"])).rejects.toMatchObject(
      { message: expect.stringContaining("500") },
    );
  });
});

describe("indexSummaryByTenantId", () => {
  it("should return a Record keyed by tenantId", () => {
    const items: TenantInsightSummary[] = [
      { tenantId: "t-1", activeDeploys: 1, failedDeploys: 0, totalEvents: 2 },
      { tenantId: "t-2", activeDeploys: 0, failedDeploys: 3, totalEvents: 1 },
    ];
    const index = indexSummaryByTenantId({ items });
    expect(index["t-1"]?.failedDeploys).toBe(0);
    expect(index["t-2"]?.failedDeploys).toBe(3);
  });

  it("should return an empty Record for empty items", () => {
    expect(indexSummaryByTenantId({ items: [] })).toEqual({});
  });
});
