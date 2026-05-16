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
};

describe("fetchTenantsInsightSummary", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("AdminInsight URL が空文字 (= 未配線) のとき null を返すべき", async () => {
    const res = await fetchTenantsInsightSummary(
      { ...baseConfig, adminInsightApiUrl: "" },
      "id-token",
      ["t-1"],
    );
    expect(res).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("tenantIds が空配列なら fetch せず { items: [] } を返すべき", async () => {
    const res = await fetchTenantsInsightSummary(baseConfig, "id-token", []);
    expect(res).toEqual({ items: [] });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("正常系: AdminInsight API を bearer 認証付きで叩くべき", async () => {
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

  it("403 (SystemAdmin claim 無し) のときは null を返すべき (= column hide)", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
    );
    const res = await fetchTenantsInsightSummary(baseConfig, "id-token", ["t-1"]);
    expect(res).toBeNull();
  });

  it("500 など 403 以外の error は throw すべき", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "internal" }), { status: 500 }),
    );
    // Issue #873: vitest 4.x で `.rejects.toThrow(/regex/)` regression を回避。
    await expect(fetchTenantsInsightSummary(baseConfig, "id-token", ["t-1"])).rejects.toMatchObject(
      { message: expect.stringContaining("500") },
    );
  });
});

describe("indexSummaryByTenantId", () => {
  it("tenantId をキーにした Record を返すべき", () => {
    const items: TenantInsightSummary[] = [
      { tenantId: "t-1", activeDeploys: 1, failedDeploys: 0, totalEvents: 2 },
      { tenantId: "t-2", activeDeploys: 0, failedDeploys: 3, totalEvents: 1 },
    ];
    const index = indexSummaryByTenantId({ items });
    expect(index["t-1"]?.failedDeploys).toBe(0);
    expect(index["t-2"]?.failedDeploys).toBe(3);
  });

  it("空 items で空 Record を返すべき", () => {
    expect(indexSummaryByTenantId({ items: [] })).toEqual({});
  });
});
