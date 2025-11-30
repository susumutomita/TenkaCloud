import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tenantApi } from "@/lib/api/tenant-api";
import { getStatusVariant } from "@/lib/tenant-utils";
import type { Tenant } from "@/types/tenant";
import TenantsPage from "../page";

// tenant-api のモック
vi.mock("@/lib/api/tenant-api", () => ({
  tenantApi: {
    listTenants: vi.fn(),
  },
}));

const mockTenants: Tenant[] = [
  {
    id: "1",
    name: "テナント1",
    status: "ACTIVE",
    tier: "FREE",
    adminEmail: "admin1@example.com",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  },
  {
    id: "2",
    name: "テナント2",
    status: "SUSPENDED",
    tier: "PRO",
    adminEmail: "admin2@example.com",
    createdAt: "2024-01-02T00:00:00Z",
    updatedAt: "2024-01-02T00:00:00Z",
  },
  {
    id: "3",
    name: "テナント3",
    status: "ARCHIVED",
    tier: "ENTERPRISE",
    adminEmail: "admin3@example.com",
    createdAt: "2024-01-03T00:00:00Z",
    updatedAt: "2024-01-03T00:00:00Z",
  },
];

describe("TenantsPage コンポーネント", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("ヘッダーセクション", () => {
    it("タイトルを表示すべき", async () => {
      vi.mocked(tenantApi.listTenants).mockResolvedValue([]);
      const Component = await TenantsPage();
      render(Component);
      expect(screen.getByText("テナント管理")).toBeInTheDocument();
    });

    it("説明文を表示すべき", async () => {
      vi.mocked(tenantApi.listTenants).mockResolvedValue([]);
      const Component = await TenantsPage();
      render(Component);
      expect(
        screen.getByText("テナントの作成・管理を行います。"),
      ).toBeInTheDocument();
    });

    it("新規テナント作成ボタンを表示すべき", async () => {
      vi.mocked(tenantApi.listTenants).mockResolvedValue([]);
      const Component = await TenantsPage();
      render(Component);
      expect(
        screen.getByRole("link", { name: "新規テナントを作成" }),
      ).toHaveAttribute("href", "/dashboard/tenants/new");
    });
  });

  describe("統計カード", () => {
    it("テナント統計を表示すべき", async () => {
      vi.mocked(tenantApi.listTenants).mockResolvedValue(mockTenants);
      const Component = await TenantsPage();
      render(Component);

      expect(screen.getByText("総テナント")).toBeInTheDocument();
      expect(screen.getByText("稼働中")).toBeInTheDocument();
      expect(screen.getByText("一時停止")).toBeInTheDocument();
      expect(screen.getByText("Enterprise")).toBeInTheDocument();
    });
  });

  describe("テナントが0件の場合", () => {
    it("空状態メッセージを表示すべき", async () => {
      vi.mocked(tenantApi.listTenants).mockResolvedValue([]);
      const Component = await TenantsPage();
      render(Component);
      expect(
        screen.getByText("テナントがまだ登録されていません"),
      ).toBeInTheDocument();
    });

    it("最初のテナント作成ボタンを表示すべき", async () => {
      vi.mocked(tenantApi.listTenants).mockResolvedValue([]);
      const Component = await TenantsPage();
      render(Component);
      expect(
        screen.getByRole("link", { name: "最初のテナントを作成" }),
      ).toBeInTheDocument();
    });
  });

  describe("テナントがある場合", () => {
    it("テナントテーブルを表示すべき", async () => {
      vi.mocked(tenantApi.listTenants).mockResolvedValue(mockTenants);
      const Component = await TenantsPage();
      render(Component);

      expect(screen.getByText("テナント1")).toBeInTheDocument();
      expect(screen.getByText("テナント2")).toBeInTheDocument();
      expect(screen.getByText("テナント3")).toBeInTheDocument();
    });

    it("テーブルヘッダーを表示すべき", async () => {
      vi.mocked(tenantApi.listTenants).mockResolvedValue(mockTenants);
      const Component = await TenantsPage();
      render(Component);

      expect(screen.getByText("テナント")).toBeInTheDocument();
      expect(screen.getByText("ステータス")).toBeInTheDocument();
      expect(screen.getByText("Tier")).toBeInTheDocument();
      expect(screen.getByText("管理者 Email")).toBeInTheDocument();
      expect(screen.getByText("作成日")).toBeInTheDocument();
    });

    it("テナント詳細リンクを表示すべき", async () => {
      vi.mocked(tenantApi.listTenants).mockResolvedValue(mockTenants);
      const Component = await TenantsPage();
      render(Component);

      const detailLinks = screen.getAllByRole("link", { name: "詳細" });
      expect(detailLinks.length).toBe(3);
    });

    it("テナント編集リンクを表示すべき", async () => {
      vi.mocked(tenantApi.listTenants).mockResolvedValue(mockTenants);
      const Component = await TenantsPage();
      render(Component);

      const editLinks = screen.getAllByRole("link", { name: "編集" });
      expect(editLinks.length).toBe(3);
    });
  });
});

describe("getStatusVariant 関数", () => {
  it("ACTIVE の場合は success を返すべき", () => {
    expect(getStatusVariant("ACTIVE")).toBe("success");
  });

  it("SUSPENDED の場合は warning を返すべき", () => {
    expect(getStatusVariant("SUSPENDED")).toBe("warning");
  });

  it("その他の場合は error を返すべき", () => {
    expect(getStatusVariant("ARCHIVED")).toBe("error");
    expect(getStatusVariant("UNKNOWN")).toBe("error");
  });
});
