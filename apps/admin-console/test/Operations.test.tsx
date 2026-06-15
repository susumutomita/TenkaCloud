import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StatusCodes } from "http-status-codes";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminInsightApiError } from "../src/api/admin-drill-down";
import type { AppConfig } from "../src/config";
import { buildRecentFailures, OperationsPage } from "../src/pages/Operations";

/**
 * Issue #1770: Operations page。既存 API だけでプラットフォーム運用サマリを作る:
 * tenant count / active・failed deploy count / recent failure list。
 *
 * #1080 の AWS Console deep link hub も同じ page に残るため、 deep link の既存分岐も
 * regression test として維持する。
 */
const h = vi.hoisted(() => ({
  mockUseApiClient: vi.fn(),
  mockUseAuth: vi.fn(),
  mockListTenants: vi.fn(),
  mockFetchInsight: vi.fn(),
  mockFetchPipeline: vi.fn(),
  mockFetchSfn: vi.fn(),
}));

vi.mock("../src/api/client", () => ({ useApiClient: h.mockUseApiClient }));
vi.mock("../src/auth/AuthProvider", () => ({ useAuth: h.mockUseAuth }));
vi.mock("../src/api/tenants", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  listTenants: h.mockListTenants,
}));
vi.mock("../src/api/insight", () => ({
  fetchTenantsInsightSummary: h.mockFetchInsight,
  indexSummaryByTenantId: (summary: { items: readonly { tenantId: string }[] }) =>
    Object.fromEntries(summary.items.map((item) => [item.tenantId, item])),
}));
vi.mock("../src/api/admin-drill-down", () => {
  class AdminInsightApiError extends Error {
    constructor(
      public readonly status: number,
      message: string,
    ) {
      super(`AdminInsight API ${status}: ${message}`);
      this.name = "AdminInsightApiError";
    }
  }
  return {
    AdminInsightApiError,
    fetchPipelineExecutions: h.mockFetchPipeline,
    fetchStateMachineExecutions: h.mockFetchSfn,
  };
});
vi.mock("../src/i18n", () => {
  const stableT = (key: string) => key;
  return { useT: () => stableT };
});
vi.mock("../src/components/BudgetConsumptionPanel", () => ({
  BudgetConsumptionPanel: () => null,
}));
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

const cfg = (overrides: Partial<AppConfig> = {}): AppConfig =>
  ({
    adminInsightApiUrl: "https://insight.api",
    awsRegion: "ap-northeast-1",
    ...overrides,
  }) as AppConfig;

const tenants = [
  {
    tenantId: "t-a",
    tenantName: "Alpha Org",
    email: "a@example.test",
    tier: "basic",
    tenantStatus: "Complete",
    isActive: true,
  },
  {
    tenantId: "t-b",
    tenantName: "Beta Org",
    email: "b@example.test",
    tier: "advanced",
    tenantStatus: "Complete",
    isActive: true,
  },
  {
    tenantId: "t-c",
    tenantName: "Deleted Org",
    email: "c@example.test",
    tier: "basic",
    tenantStatus: "Deleted",
    isActive: false,
  },
];

const insight = {
  items: [
    { tenantId: "t-a", activeDeploys: 2, failedDeploys: 1, totalEvents: 3 },
    { tenantId: "t-b", activeDeploys: 3, failedDeploys: 0, totalEvents: 3 },
  ],
};

const waitForStat = async (testId: string, value: string) => {
  await waitFor(() =>
    expect(within(screen.getByTestId(testId)).getByText(value)).toBeInTheDocument(),
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  h.mockUseApiClient.mockReturnValue({});
  h.mockUseAuth.mockReturnValue({ tokens: { idToken: "id-token" } });
  h.mockListTenants.mockResolvedValue(tenants);
  h.mockFetchInsight.mockResolvedValue(insight);
  h.mockFetchPipeline.mockResolvedValue({ pipelineName: "pipeline", items: [] });
  h.mockFetchSfn.mockResolvedValue({ kind: "ok", stateMachineArn: "arn:sfn", items: [] });
});

describe("Operations helpers", () => {
  it("should collect and sort recent provisioning and deprovisioning failures", () => {
    const failures = buildRecentFailures(
      [
        {
          executionId: "exec-succeeded",
          status: "Succeeded",
          startTimeIso: "2026-01-01T00:00:00Z",
          lastUpdateTimeIso: "2026-01-01T00:01:00Z",
          consoleUrl: "https://console/succeeded",
        },
        {
          executionId: "exec-failed",
          status: "Failed",
          startTimeIso: "2026-01-01T00:00:00Z",
          lastUpdateTimeIso: "2026-01-01T00:02:00Z",
          consoleUrl: "https://console/failed",
        },
        {
          executionId: "exec-no-timestamps",
          status: "Failed",
          startTimeIso: undefined,
          lastUpdateTimeIso: undefined,
          consoleUrl: "https://console/no-timestamps",
        },
      ],
      [
        {
          executionArn: "arn:exec:ok",
          name: "deprov-ok",
          status: "SUCCEEDED",
          startTimeIso: "2026-01-01T00:00:00Z",
          stopTimeIso: "2026-01-01T00:03:00Z",
          consoleUrl: "https://console/deprov-ok",
        },
        {
          executionArn: "arn:exec:timeout",
          name: "deprov-timeout",
          status: "TIMED_OUT",
          startTimeIso: "2026-01-01T00:00:00Z",
          stopTimeIso: "2026-01-01T00:04:00Z",
          consoleUrl: "https://console/deprov-timeout",
        },
      ],
    );
    // Failures without any timestamp are treated as epoch 0 and sort to the end.
    expect(failures.map((failure) => failure.id)).toEqual([
      "deprov-timeout",
      "exec-failed",
      "exec-no-timestamps",
    ]);
  });
});

describe("OperationsPage deep links", () => {
  it("should build the CloudWatch dashboard deep link when configured", () => {
    h.mockUseApiClient.mockReturnValue(null);
    render(
      <OperationsPage
        config={{ awsRegion: "us-west-2", cloudWatchDashboardName: "TenkaDash" } as AppConfig}
      />,
    );
    expect(screen.getByText("TenkaDash")).toBeInTheDocument();
    expect(screen.getByText("us-west-2")).toBeInTheDocument();
    expect(screen.queryByText("operations.no_dashboard_dev_alert")).not.toBeInTheDocument();
    const link = screen.getByRole("link", { name: "operations.open_dashboard_button" });
    expect(link).toHaveAttribute(
      "href",
      "https://us-west-2.console.aws.amazon.com/cloudwatch/home?region=us-west-2#dashboards:name=TenkaDash",
    );
  });

  it("should show the no-dashboard alert and fall back to the default region when not configured", () => {
    h.mockUseApiClient.mockReturnValue(null);
    render(<OperationsPage config={{ awsRegion: "" } as AppConfig} />);
    expect(screen.getByText("operations.no_dashboard_dev_alert")).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.getByText("ap-northeast-1")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "operations.open_budgets_button" })).toHaveAttribute(
      "href",
      "https://console.aws.amazon.com/billing/home#/budgets",
    );
  });
});

describe("OperationsPage snapshot", () => {
  it("should render tenant counts, deploy counts, and recent failures from existing APIs", async () => {
    h.mockFetchPipeline.mockResolvedValue({
      pipelineName: "pipeline",
      items: [
        {
          executionId: "exec-failed",
          status: "Failed",
          startTimeIso: "2026-01-01T00:00:00Z",
          lastUpdateTimeIso: "2026-01-01T00:02:00Z",
          consoleUrl: "https://console/pipeline-failed",
        },
        {
          executionId: "exec-succeeded",
          status: "Succeeded",
          startTimeIso: "2026-01-01T00:00:00Z",
          lastUpdateTimeIso: "2026-01-01T00:03:00Z",
          consoleUrl: "https://console/pipeline-succeeded",
        },
      ],
    });
    h.mockFetchSfn.mockResolvedValue({
      kind: "ok",
      stateMachineArn: "arn:sfn",
      items: [
        {
          executionArn: "arn:exec:failed",
          name: "deprov-failed",
          status: "FAILED",
          startTimeIso: "2026-01-01T00:00:00Z",
          stopTimeIso: "2026-01-01T00:04:00Z",
          consoleUrl: "https://console/deprov-failed",
        },
      ],
    });

    render(<OperationsPage config={cfg()} />);

    await waitForStat("operations-stat-total-tenants", "3");
    expect(
      within(screen.getByTestId("operations-stat-active-tenants")).getByText("2"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("operations-stat-active-deploys")).getByText("5"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("operations-stat-failed-deploys")).getByText("1"),
    ).toBeInTheDocument();
    expect(screen.getByText("exec-failed")).toBeInTheDocument();
    expect(screen.getByText("deprov-failed")).toBeInTheDocument();
    expect(screen.queryByText("exec-succeeded")).not.toBeInTheDocument();
    expect(h.mockFetchInsight).toHaveBeenCalledWith(cfg(), "id-token", ["t-a", "t-b", "t-c"]);
  });

  it("should show tenant counts and an explicit notice when AdminInsight is not wired", async () => {
    render(<OperationsPage config={cfg({ adminInsightApiUrl: "" })} />);

    await waitForStat("operations-stat-total-tenants", "3");
    expect(screen.getByText("operations.insight_not_available_header")).toBeInTheDocument();
    expect(
      within(screen.getByTestId("operations-stat-active-deploys")).getByText("—"),
    ).toBeInTheDocument();
    expect(h.mockFetchInsight).not.toHaveBeenCalled();
    expect(h.mockFetchPipeline).not.toHaveBeenCalled();
    expect(h.mockFetchSfn).not.toHaveBeenCalled();
  });

  it("should show a loud error with retry when a snapshot fetch fails", async () => {
    h.mockListTenants.mockRejectedValueOnce(new Error("tenants down"));
    render(<OperationsPage config={cfg()} />);

    const err = await screen.findByTestId("error");
    expect(within(err).getByText("operations.snapshot_error_header")).toBeInTheDocument();
    expect(within(err).getByText("tenants down")).toBeInTheDocument();
    fireEvent.click(within(err).getByText("operations.retry"));

    await waitForStat("operations-stat-total-tenants", "3");
    await waitFor(() => expect(screen.queryByTestId("error")).not.toBeInTheDocument());
  });

  it("should show a forbidden alert for non-SystemAdmin AdminInsight access", async () => {
    h.mockFetchPipeline.mockRejectedValue(
      new AdminInsightApiError(StatusCodes.FORBIDDEN, "denied"),
    );

    render(<OperationsPage config={cfg()} />);

    expect(await screen.findByText("operations.forbidden_header")).toBeInTheDocument();
  });

  it("should re-fetch on the 60s polling interval", async () => {
    vi.useFakeTimers();
    render(<OperationsPage config={cfg()} />);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(h.mockListTenants).toHaveBeenCalledTimes(2);
    expect(h.mockFetchInsight).toHaveBeenCalledTimes(2);
  });

  it("should render an em dash for failures missing start and update timestamps", async () => {
    h.mockFetchPipeline.mockResolvedValue({
      pipelineName: "pipeline",
      items: [
        {
          executionId: "exec-no-times",
          status: "Failed",
          startTimeIso: undefined,
          lastUpdateTimeIso: undefined,
          consoleUrl: "https://console/no-times",
        },
      ],
    });

    render(<OperationsPage config={cfg()} />);

    const idCell = await screen.findByText("exec-no-times");
    const row = idCell.closest("tr");
    expect(row).not.toBeNull();
    // started + updated cells both fall back to the em dash when timestamps are absent.
    expect(within(row as HTMLElement).getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  it("should keep the prior tenant snapshot but clear insight data when a later poll is forbidden", async () => {
    vi.useFakeTimers();
    render(<OperationsPage config={cfg()} />);

    await vi.advanceTimersByTimeAsync(0);
    expect(
      within(screen.getByTestId("operations-stat-total-tenants")).getByText("3"),
    ).toBeInTheDocument();

    h.mockFetchPipeline.mockRejectedValue(
      new AdminInsightApiError(StatusCodes.FORBIDDEN, "denied"),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(screen.getByText("operations.forbidden_header")).toBeInTheDocument();
    // The tenant snapshot from the successful poll is retained...
    expect(
      within(screen.getByTestId("operations-stat-total-tenants")).getByText("3"),
    ).toBeInTheDocument();
    // ...while the now-inaccessible AdminInsight deploy figures are cleared.
    expect(
      within(screen.getByTestId("operations-stat-active-deploys")).getByText("—"),
    ).toBeInTheDocument();
  });

  it("should ignore a snapshot fetch that fails after the page unmounts", async () => {
    let rejectTenants: (reason: unknown) => void = () => {};
    h.mockListTenants.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectTenants = reject;
      }),
    );

    const { unmount } = render(<OperationsPage config={cfg()} />);
    unmount();
    rejectTenants(new Error("late tenant failure"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The unmounted page must not surface an error from the late rejection.
    expect(screen.queryByTestId("error")).not.toBeInTheDocument();
  });

  it("should ignore a snapshot fetch that succeeds after the page unmounts", async () => {
    let resolveTenants: (value: unknown) => void = () => {};
    h.mockListTenants.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveTenants = resolve;
      }),
    );

    const { unmount } = render(<OperationsPage config={cfg()} />);
    unmount();
    resolveTenants(tenants);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The resolved snapshot must not be applied to the unmounted page.
    expect(screen.queryByTestId("operations-stat-total-tenants")).not.toBeInTheDocument();
  });

  it("should mark insight unavailable when the AdminInsight summary resolves to null", async () => {
    h.mockFetchInsight.mockResolvedValue(null);

    render(<OperationsPage config={cfg()} />);

    await waitForStat("operations-stat-total-tenants", "3");
    expect(screen.getByText("operations.insight_not_available_header")).toBeInTheDocument();
    expect(
      within(screen.getByTestId("operations-stat-active-deploys")).getByText("—"),
    ).toBeInTheDocument();
  });

  it("should mark insight unavailable when the pipeline executions resolve to null", async () => {
    h.mockFetchInsight.mockResolvedValue(insight);
    h.mockFetchSfn.mockResolvedValue(null);
    h.mockFetchPipeline.mockResolvedValue(null);

    render(<OperationsPage config={cfg()} />);

    await waitForStat("operations-stat-active-deploys", "5");
    expect(screen.getByText("operations.insight_not_available_header")).toBeInTheDocument();
  });

  it("should no-op a manual retry when the API client has become unavailable", async () => {
    h.mockListTenants.mockRejectedValueOnce(new Error("tenants down"));
    const { rerender } = render(<OperationsPage config={cfg()} />);

    await screen.findByTestId("error");
    // The API client drops out (e.g., the session token was cleared) before the retry.
    h.mockUseApiClient.mockReturnValue(null);
    rerender(<OperationsPage config={cfg()} />);
    h.mockListTenants.mockClear();

    fireEvent.click(within(screen.getByTestId("error")).getByText("operations.retry"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.mockListTenants).not.toHaveBeenCalled();
  });
});
