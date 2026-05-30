import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/config";

/**
 * ProblemDetailPage の render 分岐 (jobId 不在 redirect / loading / fetch error / deploy 不在 /
 * scoring 未開始 lock / 通常表示 + 情報 section + 子コンポーネント差し込み) と純粋 visibility
 * helper (isProblemDetailLocked / canRenderProblemDetailBody / canRenderEndpointOverride) を pin
 * する。 hook・data helper・子 (ProblemPanel/EndpointOverrideForm/PortalPluginSlots) は mock/stub。
 */
const { mockNav, mockParams, mockAuth, mockTeamView, mockLocale, mockFindMeta, mockNarrative } =
  vi.hoisted(() => ({
    mockNav: vi.fn(),
    mockParams: vi.fn(),
    mockAuth: vi.fn(),
    mockTeamView: vi.fn(),
    mockLocale: { value: "en" },
    mockFindMeta: vi.fn(),
    mockNarrative: vi.fn(),
  }));

vi.mock("react-router", () => ({
  useParams: mockParams,
  useNavigate: () => mockNav,
  Navigate: ({ to }: { to: string }) => <div data-testid="navigate" data-to={to} />,
}));
vi.mock("../../src/auth/AuthProvider", () => ({ useAuth: mockAuth }));
vi.mock("../../src/auth/TeamViewProvider", () => ({ useTeamView: mockTeamView }));
vi.mock("../../src/i18n", () => ({
  useT: () => (key: string, params?: Readonly<Record<string, string | number>>) =>
    params ? `${key}|${JSON.stringify(params)}` : key,
  useI18n: () => ({ locale: mockLocale.value, setLocale: vi.fn(), t: (k: string) => k }),
}));
vi.mock("../../src/data/problems", () => ({
  findProblemMetadata: mockFindMeta,
  resolveLocalizedNarrative: mockNarrative,
}));
vi.mock("../../src/components/ProblemPanel", () => ({
  ProblemPanel: () => <div data-testid="problem-panel" />,
}));
vi.mock("../../src/components/EndpointOverrideForm", () => ({
  EndpointOverrideForm: () => <div data-testid="endpoint-form" />,
}));
vi.mock("../../src/plugins/PortalPluginSlots", () => ({
  PortalPluginSlots: () => <div data-testid="plugin-slots" />,
}));

const {
  ProblemDetailPage,
  isProblemDetailLocked,
  canRenderProblemDetailBody,
  canRenderEndpointOverride,
} = await import("../../src/pages/ProblemDetail");

const config = { apiBaseUrl: "https://api.example.com" } as AppConfig;
const refresh = vi.fn();

// biome-ignore lint/suspicious/noExplicitAny: テスト fixture を最小形で組むための緩い型。
const problem = (over: Record<string, any> = {}): any => ({
  jobId: "job-1",
  problemId: "hello-world",
  score: 0,
  stackOutputs: {},
  ...over,
});
// biome-ignore lint/suspicious/noExplicitAny: 同上。
const meta = (over: Record<string, any> = {}): any => ({
  category: "Battle",
  visibility: "public",
  difficulty: 3,
  endpoints: [{ id: "e1" }],
  dashboardSlots: { dashboard: ["slot.tsx"] },
  runtime: { provider: "aws", engine: "cloudformation" },
  ...over,
});
// biome-ignore lint/suspicious/noExplicitAny: useTeamView の戻りを部分的に組む。
const teamView = (over: Record<string, any> = {}): any => ({
  view: null,
  error: null,
  refresh,
  ...over,
});
// biome-ignore lint/suspicious/noExplicitAny: view の最小形。
const viewWith = (over: Record<string, any> = {}): any => ({
  problems: [problem()],
  eventGate: undefined,
  team: { teamId: "t1", teamName: "Team One" },
  ...over,
});

const renderPage = () => render(<ProblemDetailPage config={config} />);

beforeEach(() => {
  mockParams.mockReturnValue({ jobId: "job-1" });
  mockAuth.mockReturnValue({ session: { sessionToken: "tok" } });
  mockTeamView.mockReturnValue(teamView());
  mockLocale.value = "en";
  mockFindMeta.mockReturnValue(undefined);
  mockNarrative.mockReturnValue({ name: "Hello World", shortDescription: "Solve it" });
});

afterEach(() => vi.clearAllMocks());

describe("visibility helpers", () => {
  it("should lock only on scoring_not_started", () => {
    expect(isProblemDetailLocked({ kind: "scoring_not_started" })).toBe(true);
    expect(isProblemDetailLocked({ kind: "open" })).toBe(false);
    expect(isProblemDetailLocked(undefined)).toBe(false);
  });

  it("should render the body only with a problem and no lock", () => {
    expect(canRenderProblemDetailBody({ hasProblem: true, locked: false })).toBe(true);
    expect(canRenderProblemDetailBody({ hasProblem: false, locked: false })).toBe(false);
    expect(canRenderProblemDetailBody({ hasProblem: true, locked: true })).toBe(false);
  });

  it("should render the endpoint form only with metadata and at least one endpoint", () => {
    const base = { hasProblem: true, locked: false, hasMetadata: true, endpointCount: 1 };
    expect(canRenderEndpointOverride(base)).toBe(true);
    expect(canRenderEndpointOverride({ ...base, endpointCount: 0 })).toBe(false);
    expect(canRenderEndpointOverride({ ...base, hasMetadata: false })).toBe(false);
  });
});

describe("ProblemDetailPage", () => {
  it("should redirect to /problems when jobId is missing", () => {
    mockParams.mockReturnValue({});
    renderPage();
    expect(screen.getByTestId("navigate")).toHaveAttribute("data-to", "/problems");
  });

  it("should show the loading box before the view arrives", () => {
    mockTeamView.mockReturnValue(teamView({ view: null, error: null }));
    renderPage();
    expect(screen.getByText("app.loading")).toBeInTheDocument();
  });

  it("should show a fetch error alert", () => {
    mockTeamView.mockReturnValue(teamView({ view: null, error: "boom" }));
    renderPage();
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  it("should warn when the deployment is missing and fall the header back to jobId", () => {
    mockTeamView.mockReturnValue(teamView({ view: viewWith({ problems: [] }) }));
    renderPage();
    expect(screen.getByText("problem_detail.deploy_missing_header")).toBeInTheDocument();
    expect(screen.getByText("job-1")).toBeInTheDocument(); // header fallback
    expect(screen.queryByTestId("problem-panel")).not.toBeInTheDocument();
  });

  it("should lock the body and show the start time when scoring has not started", () => {
    mockTeamView.mockReturnValue(
      teamView({
        view: viewWith({
          eventGate: { kind: "scoring_not_started", startsAt: "2999-01-01T00:00:00Z" },
        }),
      }),
    );
    renderPage();
    expect(screen.getByText("problem_detail.scoring_not_started_header")).toBeInTheDocument();
    expect(
      screen.getByText("problem_detail.scoring_not_started_starts_at_label", { exact: false }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("problem-panel")).not.toBeInTheDocument();
  });

  it("should lock without a start time when startsAt is absent", () => {
    mockTeamView.mockReturnValue(
      teamView({ view: viewWith({ eventGate: { kind: "scoring_not_started" } }) }),
    );
    renderPage();
    expect(screen.getByText("problem_detail.scoring_not_started_header")).toBeInTheDocument();
    expect(
      screen.queryByText("problem_detail.scoring_not_started_starts_at_label", { exact: false }),
    ).not.toBeInTheDocument();
  });

  it("should render the full detail with info section and all child sections", async () => {
    mockFindMeta.mockReturnValue(meta());
    mockTeamView.mockReturnValue(teamView({ view: viewWith() }));
    renderPage();
    expect(screen.getByText("Hello World")).toBeInTheDocument(); // narrative name header
    expect(screen.getByText("problem_detail.info_header")).toBeInTheDocument();
    expect(screen.getByText("Battle")).toBeInTheDocument();
    expect(screen.getByTestId("problem-panel")).toBeInTheDocument();
    expect(screen.getByTestId("endpoint-form")).toBeInTheDocument();
    expect(screen.getByTestId("plugin-slots")).toBeInTheDocument();
    // back button
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "problem_detail.back_button" }));
    expect(mockNav).toHaveBeenCalledWith("/problems");
  });

  it("should render the body but skip metadata sections when there is no catalog entry", () => {
    mockFindMeta.mockReturnValue(undefined);
    mockTeamView.mockReturnValue(teamView({ view: viewWith() }));
    renderPage();
    expect(screen.getByText("hello-world")).toBeInTheDocument(); // header falls back to problemId
    expect(screen.queryByText("problem_detail.info_header")).not.toBeInTheDocument();
    expect(screen.getByTestId("problem-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("endpoint-form")).not.toBeInTheDocument();
    expect(screen.queryByTestId("plugin-slots")).not.toBeInTheDocument();
  });

  it("should skip the endpoint form when the metadata declares no endpoints", () => {
    mockFindMeta.mockReturnValue(meta({ endpoints: [] }));
    mockTeamView.mockReturnValue(teamView({ view: viewWith() }));
    renderPage();
    expect(screen.getByTestId("problem-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("endpoint-form")).not.toBeInTheDocument();
  });

  it("should skip the plugin slots when the metadata declares none", () => {
    mockFindMeta.mockReturnValue(meta({ dashboardSlots: undefined }));
    mockTeamView.mockReturnValue(teamView({ view: viewWith() }));
    renderPage();
    expect(screen.queryByTestId("plugin-slots")).not.toBeInTheDocument();
  });

  it("should fall the session token back to empty when there is no auth session", () => {
    mockAuth.mockReturnValue({ session: null });
    mockFindMeta.mockReturnValue(meta());
    mockTeamView.mockReturnValue(teamView({ view: viewWith() }));
    renderPage();
    // sessionToken は null → ProblemPanel / EndpointOverrideForm へは "" で渡る。
    expect(screen.getByTestId("problem-panel")).toBeInTheDocument();
    expect(screen.getByTestId("endpoint-form")).toBeInTheDocument();
  });

  it("should color a Challenge blue and flag private visibility", () => {
    mockFindMeta.mockReturnValue(
      meta({ category: "Challenge", visibility: "private", difficulty: 5 }),
    );
    mockTeamView.mockReturnValue(teamView({ view: viewWith() }));
    renderPage();
    expect(screen.getByText("Challenge")).toBeInTheDocument();
    expect(screen.getByText("problem_detail.info_private_badge")).toBeInTheDocument();
    expect(screen.getByText("problem_detail.difficulty_5")).toBeInTheDocument();
  });

  it("should show the runtime provider badge (AWS for the default runtime)", () => {
    mockFindMeta.mockReturnValue(meta()); // runtime aws/cloudformation 既定
    mockTeamView.mockReturnValue(teamView({ view: viewWith() }));
    renderPage();
    expect(screen.getByText("AWS")).toBeInTheDocument();
  });

  it("should map a reserved multi-cloud provider to its brand label", () => {
    mockFindMeta.mockReturnValue(meta({ runtime: { provider: "sakura", engine: "apprun" } }));
    mockTeamView.mockReturnValue(teamView({ view: viewWith() }));
    renderPage();
    expect(screen.getByText("Sakura Cloud")).toBeInTheDocument();
  });

  it("should fall back to the raw provider id for an unmapped provider", () => {
    mockFindMeta.mockReturnValue(meta({ runtime: { provider: "fly", engine: "machines" } }));
    mockTeamView.mockReturnValue(teamView({ view: viewWith() }));
    renderPage();
    expect(screen.getByText("fly")).toBeInTheDocument();
  });
});
