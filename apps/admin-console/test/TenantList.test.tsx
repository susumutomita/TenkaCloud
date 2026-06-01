import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config";
import { TenantListPage } from "../src/pages/TenantList";

/**
 * Issue #1418: 未テストだった admin TenantList page (最大・最複雑) を 100% に。
 * 全依存を mock し、 list 表示 (active/in-progress severity/deprovisioned)、 insight 列
 * (null/0/active/failed)、 appConsole/logs cell の silo/pooled/no-url、 deprovision modal、
 * ErrorState retry/dismiss、 toggle、 empty、 polling を網羅する。
 */
const h = vi.hoisted(() => ({
  mockUseApiClient: vi.fn(),
  mockUseAuth: vi.fn(),
  mockNavigate: vi.fn(),
  mockListTenants: vi.fn(),
  mockDeleteTenant: vi.fn(),
  mockFetchInsight: vi.fn(),
}));

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return { ...actual, useNavigate: () => h.mockNavigate };
});
vi.mock("../src/api/client", () => ({ useApiClient: h.mockUseApiClient }));
vi.mock("../src/auth/AuthProvider", () => ({ useAuth: h.mockUseAuth }));
vi.mock("../src/api/insight", () => ({
  fetchTenantsInsightSummary: h.mockFetchInsight,
  indexSummaryByTenantId: (s: unknown) => s, // 既に tenantId keyed を渡す
}));
vi.mock("../src/api/tenants", () => ({
  listTenants: h.mockListTenants,
  deleteTenant: h.mockDeleteTenant,
  parseTenantConfig: (cfg: string | undefined) => (cfg ? JSON.parse(cfg) : {}),
  buildCodeBuildBuildUrl: (a: { buildId?: string }) => (a.buildId ? `https://cb/${a.buildId}` : ""),
  tierBadgeColor: () => "blue",
  tenantStatusBadgeColor: () => "green",
}));
vi.mock("../src/i18n", () => {
  const stableT = (key: string, params?: Readonly<Record<string, string | number>>) =>
    params ? `${key}|${JSON.stringify(params)}` : key;
  const interpolate = (tmpl: string, vars: Readonly<Record<string, string>>) =>
    tmpl.replace(/\{(\w+)\}/g, (_m, k) => (k in vars ? vars[k] : ""));
  return { useT: () => stableT, interpolate };
});
vi.mock("../src/lib/tenant-progress", () => ({
  isInProgress: (s: string) => s === "InProgress",
  computeTenantProgress: ({ createdAt }: { createdAt?: string }) => {
    if (createdAt === "danger") return { label: "5m", severity: "danger" };
    if (createdAt === "warning") return { label: "3m", severity: "warning" };
    if (createdAt === "dash") return { label: "—", severity: "normal" };
    return { label: "1m", severity: "normal" };
  },
}));
// usePolling は純 timer hook なので実物を残し (= setInterval 捕捉が効く)、 Cloudscape 依存の
// EmptyState / ErrorState だけ軽量 stub で差し替える。
vi.mock("@tenkacloud/web-kit", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  EmptyState: ({
    headline,
    primaryAction,
  }: {
    headline: string;
    primaryAction: { label: string; onClick: () => void };
  }) => (
    <div data-testid="empty">
      {headline}
      <button type="button" onClick={primaryAction.onClick}>
        {primaryAction.label}
      </button>
    </div>
  ),
  ErrorState: ({
    hint,
    retry,
    onDismiss,
  }: {
    hint: string;
    retry: { label: string; onClick: () => void };
    onDismiss: () => void;
  }) => (
    <div data-testid="error">
      <span>{hint}</span>
      <button type="button" onClick={retry.onClick}>
        {retry.label}
      </button>
      <button type="button" onClick={onDismiss}>
        dismiss-error
      </button>
    </div>
  ),
}));

const cfg = (over: Partial<AppConfig> = {}): AppConfig =>
  ({
    adminInsightApiUrl: "https://insight.api",
    pooledApplicationAdminConsoleUrl: "https://pooled.console",
    provisioningCodeBuildProject: "proj",
    awsRegion: "ap-northeast-1",
    awsAccountId: "123",
    ...over,
  }) as AppConfig;

const activeSilo = {
  tenantId: "t-silo",
  tenantName: "Silo Co",
  email: "silo@x.test",
  tier: "PLATINUM",
  tenantStatus: "Active",
  isActive: true,
  createdAt: "2026-01-01",
  tenantConfig: JSON.stringify({
    applicationAdminConsoleUrl: "https://silo.console",
    provisioningBuildId: "b1",
  }),
};
const deprovisioned = {
  tenantId: "t-dep",
  tenantName: "Gone Co",
  email: "gone@x.test",
  tier: "BASIC",
  tenantStatus: "Deleted",
  isActive: false,
  createdAt: "2026-01-01",
  tenantConfig: "{}",
};

beforeEach(() => {
  vi.clearAllMocks();
  h.mockUseApiClient.mockReturnValue({});
  h.mockUseAuth.mockReturnValue({ tokens: { idToken: "id-token" } });
  h.mockListTenants.mockResolvedValue([activeSilo]);
  h.mockDeleteTenant.mockResolvedValue(undefined);
  h.mockFetchInsight.mockResolvedValue(null);
});

afterEach(() => vi.restoreAllMocks());

describe("TenantListPage list + cells", () => {
  it("should not fetch when the api client is unavailable", () => {
    h.mockUseApiClient.mockReturnValue(null);
    render(<TenantListPage config={cfg()} />);
    expect(h.mockListTenants).not.toHaveBeenCalled();
  });

  it("should render the empty state and navigate to create", async () => {
    h.mockListTenants.mockResolvedValue([]);
    render(<TenantListPage config={cfg()} />);
    const empty = await screen.findByTestId("empty");
    fireEvent.click(within(empty).getByText("tenant_list.create_button"));
    expect(h.mockNavigate).toHaveBeenCalledWith("/tenants/new");
  });

  it("should render a silo tenant row with console + logs links", async () => {
    render(<TenantListPage config={cfg()} />);
    expect(await screen.findByText("Silo Co")).toBeInTheDocument();
    expect(screen.getByText("tenant_list.open_console")).toBeInTheDocument(); // silo console
    expect(screen.getByText("tenant_list.logs_codebuild")).toBeInTheDocument(); // codebuild logs
    expect(screen.getByText("tenant_list.deprovision_action")).toBeInTheDocument();
  });

  it("should navigate to detail when the tenant name link is followed", async () => {
    render(<TenantListPage config={cfg()} />);
    const link = await screen.findByText("Silo Co");
    fireEvent.click(link);
    expect(h.mockNavigate).toHaveBeenCalledWith("/tenants/t-silo");
  });

  it("should render pooled console + pooled logs when no silo url / build id", async () => {
    h.mockListTenants.mockResolvedValue([{ ...activeSilo, tenantConfig: "{}" }]);
    render(<TenantListPage config={cfg()} />);
    expect(await screen.findByText("tenant_list.open_console_pooled")).toBeInTheDocument();
    expect(screen.getByText("tenant_list.logs_pooled")).toBeInTheDocument();
  });

  it("should show not-issued console and silo logs-not-issued when urls are absent", async () => {
    h.mockListTenants.mockResolvedValue([
      {
        ...activeSilo,
        tenantConfig: JSON.stringify({ applicationAdminConsoleUrl: "https://silo.console" }),
      },
    ]);
    render(<TenantListPage config={cfg({ pooledApplicationAdminConsoleUrl: "" })} />);
    await screen.findByText("Silo Co");
    expect(screen.getByText("tenant_list.logs_not_issued")).toBeInTheDocument(); // silo, no build id
  });

  it("should render deprovisioned rows as inactive when toggled on", async () => {
    h.mockListTenants.mockResolvedValue([activeSilo, deprovisioned]);
    render(<TenantListPage config={cfg()} />);
    await screen.findByText("Silo Co");
    // default: deprovisioned hidden
    expect(screen.queryByText("Gone Co")).not.toBeInTheDocument();
    // toggle on
    fireEvent.click(screen.getByText(/tenant_list\.show_deprovisioned_toggle/));
    expect(await screen.findByText("Gone Co")).toBeInTheDocument();
  });

  it("should classify isActive=false rows as deprovisioned and tolerate an undefined status", async () => {
    h.mockListTenants.mockResolvedValue([
      { ...activeSilo, tenantId: "u", tenantName: "UndefStatus", tenantStatus: undefined }, // ?? "" → active
      {
        ...activeSilo,
        tenantId: "ia",
        tenantName: "InactiveCo",
        tenantStatus: "Active",
        isActive: false,
      },
    ]);
    render(<TenantListPage config={cfg()} />);
    expect(await screen.findByText("UndefStatus")).toBeInTheDocument(); // undefined status → active row
    expect(screen.queryByText("InactiveCo")).not.toBeInTheDocument(); // isActive=false → deprovisioned (hidden)
    fireEvent.click(screen.getByText(/tenant_list\.show_deprovisioned_toggle/));
    expect(await screen.findByText("InactiveCo")).toBeInTheDocument();
  });

  it("should show not-issued console when neither silo nor pooled url is available", async () => {
    h.mockListTenants.mockResolvedValue([{ ...activeSilo, tenantConfig: "{}" }]);
    render(<TenantListPage config={cfg({ pooledApplicationAdminConsoleUrl: "" })} />);
    await screen.findByText("Silo Co");
    expect(screen.getByText("tenant_list.not_issued_yet")).toBeInTheDocument();
  });

  it("should render in-progress severity variants", async () => {
    h.mockListTenants.mockResolvedValue([
      {
        ...activeSilo,
        tenantId: "d",
        tenantName: "D",
        tenantStatus: "InProgress",
        createdAt: "danger",
      },
      {
        ...activeSilo,
        tenantId: "w",
        tenantName: "W",
        tenantStatus: "InProgress",
        createdAt: "warning",
      },
      {
        ...activeSilo,
        tenantId: "n",
        tenantName: "N",
        tenantStatus: "InProgress",
        createdAt: "norm",
      },
      {
        ...activeSilo,
        tenantId: "x",
        tenantName: "X",
        tenantStatus: "InProgress",
        createdAt: "dash",
      },
    ]);
    render(<TenantListPage config={cfg()} />);
    await screen.findByText("D");
    expect(screen.getByText(/progress_danger_suffix/)).toBeInTheDocument();
    expect(screen.getByText(/progress_warning_suffix/)).toBeInTheDocument();
  });
});

describe("TenantListPage insight column", () => {
  it("should show em-dash when the insight API is not wired", async () => {
    render(<TenantListPage config={cfg({ adminInsightApiUrl: "" })} />);
    await screen.findByText("Silo Co");
    expect(h.mockFetchInsight).not.toHaveBeenCalled();
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("should render active and failed deploy badges from the insight summary", async () => {
    h.mockFetchInsight.mockResolvedValue({ "t-silo": { activeDeploys: 2, failedDeploys: 1 } });
    render(<TenantListPage config={cfg()} />);
    await screen.findByText("Silo Co");
    expect(await screen.findByText(/tenant_list\.deploys_active/)).toBeInTheDocument();
    expect(screen.getByText(/tenant_list\.deploys_failed/)).toBeInTheDocument();
  });

  it("should render a zero badge when there are no deploys", async () => {
    h.mockFetchInsight.mockResolvedValue({ "t-silo": { activeDeploys: 0, failedDeploys: 0 } });
    render(<TenantListPage config={cfg()} />);
    await screen.findByText("Silo Co");
    expect(await screen.findByText("0")).toBeInTheDocument();
  });

  it("should render a zero badge when the tenant is absent from the insight summary", async () => {
    h.mockFetchInsight.mockResolvedValue({
      "other-tenant": { activeDeploys: 5, failedDeploys: 0 },
    });
    render(<TenantListPage config={cfg()} />);
    await screen.findByText("Silo Co");
    expect(await screen.findByText("0")).toBeInTheDocument(); // t-silo not in summary → 0/0
  });

  it("should leave the column as em-dash when the insight fetch throws", async () => {
    h.mockFetchInsight.mockRejectedValue(new Error("403"));
    render(<TenantListPage config={cfg()} />);
    await screen.findByText("Silo Co");
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});

describe("TenantListPage deprovision + errors", () => {
  it("should deprovision after confirmation and refresh", async () => {
    render(<TenantListPage config={cfg()} />);
    await screen.findByText("Silo Co");
    fireEvent.click(screen.getByText("tenant_list.deprovision_action"));
    fireEvent.click(screen.getByText("tenant_list.deprovision_modal_confirm"));
    await waitFor(() => expect(h.mockDeleteTenant).toHaveBeenCalledWith({}, "t-silo"));
    expect(h.mockListTenants).toHaveBeenCalledTimes(2); // initial + after delete
  });

  it("should cancel the deprovision modal", async () => {
    render(<TenantListPage config={cfg()} />);
    await screen.findByText("Silo Co");
    fireEvent.click(screen.getByText("tenant_list.deprovision_action"));
    fireEvent.click(screen.getByText("tenant_list.deprovision_modal_cancel"));
    expect(h.mockDeleteTenant).not.toHaveBeenCalled();
  });

  it("should surface a deprovision error", async () => {
    h.mockDeleteTenant.mockRejectedValue(new Error("delete failed"));
    render(<TenantListPage config={cfg()} />);
    await screen.findByText("Silo Co");
    fireEvent.click(screen.getByText("tenant_list.deprovision_action"));
    fireEvent.click(screen.getByText("tenant_list.deprovision_modal_confirm"));
    expect(await screen.findByTestId("error")).toBeInTheDocument();
    expect(screen.getByText("delete failed")).toBeInTheDocument();
  });

  it("should surface a list error and support retry + dismiss", async () => {
    h.mockListTenants.mockRejectedValueOnce(new Error("list failed"));
    render(<TenantListPage config={cfg()} />);
    const err = await screen.findByTestId("error");
    expect(within(err).getByText("list failed")).toBeInTheDocument();
    fireEvent.click(within(err).getByText("tenant_list.retry")); // refresh again
    await waitFor(() => expect(screen.queryByTestId("error")).not.toBeInTheDocument());
  });

  it("should dismiss the list error", async () => {
    h.mockListTenants.mockRejectedValue(new Error("list failed"));
    render(<TenantListPage config={cfg()} />);
    const err = await screen.findByTestId("error");
    fireEvent.click(within(err).getByText("dismiss-error"));
    await waitFor(() => expect(screen.queryByTestId("error")).not.toBeInTheDocument());
  });

  it("should navigate to create from the header button", async () => {
    render(<TenantListPage config={cfg()} />);
    await screen.findByText("Silo Co");
    fireEvent.click(screen.getByText("tenant_list.create_button"));
    expect(h.mockNavigate).toHaveBeenCalledWith("/tenants/new");
  });

  it("should register pollers that re-fetch insight and tick the clock", async () => {
    const intervalCbs: Array<() => void> = [];
    vi.spyOn(window, "setInterval").mockImplementation(((cb: () => void) => {
      intervalCbs.push(cb);
      return 0;
    }) as never);
    vi.spyOn(window, "clearInterval").mockImplementation(() => undefined);
    h.mockFetchInsight.mockResolvedValue({ "t-silo": { activeDeploys: 1, failedDeploys: 0 } });
    render(<TenantListPage config={cfg()} />);
    await screen.findByText("Silo Co"); // tenants loaded → insight + clock interval が登録される
    await waitFor(() => expect(h.mockFetchInsight).toHaveBeenCalledTimes(1));
    // 捕捉した両 interval callback (insight 再 fetch + nowMs 更新) を手動発火して網羅。
    for (const cb of intervalCbs) cb();
    await waitFor(() => expect(h.mockFetchInsight).toHaveBeenCalledTimes(2));
  });
});
