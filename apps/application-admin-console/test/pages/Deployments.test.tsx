import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeploymentSummary } from "../../src/api/deploy-client";
import type { AppConfig } from "../../src/config";

/**
 * DeploymentsPage (operator の全 deploy 一覧 polling page) の render 分岐 (loading / error /
 * empty / table 行 + team link navigate / reload / displayTeamName fallback / 非 Error catch) を
 * pin する。 useApiClient / useNavigate / useT / listAllDeployments を mock、
 * DEPLOYMENT_STATUS_INDICATOR と deploymentsChanged は実物。
 */
const { mockApiClient, mockNav, mockList } = vi.hoisted(() => ({
  mockApiClient: vi.fn(),
  mockNav: vi.fn(),
  mockList: vi.fn(),
}));

vi.mock("../../src/api/client", () => ({ useApiClient: mockApiClient }));
vi.mock("react-router", () => ({ useNavigate: () => mockNav }));
vi.mock("../../src/i18n", () => {
  const t = (key: string) => key;
  return { useT: () => t };
});
vi.mock("../../src/api/deploy-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/deploy-client")>();
  return { ...actual, listAllDeployments: mockList };
});

const { DeploymentsPage } = await import("../../src/pages/Deployments");

const config = {} as AppConfig;
const dep = (over: Partial<DeploymentSummary> = {}): DeploymentSummary =>
  ({
    jobId: "job-1",
    problemId: "p1",
    tenantId: "t",
    awsAccountId: "1",
    region: "r",
    teamName: "slug-a",
    namePrefix: "pre-a",
    status: "COMPLETE",
    createdAt: "2026-05-20T10:00:00Z",
    ...over,
  }) as DeploymentSummary;
const renderPage = () => render(<DeploymentsPage config={config} />);

beforeEach(() => {
  mockApiClient.mockReturnValue({ fetch: vi.fn() });
  mockNav.mockClear();
  mockList.mockReset().mockResolvedValue({ items: [dep()] });
});

afterEach(() => vi.clearAllMocks());

describe("DeploymentsPage", () => {
  it("should show the loading spinner and not fetch when the API client is unavailable", () => {
    mockApiClient.mockReturnValue(null);
    renderPage();
    expect(screen.getByText("deployments.loading")).toBeInTheDocument();
    expect(mockList).not.toHaveBeenCalled();
  });

  it("should render rows with team link + status, and navigate on link follow", async () => {
    mockList.mockResolvedValue({
      items: [
        dep({ jobId: "job-1", displayTeamName: "Alpha", status: "COMPLETE" }),
        dep({ jobId: "job-2", teamName: "slug-b", status: "FAILED" }), // no displayTeamName
      ],
    });
    renderPage();
    expect(await screen.findByText("Alpha")).toBeInTheDocument(); // displayTeamName
    expect(screen.getByText("slug-b")).toBeInTheDocument(); // teamName fallback
    expect(screen.getByText("COMPLETE")).toBeInTheDocument();
    expect(screen.getByText("FAILED")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Alpha"));
    expect(mockNav).toHaveBeenCalledWith("/deployments/job-1");
  });

  it("should re-fetch when the reload button is clicked", async () => {
    renderPage();
    await screen.findByText("slug-a");
    expect(mockList).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "deployments.reload" }));
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
  });

  it("should show the error alert when the first fetch fails", async () => {
    mockList.mockRejectedValue(new Error("list boom"));
    renderPage();
    expect(await screen.findByText("list boom")).toBeInTheDocument();
  });

  it("should stringify a non-Error rejection on reload", async () => {
    renderPage();
    await screen.findByText("slug-a");
    mockList.mockRejectedValueOnce("string failure");
    fireEvent.click(screen.getByRole("button", { name: "deployments.reload" }));
    // items は残るので error alert は出ないが、 catch の String(err) 分岐を踏む (no crash)。
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
    expect(screen.getByText("slug-a")).toBeInTheDocument();
  });

  it("should keep the same items reference on an unchanged refetch", async () => {
    renderPage();
    await screen.findByText("slug-a");
    fireEvent.click(screen.getByRole("button", { name: "deployments.reload" }));
    // 同一 data → deploymentsChanged=false → setItems(prev) (no-op 経路)。
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
    expect(screen.getByText("slug-a")).toBeInTheDocument();
  });

  it("should render the empty state when no deployments are returned", async () => {
    mockList.mockResolvedValue({ items: [] });
    renderPage();
    expect(await screen.findByText("deployments.empty")).toBeInTheDocument();
  });
});
