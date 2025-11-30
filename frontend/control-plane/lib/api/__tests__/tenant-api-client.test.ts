/**
 * @vitest-environment jsdom
 *
 * このテストファイルは tenant-api.ts のクライアントサイドブランチをテストします。
 * jsdom 環境では window が定義されているため、クライアントサイドのコードパスがカバーされます。
 */
import { describe, expect, it, vi } from "vitest";

// jsdom 環境では window が定義されているため、typeof window === 'undefined' は false になる
// これにより、クライアントサイドの環境変数 NEXT_PUBLIC_TENANT_API_BASE_URL が使用される

describe("tenant-api クライアントサイドテスト", () => {
  it("jsdom 環境では window が定義されているべき", () => {
    expect(typeof window).not.toBe("undefined");
  });

  it("クライアントサイドで tenantApi がエクスポートされるべき", async () => {
    // モジュールキャッシュをリセット
    vi.resetModules();

    // 動的インポートでモジュールを読み込む
    const { tenantApi } = await import("../tenant-api");

    expect(tenantApi).toBeDefined();
    expect(tenantApi.listTenants).toBeDefined();
    expect(tenantApi.getTenant).toBeDefined();
    expect(tenantApi.createTenant).toBeDefined();
    expect(tenantApi.updateTenant).toBeDefined();
    expect(tenantApi.deleteTenant).toBeDefined();
  });

  it("NEXT_PUBLIC_TENANT_API_BASE_URL が設定されている場合それを使用すべき", async () => {
    vi.resetModules();

    // 環境変数を設定
    const originalEnv = process.env.NEXT_PUBLIC_TENANT_API_BASE_URL;
    process.env.NEXT_PUBLIC_TENANT_API_BASE_URL =
      "http://custom-client-api:3004/api";

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
        "http://custom-client-api:3004/api/tenants",
        { cache: "no-store" },
      );
    } finally {
      if (originalEnv === undefined) {
        delete process.env.NEXT_PUBLIC_TENANT_API_BASE_URL;
      } else {
        process.env.NEXT_PUBLIC_TENANT_API_BASE_URL = originalEnv;
      }
    }
  });

  it("NEXT_PUBLIC_TENANT_API_BASE_URL 未設定時はデフォルト URL を使用すべき", async () => {
    vi.resetModules();

    // 環境変数を削除
    const originalEnv = process.env.NEXT_PUBLIC_TENANT_API_BASE_URL;
    delete process.env.NEXT_PUBLIC_TENANT_API_BASE_URL;

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
        "http://localhost:3004/api/tenants",
        { cache: "no-store" },
      );
    } finally {
      if (originalEnv !== undefined) {
        process.env.NEXT_PUBLIC_TENANT_API_BASE_URL = originalEnv;
      }
    }
  });
});
