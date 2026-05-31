import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config";
import { OperationsPage } from "../src/pages/Operations";

/**
 * Issue #1418: 未テストだった admin Operations (運用ダッシュボード landing) page を 100% に。
 * config (cloudWatchDashboardName / awsRegion) から AWS Console deep link を組む純 presentational
 * page なので、 configured / not-configured の 2 シナリオで全分岐を網羅する。
 */
vi.mock("../src/i18n", () => ({ useT: () => (key: string) => key }));

describe("OperationsPage", () => {
  it("should build the CloudWatch dashboard deep link when configured", () => {
    render(
      <OperationsPage
        config={{ awsRegion: "us-west-2", cloudWatchDashboardName: "TenkaDash" } as AppConfig}
      />,
    );
    expect(screen.getByText("TenkaDash")).toBeInTheDocument(); // <code> dashboard name
    expect(screen.getByText("us-west-2")).toBeInTheDocument(); // region from config
    expect(screen.queryByText("operations.no_dashboard_dev_alert")).not.toBeInTheDocument();
    const link = screen.getByRole("link", { name: "operations.open_dashboard_button" });
    expect(link).toHaveAttribute(
      "href",
      "https://us-west-2.console.aws.amazon.com/cloudwatch/home?region=us-west-2#dashboards:name=TenkaDash",
    );
  });

  it("should show the no-dashboard alert and fall back to the default region when not configured", () => {
    render(<OperationsPage config={{ awsRegion: "" } as AppConfig} />);
    expect(screen.getByText("operations.no_dashboard_dev_alert")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument(); // dashboard name fallback
    expect(screen.getByText("ap-northeast-1")).toBeInTheDocument(); // default region
    // budgets / cost-explorer / alarms の deep link は常に存在する。
    expect(screen.getByRole("link", { name: "operations.open_budgets_button" })).toHaveAttribute(
      "href",
      "https://console.aws.amazon.com/billing/home#/budgets",
    );
  });
});
