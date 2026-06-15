import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config";
import { TenantDetailPage } from "../src/pages/TenantDetail";

/**
 * Issue #1418: 未テストだった admin TenantDetail page を 100% に。
 * useParams / useApiClient / listTenants / parseTenantConfig / i18n を mock し、
 * missing-id / api 不在 / loading / found (full+minimal の fallback 分岐) / not-found / fetch error /
 * back / polling を網羅する。
 */
const h = vi.hoisted(() => ({
  tenantId: "t1" as string | undefined,
  mockUseApiClient: vi.fn(),
  mockListTenants: vi.fn(),
  mockNavigate: vi.fn(),
  mockParseTenantConfig: vi.fn(),
}));

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return {
    ...actual,
    useNavigate: () => h.mockNavigate,
    useParams: () => ({ tenantId: h.tenantId }),
  };
});
vi.mock("../src/api/client", () => ({ useApiClient: h.mockUseApiClient }));
vi.mock("../src/api/tenants", () => ({
  listTenants: h.mockListTenants,
  parseTenantConfig: h.mockParseTenantConfig,
  isTenantSuspended: (tenant: { isSuspended?: boolean }) => tenant.isSuspended === true,
  tierBadgeColor: () => "blue",
  tenantStatusBadgeColor: () => "green",
}));
vi.mock("../src/i18n", () => {
  // 安定参照の t (毎 render で新関数を返すと refresh useCallback dep が変わり無限 refresh)。
  const stableT = (key: string, params?: Readonly<Record<string, string | number>>) =>
    params ? `${key}|${JSON.stringify(params)}` : key;
  return { useT: () => stableT };
});
// toErrorMessage は web-kit の共有純関数 (#1418)。 mock せず実物を使い、 raw message を assert する。

const fullTenant = {
  tenantId: "t1",
  tenantName: "Acme",
  email: "a@acme.test",
  tier: "BASIC",
  tenantStatus: "Active",
  isActive: true,
  createdAt: "2026-01-01T00:00:00Z",
  tenantConfig: "{}",
};

beforeEach(() => {
  vi.clearAllMocks();
  h.tenantId = "t1";
  h.mockUseApiClient.mockReturnValue({});
  h.mockListTenants.mockResolvedValue([fullTenant]);
  h.mockParseTenantConfig.mockReturnValue({
    applicationAdminConsoleUrl: "https://app.console",
    userPoolId: "pool-1",
    appClientId: "client-1",
    apiGatewayUrl: "https://api.gw",
  });
});

afterEach(() => vi.restoreAllMocks());

describe("TenantDetailPage", () => {
  it("should show the missing-id alert when there is no tenantId", () => {
    h.tenantId = undefined;
    render(<TenantDetailPage config={{} as AppConfig} />);
    expect(screen.getByText("tenant_detail.missing_id")).toBeInTheDocument();
    expect(h.mockListTenants).not.toHaveBeenCalled();
  });

  it("should not fetch when the api client is unavailable", () => {
    h.mockUseApiClient.mockReturnValue(null);
    render(<TenantDetailPage config={{} as AppConfig} />);
    expect(h.mockListTenants).not.toHaveBeenCalled();
    // tenant 不在でも header は tenantId を出す
    expect(screen.getByText("t1")).toBeInTheDocument();
  });

  it("should show the loading spinner during the initial fetch", () => {
    let resolve: (v: unknown) => void = () => {};
    h.mockListTenants.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<TenantDetailPage config={{} as AppConfig} />);
    expect(screen.getByText("tenant_detail.loading")).toBeInTheDocument();
    resolve([fullTenant]);
  });

  it("should render the overview with all fields when the tenant is found", async () => {
    render(<TenantDetailPage config={{} as AppConfig} />);
    expect(await screen.findByText("a@acme.test")).toBeInTheDocument(); // unique email anchor
    expect(screen.getByText("Open")).toBeInTheDocument(); // app console link present
    expect(screen.getByText("pool-1")).toBeInTheDocument();
    expect(screen.getByText("tenant_detail.active_yes")).toBeInTheDocument();
  });

  it("should render fallbacks when optional config and fields are absent", async () => {
    h.mockListTenants.mockResolvedValue([
      { ...fullTenant, tier: "GOLD", isActive: false, createdAt: undefined },
    ]);
    h.mockParseTenantConfig.mockReturnValue({});
    render(<TenantDetailPage config={{} as AppConfig} />);
    expect(await screen.findByText("GOLD")).toBeInTheDocument(); // tier not in TIER_LABEL → raw
    expect(screen.getByText("tenant_detail.active_no")).toBeInTheDocument();
    expect(screen.getByText("tenant_detail.app_console_url_pending")).toBeInTheDocument();
  });

  it("should show when the tenant is suspended", async () => {
    h.mockListTenants.mockResolvedValue([{ ...fullTenant, isSuspended: true }]);
    render(<TenantDetailPage config={{} as AppConfig} />);
    expect(await screen.findByText("tenant_detail.suspended_yes")).toBeInTheDocument();
  });

  it("should show a not-found error when the tenant is absent from the list", async () => {
    h.mockListTenants.mockResolvedValue([{ ...fullTenant, tenantId: "other" }]);
    render(<TenantDetailPage config={{} as AppConfig} />);
    expect(await screen.findByText(/tenant_detail\.not_found/)).toBeInTheDocument();
  });

  it("should surface and dismiss a fetch error", async () => {
    h.mockListTenants.mockRejectedValue(new Error("list boom"));
    render(<TenantDetailPage config={{} as AppConfig} />);
    expect(await screen.findByText("tenant_detail.fetch_failed_header")).toBeInTheDocument();
    expect(screen.getByText("list boom")).toBeInTheDocument();
    // error 状態の button は back_to_list と alert dismiss の 2 つ。 text を持たない方が dismiss。
    const dismiss = screen
      .getAllByRole("button")
      .find((b) => b.textContent?.trim() !== "tenant_detail.back_to_list");
    fireEvent.click(dismiss as HTMLElement);
    await waitFor(() => expect(screen.queryByText("list boom")).not.toBeInTheDocument());
  });

  it("should navigate back to the tenant list", async () => {
    render(<TenantDetailPage config={{} as AppConfig} />);
    await screen.findByText("a@acme.test");
    fireEvent.click(screen.getByRole("button", { name: "tenant_detail.back_to_list" }));
    expect(h.mockNavigate).toHaveBeenCalledWith("/tenants");
  });

  it("should re-fetch on the polling interval", async () => {
    vi.useFakeTimers();
    render(<TenantDetailPage config={{} as AppConfig} />);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.mockListTenants).toHaveBeenCalledTimes(2); // initial + 1 interval
    vi.useRealTimers();
  });
});
