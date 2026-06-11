import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config";
import { UsagePage } from "../src/pages/Usage";

/**
 * Issue #1767: Usage dashboard page。集計カード / tier 分布 / per-tenant table の結線と、
 * 受け入れ条件の loud-fail (API 失敗時にサイレントな空表示をしない) を検証する。
 * 集計ロジック自体の網羅は test/lib/usage.test.ts 側。
 */
const h = vi.hoisted(() => ({
  mockUseApiClient: vi.fn(),
  mockUseAuth: vi.fn(),
  mockListTenants: vi.fn(),
  mockFetchInsight: vi.fn(),
}));

vi.mock("../src/api/client", () => ({ useApiClient: h.mockUseApiClient }));
vi.mock("../src/auth/AuthProvider", () => ({ useAuth: h.mockUseAuth }));
vi.mock("../src/api/insight", () => ({
  fetchTenantsInsightSummary: h.mockFetchInsight,
  indexSummaryByTenantId: (s: unknown) => s, // テストは tenantId keyed の map を直接返す
}));
vi.mock("../src/api/tenants", async (importOriginal) => ({
  // tierBadgeColor / tenantStatusBadgeColor は pure mapper なので実物を使う
  ...((await importOriginal()) as Record<string, unknown>),
  listTenants: h.mockListTenants,
}));
vi.mock("../src/i18n", () => {
  const stableT = (key: string) => key;
  // 翻訳 mock は raw key を返すため placeholder を持たない。 vars を suffix で可視化して
  // 「interpolate に何が渡ったか」 を assert できるようにする。
  const interpolate = (tmpl: string, vars: Readonly<Record<string, string>>) =>
    `${tmpl}|${JSON.stringify(vars)}`;
  return { useT: () => stableT, interpolate };
});
// usePolling / toErrorMessage は実物を残し、 Cloudscape 依存の ErrorState だけ軽量 stub。
vi.mock("@tenkacloud/web-kit", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  ErrorState: ({
    title,
    hint,
    retry,
  }: {
    title: string;
    hint: string;
    retry?: { label: string; onClick: () => void };
  }) => (
    <div data-testid="error">
      <span>{title}</span>
      <span>{hint}</span>
      {retry && (
        <button type="button" onClick={retry.onClick}>
          {retry.label}
        </button>
      )}
    </div>
  ),
}));

const cfg = (over: Partial<AppConfig> = {}): AppConfig =>
  ({
    adminInsightApiUrl: "https://insight.api",
    awsRegion: "ap-northeast-1",
    ...over,
  }) as AppConfig;

const tenants = [
  {
    tenantId: "t-a",
    tenantName: "Alpha Org",
    email: "a@x.test",
    tier: "basic",
    tenantStatus: "Complete",
    isActive: true,
  },
  {
    tenantId: "t-b",
    tenantName: "Beta Org",
    email: "b@x.test",
    tier: "PLATINUM",
    tenantStatus: "Complete",
    isActive: true,
  },
  {
    tenantId: "t-c",
    tenantName: "Gamma Org",
    email: "c@x.test",
    tier: "basic",
    tenantStatus: "Deleted",
    isActive: false,
  },
];

const insight = {
  "t-a": { tenantId: "t-a", activeDeploys: 2, failedDeploys: 1, totalEvents: 3 },
  "t-b": { tenantId: "t-b", activeDeploys: 3, failedDeploys: 0, totalEvents: 3 },
};

/** body 内の出現位置で表示順を比較する (tenant 名は table 行にしか出ない)。 */
const positionOf = (text: string) => {
  const idx = document.body.textContent?.indexOf(text) ?? -1;
  expect(idx).toBeGreaterThanOrEqual(0);
  return idx;
};

/**
 * tenant 一覧 (findByText) だけ待つと insight fetch が未解決のことがある (= deploy 合計が
 * まだ "—")。 insight 由来の合計カード値が出るまで待ってから assert する race 対策 helper。
 */
const awaitInsightApplied = async (totalActiveDeploys: string) => {
  await waitFor(() =>
    expect(
      within(screen.getByTestId("usage-stat-active-deploys")).getByText(totalActiveDeploys),
    ).toBeInTheDocument(),
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  h.mockUseApiClient.mockReturnValue({});
  h.mockUseAuth.mockReturnValue({ tokens: { idToken: "id-token" } });
  h.mockListTenants.mockResolvedValue(tenants);
  h.mockFetchInsight.mockResolvedValue(insight);
});

describe("UsagePage summary cards", () => {
  it("should render total / active tenant counts and deploy totals", async () => {
    render(<UsagePage config={cfg()} />);
    await screen.findByText("Alpha Org");
    await awaitInsightApplied("5");
    expect(
      within(screen.getByTestId("usage-stat-total-tenants")).getByText("3"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("usage-stat-active-tenants")).getByText("2"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("usage-stat-active-deploys")).getByText("5"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("usage-stat-failed-deploys")).getByText("1"),
    ).toBeInTheDocument();
  });

  it("should render em-dash deploy totals while the insight summary is unavailable", async () => {
    h.mockFetchInsight.mockResolvedValue(null);
    render(<UsagePage config={cfg()} />);
    await screen.findByText("Alpha Org");
    expect(
      within(screen.getByTestId("usage-stat-active-deploys")).getByText("—"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("usage-stat-failed-deploys")).getByText("—"),
    ).toBeInTheDocument();
  });
});

describe("UsagePage tier distribution", () => {
  it("should render a count and share per tier derived from the tenant list", async () => {
    render(<UsagePage config={cfg()} />);
    await screen.findByText("Alpha Org");
    const basic = screen.getByTestId("usage-tier-basic");
    expect(within(basic).getByText("2")).toBeInTheDocument();
    expect(within(basic).getByText(/67/)).toBeInTheDocument();
    const platinum = screen.getByTestId("usage-tier-platinum");
    expect(within(platinum).getByText("1")).toBeInTheDocument();
    expect(within(platinum).getByText(/33/)).toBeInTheDocument();
  });

  it("should render the empty hint when there are no tenants", async () => {
    h.mockListTenants.mockResolvedValue([]);
    render(<UsagePage config={cfg()} />);
    expect(await screen.findByText("usage.tier_empty")).toBeInTheDocument();
  });
});

describe("UsagePage per-tenant table", () => {
  it("should render rows sorted by active deploys descending by default", async () => {
    render(<UsagePage config={cfg()} />);
    await screen.findByText("Alpha Org");
    await awaitInsightApplied("5");
    expect(positionOf("Beta Org")).toBeLessThan(positionOf("Alpha Org"));
    expect(positionOf("Alpha Org")).toBeLessThan(positionOf("Gamma Org"));
  });

  it("should re-sort rows when the tenant name column header is clicked", async () => {
    render(<UsagePage config={cfg()} />);
    await screen.findByText("Alpha Org");
    fireEvent.click(screen.getByText("usage.col_tenant_name"));
    await waitFor(() => {
      expect(positionOf("Alpha Org")).toBeLessThan(positionOf("Beta Org"));
      expect(positionOf("Beta Org")).toBeLessThan(positionOf("Gamma Org"));
    });
  });
});

describe("UsagePage loud-fail", () => {
  it("should show a loud error with retry when the tenant list fetch fails", async () => {
    h.mockListTenants.mockRejectedValueOnce(new Error("tenants down"));
    render(<UsagePage config={cfg()} />);
    const err = await screen.findByTestId("error");
    expect(within(err).getByText("tenants down")).toBeInTheDocument();
    fireEvent.click(within(err).getByText("usage.retry"));
    expect(await screen.findByText("Alpha Org")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("error")).not.toBeInTheDocument());
  });

  it("should show a loud error when the insight fetch fails instead of silently hiding totals", async () => {
    h.mockFetchInsight.mockRejectedValue(new Error("insight down"));
    render(<UsagePage config={cfg()} />);
    await screen.findByText("Alpha Org");
    const err = await screen.findByTestId("error");
    expect(within(err).getByText("usage.insight_error_header")).toBeInTheDocument();
    expect(within(err).getByText("insight down")).toBeInTheDocument();
  });

  it("should retry the insight fetch from the insight error state", async () => {
    h.mockFetchInsight.mockRejectedValueOnce(new Error("insight down"));
    render(<UsagePage config={cfg()} />);
    await screen.findByText("Alpha Org");
    const err = await screen.findByTestId("error");
    const callsBeforeRetry = h.mockFetchInsight.mock.calls.length;
    fireEvent.click(within(err).getByText("usage.retry"));
    // retry が insight fetch を再実行し、 成功後はエラー表示が消える。
    await waitFor(() =>
      expect(h.mockFetchInsight.mock.calls.length).toBeGreaterThan(callsBeforeRetry),
    );
    await waitFor(() => expect(screen.queryByTestId("error")).not.toBeInTheDocument());
  });

  it("should show an explicit unavailable notice when the insight API returns null (403 / not wired)", async () => {
    h.mockFetchInsight.mockResolvedValue(null);
    render(<UsagePage config={cfg()} />);
    await screen.findByText("Alpha Org");
    expect(await screen.findByText("usage.insight_not_available_header")).toBeInTheDocument();
  });

  it("should skip the insight fetch and show the unavailable notice when the API URL is not wired", async () => {
    render(<UsagePage config={cfg({ adminInsightApiUrl: "" })} />);
    await screen.findByText("Alpha Org");
    expect(await screen.findByText("usage.insight_not_available_header")).toBeInTheDocument();
    expect(h.mockFetchInsight).not.toHaveBeenCalled();
  });

  it("should not fetch when the api client is unavailable", () => {
    h.mockUseApiClient.mockReturnValue(null);
    render(<UsagePage config={cfg()} />);
    expect(h.mockListTenants).not.toHaveBeenCalled();
  });
});
