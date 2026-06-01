import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config";

/**
 * Issue #1431: in-console cost panel。 純 helper (formatBudgetAmount / budgetProgressStatus) を
 * 直接 unit-test し、 BudgetConsumptionPanel は useAuth / insight API / i18n を mock して
 * loading / ready (percent 有/無) / unavailable (null / {available:false}) / error / no-token の
 * 全 render 分岐を網羅する。 usePolling は実物 (mount で即 fetch)。
 */
const { mockAuth, mockFetchCost } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockFetchCost: vi.fn(),
}));

vi.mock("../src/auth/AuthProvider", () => ({ useAuth: mockAuth }));
vi.mock("../src/i18n", () => ({ useT: () => (key: string) => key }));
// insight は全 mock → 本 test の coverage scope を panel に限定 (client 自体は insight.test.ts)。
vi.mock("../src/api/insight", () => ({ fetchCostSummary: mockFetchCost }));

const { BudgetConsumptionPanel, formatBudgetAmount, budgetProgressStatus } = await import(
  "../src/components/BudgetConsumptionPanel"
);

const config = { adminInsightApiUrl: "https://insight.example.com" } as AppConfig;
const loggedIn = { tokens: { idToken: "id-token" } };

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => vi.clearAllMocks());

describe("formatBudgetAmount", () => {
  it("should render an em-dash for null and a fixed amount with unit otherwise", () => {
    expect(formatBudgetAmount(null, "USD")).toBe("—");
    expect(formatBudgetAmount(12.5, "USD")).toBe("12.50 USD");
  });
});

describe("budgetProgressStatus", () => {
  it("should be error at or above 100% and in-progress otherwise", () => {
    expect(budgetProgressStatus(120)).toBe("error");
    expect(budgetProgressStatus(100)).toBe("error");
    expect(budgetProgressStatus(50)).toBe("in-progress");
    expect(budgetProgressStatus(null)).toBe("in-progress");
  });
});

describe("BudgetConsumptionPanel", () => {
  it("should show the loading state while the fetch is pending", () => {
    mockAuth.mockReturnValue(loggedIn);
    mockFetchCost.mockReturnValue(new Promise(() => {})); // never resolves
    render(<BudgetConsumptionPanel config={config} />);
    expect(screen.getByText("operations.cost_loading")).toBeInTheDocument();
  });

  it("should stay loading and skip the fetch when there is no id token", () => {
    mockAuth.mockReturnValue({ tokens: null });
    render(<BudgetConsumptionPanel config={config} />);
    expect(screen.getByText("operations.cost_loading")).toBeInTheDocument();
    expect(mockFetchCost).not.toHaveBeenCalled();
  });

  it("should render the consumption bar and amounts when a budget is available", async () => {
    mockAuth.mockReturnValue(loggedIn);
    mockFetchCost.mockResolvedValue({
      available: true,
      limitUsd: 100,
      actualSpendUsd: 42,
      forecastedSpendUsd: 75,
      percentConsumed: 42,
      unit: "USD",
    });
    render(<BudgetConsumptionPanel config={config} />);
    await waitFor(() =>
      expect(screen.getByText("operations.cost_consumed_label")).toBeInTheDocument(),
    );
    expect(screen.getByText("100.00 USD")).toBeInTheDocument();
    expect(screen.getByText("42.00 USD")).toBeInTheDocument();
    expect(screen.getByText("75.00 USD")).toBeInTheDocument();
  });

  it("should render with zero progress and em-dashes when amounts are null", async () => {
    mockAuth.mockReturnValue(loggedIn);
    mockFetchCost.mockResolvedValue({
      available: true,
      limitUsd: null,
      actualSpendUsd: null,
      forecastedSpendUsd: null,
      percentConsumed: null,
      unit: "USD",
    });
    render(<BudgetConsumptionPanel config={config} />);
    await waitFor(() =>
      expect(screen.getByText("operations.cost_consumed_label")).toBeInTheDocument(),
    );
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(3);
  });

  it("should show the unavailable note when the client returns null (unwired / 403)", async () => {
    mockAuth.mockReturnValue(loggedIn);
    mockFetchCost.mockResolvedValue(null);
    render(<BudgetConsumptionPanel config={config} />);
    await waitFor(() =>
      expect(screen.getByText("operations.cost_unavailable")).toBeInTheDocument(),
    );
  });

  it("should show the unavailable note when the budget is not configured", async () => {
    mockAuth.mockReturnValue(loggedIn);
    mockFetchCost.mockResolvedValue({ available: false });
    render(<BudgetConsumptionPanel config={config} />);
    await waitFor(() =>
      expect(screen.getByText("operations.cost_unavailable")).toBeInTheDocument(),
    );
  });

  it("should surface a fetch error in an alert", async () => {
    mockAuth.mockReturnValue(loggedIn);
    mockFetchCost.mockRejectedValue(new Error("budget boom"));
    render(<BudgetConsumptionPanel config={config} />);
    await waitFor(() =>
      expect(screen.getByText("operations.cost_fetch_failed")).toBeInTheDocument(),
    );
    expect(screen.getByText("budget boom")).toBeInTheDocument();
  });
});
