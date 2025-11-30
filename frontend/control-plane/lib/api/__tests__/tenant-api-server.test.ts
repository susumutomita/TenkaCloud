/**
 * @vitest-environment node
 *
 * このテストファイルは tenant-api.ts のサーバーサイドブランチをテストします。
 * node 環境では window が未定義のため、サーバーサイドのコードパスがカバーされます。
 */
import { describe, expect, it, vi } from "vitest";

// node 環境では window が未定義のため、typeof window === 'undefined' は true になる
// これにより、サーバーサイドの環境変数 TENANT_API_BASE_URL が使用される

describe("tenant-api サーバーサイドテスト", () => {
  it("node 環境では window が未定義であるべき", () => {
    expect(typeof window).toBe("undefined");
  });

  it("サーバーサイドで tenantApi がエクスポートされるべき", async () => {
    vi.resetModules();

    const { tenantApi } = await import("../tenant-api");

    expect(tenantApi).toBeDefined();
    expect(tenantApi.listTenants).toBeDefined();
    expect(tenantApi.getTenant).toBeDefined();
    expect(tenantApi.createTenant).toBeDefined();
    expect(tenantApi.updateTenant).toBeDefined();
    expect(tenantApi.deleteTenant).toBeDefined();
  });

  it("TENANT_API_BASE_URL が設定されている場合それを使用すべき", async () => {
    vi.resetModules();

    // 環境変数を設定
    const originalEnv = process.env.TENANT_API_BASE_URL;
    process.env.TENANT_API_BASE_URL = "http://custom-server-api:3004/api";

    // fetch をモック
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [], pagination: {} }),
    }) as unknown as typeof fetch;
    global.fetch = mockFetch;

    try {
      const { tenantApi } = await import("../tenant-api");
      await tenantApi.listTenants();

      expect(mockFetch).toHaveBeenCalledWith(
        "http://custom-server-api:3004/api/tenants",
        { cache: "no-store" },
      );
    } finally {
      if (originalEnv === undefined) {
        delete process.env.TENANT_API_BASE_URL;
      } else {
        process.env.TENANT_API_BASE_URL = originalEnv;
      }
    }
  });

  it("TENANT_API_BASE_URL 未設定時はデフォルト URL を使用すべき", async () => {
    vi.resetModules();

    // 環境変数を削除
    const originalEnv = process.env.TENANT_API_BASE_URL;
    delete process.env.TENANT_API_BASE_URL;

    // fetch をモック
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [], pagination: {} }),
    }) as unknown as typeof fetch;
    global.fetch = mockFetch;

    try {
      const { tenantApi } = await import("../tenant-api");
      await tenantApi.listTenants();

      expect(mockFetch).toHaveBeenCalledWith(
        "http://tenant-management:3004/api/tenants",
        { cache: "no-store" },
      );
    } finally {
      if (originalEnv !== undefined) {
        process.env.TENANT_API_BASE_URL = originalEnv;
      }
    }
  });
});
