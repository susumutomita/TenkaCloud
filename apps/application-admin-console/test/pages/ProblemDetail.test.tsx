import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeploymentSummary } from "../../src/api/deploy-client";
import type { AppConfig } from "../../src/config";
import type { ProblemDetail } from "../../src/data/problems";

/**
 * ProblemDetailPage: catalog から problem を引き、 overview / description / learning goals /
 * endpoints / tags を描画し、 末尾に ProblemDeploymentsSection (polling) を載せる。
 * problemId 欠落の redirect / not-found / Battle+ready vs Challenge+draft の badge 分岐 /
 * deployments section の loading・成功行 (team link navigate)・error・empty を pin する。
 * react-router / useT / findProblem / useApiClient / listDeployments を mock、
 * DEPLOYMENT_STATUS_INDICATOR と deploymentsChanged は実物。
 */
const { mockParams, mockNav, mockFind, mockApiClient, mockList } = vi.hoisted(() => ({
  mockParams: vi.fn(),
  mockNav: vi.fn(),
  mockFind: vi.fn(),
  mockApiClient: vi.fn(),
  mockList: vi.fn(),
}));

vi.mock("react-router", () => ({
  useParams: () => mockParams(),
  useNavigate: () => mockNav,
  Navigate: ({ to }: { to: string }) => <div data-testid="navigate" data-to={to} />,
}));
vi.mock("../../src/i18n", () => ({
  useT: () => (k: string, p?: Readonly<Record<string, string | number>>) =>
    p ? `${k}|${JSON.stringify(p)}` : k,
}));
vi.mock("../../src/data/problems", () => ({ findProblem: mockFind }));
vi.mock("../../src/api/client", () => ({ useApiClient: mockApiClient }));
vi.mock("../../src/api/deploy-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/deploy-client")>();
  return { ...actual, listDeployments: mockList };
});

const { ProblemDetailPage } = await import("../../src/pages/ProblemDetail");

const config = {} as AppConfig;
const problem = (over: Partial<ProblemDetail> = {}): ProblemDetail =>
  ({
    id: "p1",
    name: "SQLi Battle",
    category: "Battle",
    status: "ready",
    shortDescription: "short summary",
    difficulty: 3,
    estimatedDuration: "45m",
    tags: ["web", "sqli"],
    description: "long\ndescription",
    exposedPorts: [{ name: "web", port: 8080 }],
    learningGoals: ["goal-a", "goal-b"],
    costEstimate: {
      alwaysOnResources: [
        {
          logicalId: "AppLoadBalancer",
          resourceType: "AWS::ElasticLoadBalancingV2::LoadBalancer",
          riskLevel: "medium",
        },
      ],
      unclassifiedResourceTypes: [],
      resourceTypes: ["AWS::ElasticLoadBalancingV2::LoadBalancer"],
    },
    ...over,
  }) as ProblemDetail;
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
const renderPage = () => render(<ProblemDetailPage config={config} />);

beforeEach(() => {
  mockParams.mockReturnValue({ problemId: "p1" });
  mockNav.mockClear();
  mockFind.mockReturnValue(problem());
  mockApiClient.mockReturnValue(null); // default: deployments section stays in loading
  mockList.mockReset().mockResolvedValue({ items: [] });
});
afterEach(() => vi.clearAllMocks());

describe("ProblemDetailPage", () => {
  it("should redirect to the problem list when no problemId is in the URL", () => {
    mockParams.mockReturnValue({});
    renderPage();
    expect(screen.getByTestId("navigate")).toHaveAttribute("data-to", "/problems");
  });

  it("should show a not-found view and route back when the problem is unknown", () => {
    mockParams.mockReturnValue({ problemId: "ghost" });
    mockFind.mockReturnValue(undefined);
    renderPage();
    expect(screen.getByText("problem_detail.not_found_header")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "problem_detail.back_to_list" }));
    expect(mockNav).toHaveBeenCalledWith("/problems");
  });

  it("should render the full detail for a Battle/ready problem", () => {
    renderPage();
    expect(screen.getByText("SQLi Battle")).toBeInTheDocument();
    expect(screen.getByText("short summary")).toBeInTheDocument();
    expect(screen.getByText("Battle")).toBeInTheDocument(); // category badge (red branch)
    expect(screen.getByText("ready")).toBeInTheDocument(); // status badge (green branch)
    expect(screen.getByText("problem_detail.difficulty_3")).toBeInTheDocument();
    expect(screen.getByText("45m")).toBeInTheDocument();
    expect(screen.getByText("goal-a")).toBeInTheDocument();
    expect(screen.getByText("goal-b")).toBeInTheDocument();
    expect(screen.getByText("problem_detail.section_cost")).toBeInTheDocument();
    expect(screen.getByText(/problem_cost.always_on_count/)).toBeInTheDocument();
    expect(screen.getAllByText(/AWS::ElasticLoadBalancingV2::LoadBalancer/).length).toBeGreaterThan(
      0,
    );
    expect(screen.getByText(/web \(port 8080\)/)).toBeInTheDocument();
    expect(screen.getByText("sqli")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "problem_detail.back_short" }));
    expect(mockNav).toHaveBeenCalledWith("/problems");
  });

  it("should render the description as markdown (heading + code + same-origin image)", () => {
    // Issue #1700: description は web-kit <Markdown> 経由で marked + DOMPurify 描画される。
    // privacy hardening (#1929 follow-up): 外部画像は除去され、 同一オリジン/相対のみ残る。
    mockFind.mockReturnValue(
      problem({
        description: "## 手順\n\n```\ncfn deploy\n```\n\n![diagram](/assets/d.png)",
      }),
    );
    const { container } = renderPage();
    // markdown 由来の見出し (Cloudscape section の <Header variant="h2"> と別物)
    expect(screen.getByText("手順").tagName).toBe("H2");
    expect(container.querySelector("pre code")?.textContent).toContain("cfn deploy");
    expect(container.querySelector('img[src="/assets/d.png"]')).not.toBeNull();
  });

  it("should sanitize a malicious <script> in the description", () => {
    mockFind.mockReturnValue(problem({ description: "<script>alert(1)</script>safe" }));
    const { container } = renderPage();
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("safe");
  });

  it("should render the alternate badge branches for a Challenge/draft problem", () => {
    mockFind.mockReturnValue(problem({ category: "Challenge", status: "draft" }));
    renderPage();
    expect(screen.getByText("Challenge")).toBeInTheDocument(); // blue branch
    expect(screen.getByText("draft")).toBeInTheDocument(); // blue branch
  });

  it("should show pack provenance rows only for a pack-sourced problem", () => {
    // Issue #2093: a pack problem surfaces its pack id@version + license labels.
    mockFind.mockReturnValue(
      problem({
        source: "pack",
        packId: "com.example.pack",
        packVersion: "1.2.0",
        license: "Apache-2.0",
      }),
    );
    renderPage();
    expect(screen.getByText("problem_detail.label_pack")).toBeInTheDocument();
    expect(screen.getByText("com.example.pack@1.2.0")).toBeInTheDocument();
    expect(screen.getByText("problem_detail.label_pack_license")).toBeInTheDocument();
    expect(screen.getByText("Apache-2.0")).toBeInTheDocument();
  });

  it("should show the bare pack id when a pack problem declares no version", () => {
    // The `packId@version` label falls back to just the id when version is absent.
    mockFind.mockReturnValue(problem({ source: "pack", packId: "com.example.pack" }));
    renderPage();
    expect(screen.getByText("com.example.pack")).toBeInTheDocument();
  });

  it("should NOT show pack provenance rows for a core problem", () => {
    // Compatibility: the legacy core-only detail view is unchanged (no pack labels).
    renderPage();
    expect(screen.queryByText("problem_detail.label_pack")).not.toBeInTheDocument();
    expect(screen.queryByText("problem_detail.label_pack_license")).not.toBeInTheDocument();
  });

  it("should show the deployments table loading state when the API client is unavailable", () => {
    renderPage();
    expect(screen.getByText("problem_detail.deployments_loading_text")).toBeInTheDocument();
    expect(mockList).not.toHaveBeenCalled();
  });

  it("should render a deployment row and navigate on the team link", async () => {
    mockApiClient.mockReturnValue({ fetch: vi.fn() });
    mockList.mockResolvedValue({ items: [dep({ displayTeamName: "Alpha", status: "COMPLETE" })] });
    renderPage();
    expect(await screen.findByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("COMPLETE")).toBeInTheDocument();
    expect(screen.getByText("pre-a")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Alpha"));
    expect(mockNav).toHaveBeenCalledWith("/deployments/job-1");
  });

  it("should fall back to the internal team slug when no display name is set", async () => {
    mockApiClient.mockReturnValue({ fetch: vi.fn() });
    mockList.mockResolvedValue({
      items: [dep({ teamName: "slug-b", displayTeamName: undefined })],
    });
    renderPage();
    expect(await screen.findByText("slug-b")).toBeInTheDocument();
  });

  it("should surface a deployments fetch error", async () => {
    mockApiClient.mockReturnValue({ fetch: vi.fn() });
    mockList.mockRejectedValue(new Error("deploy list boom"));
    renderPage();
    expect(await screen.findByText("deploy list boom")).toBeInTheDocument();
  });

  it("should render the empty state when the problem has no deployments", async () => {
    mockApiClient.mockReturnValue({ fetch: vi.fn() });
    mockList.mockResolvedValue({ items: [] });
    renderPage();
    expect(await screen.findByText("problem_detail.deployments_empty")).toBeInTheDocument();
  });

  it("should keep items on an unchanged refetch and replace them on change", async () => {
    // problemId を rerender で差し替えると fetchOnce が再生成され useEffect が再 fetch する。
    // prev (= 既存 items) は state として残るので deploymentsChanged の prev/res 両分岐を踏める。
    mockApiClient.mockReturnValue({ fetch: vi.fn() });
    const sameItems = [dep({ jobId: "job-1", displayTeamName: "Alpha" })];
    mockList
      .mockResolvedValueOnce({ items: sameItems }) // p1 mount → prev null → res
      .mockResolvedValueOnce({ items: sameItems }) // p2 同一参照 → !changed → prev
      .mockResolvedValueOnce({ items: [dep({ jobId: "job-2", displayTeamName: "Beta" })] }); // p3 changed → res
    mockFind.mockReturnValue(problem({ id: "p1" }));
    const { rerender } = renderPage();
    expect(await screen.findByText("Alpha")).toBeInTheDocument();

    mockFind.mockReturnValue(problem({ id: "p2" }));
    rerender(<ProblemDetailPage config={config} />);
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Alpha")).toBeInTheDocument(); // prev 保持

    mockFind.mockReturnValue(problem({ id: "p3" }));
    rerender(<ProblemDetailPage config={config} />);
    expect(await screen.findByText("Beta")).toBeInTheDocument(); // res で置換
  });

  it("should stringify a non-Error deployments rejection", async () => {
    mockApiClient.mockReturnValue({ fetch: vi.fn() });
    mockList.mockRejectedValue("string deploy fail");
    renderPage();
    expect(await screen.findByText("string deploy fail")).toBeInTheDocument();
  });
});
