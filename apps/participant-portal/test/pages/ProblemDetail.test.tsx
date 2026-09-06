import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/config";

/**
 * ProblemDetailPage の render 分岐 (jobId 不在 redirect / loading / fetch error / deploy 不在 /
 * scoring 未開始 lock / 通常表示 + 情報 section + 子コンポーネント差し込み) と純粋 visibility
 * helper (isProblemDetailLocked / canRenderProblemDetailBody / canRenderEndpointOverride) を pin
 * する。 hook・data helper・子 (ProblemPanel/EndpointOverrideForm/PortalPluginSlots) は mock/stub。
 */
const {
  mockNav,
  mockParams,
  mockAuth,
  mockTeamView,
  mockLocale,
  mockFindMeta,
  mockNarrative,
  mockFindDiagram,
  mockUseProblemEndpoints,
  mockEndpointOverrideForm,
  mockPortalPluginSlots,
} = vi.hoisted(() => ({
  mockNav: vi.fn(),
  mockParams: vi.fn(),
  mockAuth: vi.fn(),
  mockTeamView: vi.fn(),
  mockLocale: { value: "en" },
  mockFindMeta: vi.fn(),
  mockNarrative: vi.fn(),
  mockFindDiagram: vi.fn(),
  mockUseProblemEndpoints: vi.fn(),
  mockEndpointOverrideForm: vi.fn(),
  mockPortalPluginSlots: vi.fn(),
}));

vi.mock("react-router", () => ({
  useParams: mockParams,
  useNavigate: () => mockNav,
  Navigate: ({ to }: { to: string }) => <div data-testid="navigate" data-to={to} />,
}));
vi.mock("../../src/auth/AuthProvider", () => ({ useAuth: mockAuth }));
vi.mock("../../src/auth/TeamViewProvider", () => ({ useTeamView: mockTeamView }));
vi.mock("../../src/hooks/useProblemEndpoints", () => ({
  useProblemEndpoints: mockUseProblemEndpoints,
}));
vi.mock("../../src/i18n", () => ({
  useT: () => (key: string, params?: Readonly<Record<string, string | number>>) =>
    params ? `${key}|${JSON.stringify(params)}` : key,
  useI18n: () => ({ locale: mockLocale.value, setLocale: vi.fn(), t: (k: string) => k }),
}));
vi.mock("../../src/data/problems", () => ({
  findProblemMetadata: mockFindMeta,
  resolveLocalizedNarrative: mockNarrative,
  findProblemDiagramUrl: mockFindDiagram,
}));
vi.mock("../../src/components/ProblemPanel", () => ({
  ProblemPanel: () => <div data-testid="problem-panel" />,
}));
vi.mock("../../src/components/EndpointOverrideForm", () => ({
  EndpointOverrideForm: (props: unknown) => {
    const [draft, setDraft] = useState("");
    mockEndpointOverrideForm(props);
    return (
      <div data-testid="endpoint-form">
        <input
          aria-label="mock endpoint draft"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </div>
    );
  },
}));
vi.mock("../../src/plugins/PortalPluginSlots", () => ({
  PortalPluginSlots: (props: unknown) => {
    mockPortalPluginSlots(props);
    const [draft, setDraft] = useState("");
    return (
      <div data-testid="plugin-slots">
        <input
          aria-label="live answer draft"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      </div>
    );
  },
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
  mockFindDiagram.mockReturnValue(undefined);
  mockNarrative.mockReturnValue({ name: "Hello World", shortDescription: "Solve it" });
  mockUseProblemEndpoints.mockReturnValue({
    endpoints: undefined,
    error: undefined,
    replaceEndpoints: vi.fn(),
  });
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
  it.each([
    undefined,
    { status: "running", runtimeKind: "docker" },
  ])("puts an active interaction-only Battle first and preserves its answer while reference opens (lifecycle: %j)", async (lifecycle) => {
    const user = userEvent.setup();
    mockTeamView.mockReturnValue(
      teamView({ view: viewWith({ problems: [problem({ status: "COMPLETE", lifecycle })] }) }),
    );
    mockFindMeta.mockReturnValue(
      meta({
        endpoints: [],
        dashboardSlots: { StatusPanel: "portal/StatusPanel.tsx" },
        interTeamCoordination: {},
      }),
    );
    const { rerender } = renderPage();
    const live = screen.getByTestId("plugin-slots");
    const reference = screen.getByRole("button", { name: "problem_detail.reference_header" });
    expect(live.compareDocumentPosition(reference) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(reference).toHaveAttribute("aria-expanded", "false");
    await user.type(screen.getByRole("textbox", { name: "live answer draft" }), "123");
    await user.click(reference);
    expect(screen.getByText("problem_detail.info_header")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "live answer draft" })).toHaveValue("123");
    // A normal team poll does not remount the running plugin.
    mockTeamView.mockReturnValue(
      teamView({
        view: viewWith({ problems: [problem({ status: "COMPLETE", lifecycle, score: 30 })] }),
      }),
    );
    rerender(<ProblemDetailPage config={config} />);
    expect(screen.getByTestId("plugin-slots")).toBe(live);
    expect(screen.getByRole("textbox", { name: "live answer draft" })).toHaveValue("123");
    await user.click(reference);
    expect(screen.getByRole("textbox", { name: "live answer draft" })).toHaveValue("123");
  });

  it("keeps an endpoint-registration Battle instruction-first", () => {
    mockTeamView.mockReturnValue(
      teamView({ view: viewWith({ problems: [problem({ status: "COMPLETE" })] }) }),
    );
    mockFindMeta.mockReturnValue(
      meta({
        dashboardSlots: { StatusPanel: "portal/StatusPanel.tsx" },
        interTeamCoordination: {},
      }),
    );
    renderPage();
    expect(
      screen.queryByRole("button", { name: "problem_detail.reference_header" }),
    ).not.toBeInTheDocument();
    const instructions = screen.getByText("problem_detail.info_header");
    expect(
      instructions.compareDocumentPosition(screen.getByTestId("plugin-slots")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByTestId("endpoint-form")).toBeVisible();
  });

  it("keeps a stopped interaction-only Battle's environment information before the game", () => {
    mockTeamView.mockReturnValue(
      teamView({
        view: viewWith({
          problems: [
            problem({
              status: "COMPLETE",
              lifecycle: { status: "stopped", runtimeKind: "docker" },
            }),
          ],
        }),
      }),
    );
    mockFindMeta.mockReturnValue(
      meta({
        endpoints: [],
        dashboardSlots: { StatusPanel: "portal/StatusPanel.tsx" },
        interTeamCoordination: {},
      }),
    );
    renderPage();
    expect(
      screen.queryByRole("button", { name: "problem_detail.reference_header" }),
    ).not.toBeInTheDocument();
    const information = screen.getByText("problem_detail.info_header");
    expect(information).toBeVisible();
    expect(
      information.compareDocumentPosition(screen.getByTestId("plugin-slots")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("does not mount game plugins while the event is locked", () => {
    mockTeamView.mockReturnValue(
      teamView({
        view: viewWith({
          eventGate: { kind: "scoring_not_started" },
          problems: [problem({ status: "COMPLETE" })],
        }),
      }),
    );
    mockFindMeta.mockReturnValue(
      meta({
        endpoints: [],
        dashboardSlots: { StatusPanel: "portal/StatusPanel.tsx" },
        interTeamCoordination: {},
      }),
    );
    renderPage();
    expect(screen.queryByTestId("plugin-slots")).not.toBeInTheDocument();
    expect(mockPortalPluginSlots).not.toHaveBeenCalled();
  });

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

  /**
   * [TenkaCloudChallenge #402] カタログには出るのに起動できない問題があり、開いて
   * 「deploy されていません。operator にお問い合わせください」に当たって初めて分かる
   * 行き止まりだった。local play の operator は本人なので、その案内では何も打つ手がない。
   */
  describe("AWS-only problems in local play (#402)", () => {
    const localConfig = { ...config, cloudMode: "local" } as AppConfig;

    it("should name the real reason instead of telling the player to contact an operator", () => {
      mockParams.mockReturnValue({ jobId: "local-wp2shell-friday-night-patch" });
      mockTeamView.mockReturnValue(teamView({ view: viewWith({ problems: [] }) }));
      // jobId は `local-<problemId>` (api-state.ts の jobIdOf) なので、deploy が無くても
      // catalog を引ける。
      mockFindMeta.mockReturnValue({ ...meta(), localPlayable: false });
      render(<ProblemDetailPage config={localConfig} />);
      expect(screen.getByText("problem_detail.aws_only_header")).toBeInTheDocument();
      expect(screen.queryByText("problem_detail.deploy_missing_header")).not.toBeInTheDocument();
    });

    it("should keep the ordinary not-deployed warning for a problem that can run locally", () => {
      mockParams.mockReturnValue({ jobId: "local-sqli-demo" });
      mockTeamView.mockReturnValue(teamView({ view: viewWith({ problems: [] }) }));
      mockFindMeta.mockReturnValue({ ...meta(), localPlayable: true });
      render(<ProblemDetailPage config={localConfig} />);
      expect(screen.getByText("problem_detail.deploy_missing_header")).toBeInTheDocument();
      expect(screen.queryByText("problem_detail.aws_only_header")).not.toBeInTheDocument();
    });

    it("should not treat an unknown localPlayable as AWS-only", () => {
      // AWS mode の投影は `local/` を見られないので undefined になる。これを false 扱いすると
      // 本番で全問に「ローカル実行不可」が出る。
      mockParams.mockReturnValue({ jobId: "local-sqli-demo" });
      mockTeamView.mockReturnValue(teamView({ view: viewWith({ problems: [] }) }));
      mockFindMeta.mockReturnValue(meta());
      render(<ProblemDetailPage config={localConfig} />);
      expect(screen.queryByText("problem_detail.aws_only_header")).not.toBeInTheDocument();
    });

    it("should fall back to the raw jobId when it carries no local- prefix", () => {
      // local play の jobId は `local-<problemId>` (api-state.ts の jobIdOf) だが、その規約が
      // 変わっても catalog を引く経路が壊れないことを固定する。prefix を無条件に切り落とすと、
      // 規約変更の日に問題 ID の先頭 6 文字が消えて誰も気付かない。
      mockParams.mockReturnValue({ jobId: "wp2shell-friday-night-patch" });
      mockTeamView.mockReturnValue(teamView({ view: viewWith({ problems: [] }) }));
      mockFindMeta.mockImplementation((id: string) =>
        id === "wp2shell-friday-night-patch" ? { ...meta(), localPlayable: false } : undefined,
      );
      render(<ProblemDetailPage config={localConfig} />);
      expect(screen.getByText("problem_detail.aws_only_header")).toBeInTheDocument();
    });

    it("should not claim AWS-only outside local mode", () => {
      // SaaS/AWS mode では deploy されていないだけかもしれない。local play 固有の案内を出さない。
      mockParams.mockReturnValue({ jobId: "local-wp2shell-friday-night-patch" });
      mockTeamView.mockReturnValue(teamView({ view: viewWith({ problems: [] }) }));
      mockFindMeta.mockReturnValue({ ...meta(), localPlayable: false });
      renderPage();
      expect(screen.queryByText("problem_detail.aws_only_header")).not.toBeInTheDocument();
      expect(screen.getByText("problem_detail.deploy_missing_header")).toBeInTheDocument();
    });
  });

  it("should show the onboarding video section only when the problem ships a videoUrl (#2707)", () => {
    mockTeamView.mockReturnValue(
      teamView({
        view: viewWith({
          problems: [problem({ videoUrl: "/videos/onboarding/understand-tenkacloud.mp4" })],
        }),
      }),
    );
    const { container } = renderPage();
    expect(
      container.querySelector('video[src="/videos/onboarding/understand-tenkacloud.mp4"]'),
    ).not.toBeNull();
    // videoUrl の無い既存 problem では section 自体が出ない (他 test の render で担保) が、
    // ここでも明示: video 要素は 1 つだけ。
    expect(container.querySelectorAll("video")).toHaveLength(1);
  });

  it("should use the localized English video when the problem provides one", () => {
    mockTeamView.mockReturnValue(
      teamView({
        view: viewWith({
          problems: [
            problem({
              videoUrl: "/videos/onboarding/demo-ja.mp4",
              i18n: { en: { videoUrl: "/videos/onboarding/demo-en.mp4" } },
            }),
          ],
        }),
      }),
    );
    mockLocale.value = "en";
    const { container } = renderPage();
    expect(container.querySelector('video[src="/videos/onboarding/demo-en.mp4"]')).not.toBeNull();
  });

  it("should lead the intro with its friendly name and place the operation video before the tutorial", () => {
    mockTeamView.mockReturnValue(
      teamView({
        view: viewWith({
          problems: [
            problem({
              problemId: "what-is-tenkacloud",
              name: "What is TenkaCloud?",
              videoUrl: "/videos/onboarding/what-is.mp4",
            }),
          ],
        }),
      }),
    );
    const { container } = renderPage();
    expect(
      screen.getByRole("heading", { level: 1, name: "What is TenkaCloud?" }),
    ).toBeInTheDocument();
    const panel = screen.getByTestId("problem-panel");
    const video = container.querySelector('video[src="/videos/onboarding/what-is.mp4"]');
    expect(video).not.toBeNull();
    expect(video?.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
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

  // ── Issue #2283: Progression Gate lock / hint の render 分岐 ────────────────
  it("should lock the body with an info alert when the problem is prerequisite-locked", () => {
    mockTeamView.mockReturnValue(
      teamView({
        view: viewWith({
          problems: [
            problem(),
            problem({ jobId: "job-gate", problemId: "gate-1", name: "Gate One" }),
          ],
          progression: {
            gateProblemId: "gate-1",
            gateCompleted: false,
            policy: "required",
            completionBonus: 50,
            lockedProblemIds: ["hello-world"],
          },
        }),
      }),
    );
    renderPage();
    expect(screen.getByText("problem_detail.prerequisite_locked_header")).toBeInTheDocument();
    // gate 名は team view の name で解決される
    expect(
      screen.getByText('problem_detail.prerequisite_locked_body|{"gateName":"Gate One"}'),
    ).toBeInTheDocument();
    // gate 問題が deploy 済 → 詳細ページへの link
    expect(
      screen.getByText('problem_detail.prerequisite_locked_gate_link|{"gateName":"Gate One"}'),
    ).toBeInTheDocument();
    // body / flag 提出 / endpoint form は render しない
    expect(screen.queryByTestId("problem-panel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("endpoint-form")).not.toBeInTheDocument();
  });

  it("should navigate to the gate problem page when the gate link is followed", async () => {
    mockTeamView.mockReturnValue(
      teamView({
        view: viewWith({
          problems: [
            problem(),
            problem({ jobId: "job-gate", problemId: "gate-1", name: "Gate One" }),
          ],
          progression: {
            gateProblemId: "gate-1",
            gateCompleted: false,
            policy: "required",
            completionBonus: 0,
            lockedProblemIds: ["hello-world"],
          },
        }),
      }),
    );
    renderPage();
    const user = userEvent.setup();
    await user.click(
      screen.getByText('problem_detail.prerequisite_locked_gate_link|{"gateName":"Gate One"}'),
    );
    expect(mockNav).toHaveBeenCalledWith("/problems/job-gate");
  });

  it("should lock without a gate link when the gate problem is not deployed to the team", () => {
    mockTeamView.mockReturnValue(
      teamView({
        view: viewWith({
          progression: {
            gateProblemId: "gate-1",
            gateCompleted: false,
            policy: "required",
            completionBonus: 0,
            lockedProblemIds: ["hello-world"],
          },
        }),
      }),
    );
    renderPage();
    // gate 名は problemId slug に fall back し、 link は出ない
    expect(
      screen.getByText('problem_detail.prerequisite_locked_body|{"gateName":"gate-1"}'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('problem_detail.prerequisite_locked_gate_link|{"gateName":"gate-1"}'),
    ).not.toBeInTheDocument();
  });

  it("should prefer the scoring_not_started lock over the prerequisite lock", () => {
    mockTeamView.mockReturnValue(
      teamView({
        view: viewWith({
          eventGate: { kind: "scoring_not_started" },
          progression: {
            gateProblemId: "gate-1",
            gateCompleted: false,
            policy: "required",
            completionBonus: 0,
            lockedProblemIds: ["hello-world"],
          },
        }),
      }),
    );
    renderPage();
    expect(screen.getByText("problem_detail.scoring_not_started_header")).toBeInTheDocument();
    expect(screen.queryByText("problem_detail.prerequisite_locked_header")).not.toBeInTheDocument();
    expect(screen.queryByTestId("problem-panel")).not.toBeInTheDocument();
  });

  it("should show the gate hint with the bonus on the gate problem's own page", () => {
    mockTeamView.mockReturnValue(
      teamView({
        view: viewWith({
          progression: {
            gateProblemId: "hello-world",
            gateCompleted: false,
            policy: "required",
            completionBonus: 50,
            lockedProblemIds: ["s3-treasure"],
          },
        }),
      }),
    );
    renderPage();
    expect(screen.getByText("problem_detail.gate_hint_header")).toBeInTheDocument();
    expect(screen.getByText(/problem_detail\.gate_hint_body/)).toBeInTheDocument();
    expect(screen.getByText(/problem_detail\.gate_hint_bonus.*50/)).toBeInTheDocument();
    // Gate 自身は lock されない → body は出る
    expect(screen.getByTestId("problem-panel")).toBeInTheDocument();
  });

  it("should show a bonus-only notice on the gate page for a policy-off team (no unlock hint)", () => {
    mockTeamView.mockReturnValue(
      teamView({
        view: viewWith({
          progression: {
            gateProblemId: "hello-world",
            gateCompleted: false,
            policy: "off",
            completionBonus: 50,
            lockedProblemIds: [],
          },
        }),
      }),
    );
    renderPage();
    // policy "off" の team は何も locked されないので unlock hint (gate_hint) は出ない。
    expect(screen.queryByText("problem_detail.gate_hint_header")).not.toBeInTheDocument();
    // 完了 bonus 予告は locked と無関係に出る (= off team もボーナスは獲得できる)。
    expect(screen.getByText("problem_detail.gate_bonus_only_header")).toBeInTheDocument();
    expect(screen.getByText(/problem_detail\.gate_hint_bonus.*50/)).toBeInTheDocument();
    // Gate 自身は lock されない → body は出る。
    expect(screen.getByTestId("problem-panel")).toBeInTheDocument();
  });

  it("should not show a bonus-only notice when the policy-off team has no completion bonus", () => {
    mockTeamView.mockReturnValue(
      teamView({
        view: viewWith({
          progression: {
            gateProblemId: "hello-world",
            gateCompleted: false,
            policy: "off",
            completionBonus: 0,
            lockedProblemIds: [],
          },
        }),
      }),
    );
    renderPage();
    expect(screen.queryByText("problem_detail.gate_bonus_only_header")).not.toBeInTheDocument();
    expect(screen.queryByText("problem_detail.gate_hint_header")).not.toBeInTheDocument();
  });

  it("should omit the bonus line when completionBonus is 0 and hide the hint once completed", () => {
    const progression = {
      gateProblemId: "hello-world",
      gateCompleted: false,
      policy: "required",
      completionBonus: 0,
      lockedProblemIds: ["s3-treasure"],
    };
    mockTeamView.mockReturnValue(teamView({ view: viewWith({ progression }) }));
    const { unmount } = renderPage();
    expect(screen.getByText("problem_detail.gate_hint_header")).toBeInTheDocument();
    expect(screen.queryByText(/problem_detail\.gate_hint_bonus/)).not.toBeInTheDocument();
    unmount();

    mockTeamView.mockReturnValue(
      teamView({
        view: viewWith({
          progression: { ...progression, gateCompleted: true, lockedProblemIds: [] },
        }),
      }),
    );
    renderPage();
    expect(screen.queryByText("problem_detail.gate_hint_header")).not.toBeInTheDocument();
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

  it("should render the player-facing instructions as Markdown when provided (#1929)", () => {
    mockFindMeta.mockReturnValue(meta());
    mockNarrative.mockReturnValue({
      name: "Hello World",
      shortDescription: "Solve it",
      instructions: "First move: read the briefing",
    });
    mockTeamView.mockReturnValue(teamView({ view: viewWith() }));
    renderPage();
    expect(screen.getByText("problem_detail.info_instructions_label")).toBeInTheDocument();
    expect(screen.getByText("First move: read the briefing")).toBeInTheDocument();
  });

  it("should render the architecture diagram when a diagram.svg exists (#1929 Phase 1c)", () => {
    mockFindMeta.mockReturnValue(meta());
    mockFindDiagram.mockReturnValue("/assets/diagram.svg");
    mockTeamView.mockReturnValue(teamView({ view: viewWith() }));
    renderPage();
    const img = screen.getByRole("img", { name: "problem_detail.info_diagram_label" });
    expect(img).toHaveAttribute("src", "/assets/diagram.svg");
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

  it("should share the authoritative endpoint registry between the form and plugin", () => {
    const endpoints = [
      {
        slot: "app",
        overridable: true,
        defaultKey: "RegisteredUrl",
        overrideUrl: "https://override.example.com",
        effectiveUrl: "https://override.example.com",
      },
    ];
    const replaceEndpoints = vi.fn();
    mockUseProblemEndpoints.mockReturnValue({
      endpoints,
      error: undefined,
      replaceEndpoints,
    });
    mockFindMeta.mockReturnValue(meta());
    mockTeamView.mockReturnValue(teamView({ view: viewWith() }));

    renderPage();

    expect(mockEndpointOverrideForm).toHaveBeenCalledWith(
      expect.objectContaining({ endpoints, onEndpointsChange: replaceEndpoints }),
    );
    expect(mockPortalPluginSlots).toHaveBeenCalledWith(expect.objectContaining({ endpoints }));
  });

  it("should reset endpoint form state when the active problem or team changes", async () => {
    const user = userEvent.setup();
    let activeView = viewWith({
      problems: [problem({ problemId: "first" })],
      team: { teamId: "team-1", teamName: "Team One" },
    });
    mockFindMeta.mockReturnValue(meta());
    mockTeamView.mockImplementation(() => teamView({ view: activeView }));
    const rendered = renderPage();
    const draft = () => screen.getByRole("textbox", { name: "mock endpoint draft" });

    await user.type(draft(), "https://draft.example.com");
    expect(draft()).toHaveValue("https://draft.example.com");

    activeView = viewWith({
      problems: [problem({ problemId: "second" })],
      team: { teamId: "team-1", teamName: "Team One" },
    });
    rendered.rerender(<ProblemDetailPage config={config} />);
    expect(draft()).toHaveValue("");

    await user.type(draft(), "https://another-draft.example.com");
    activeView = viewWith({
      problems: [problem({ problemId: "second" })],
      team: { teamId: "team-2", teamName: "Team Two" },
    });
    rendered.rerender(<ProblemDetailPage config={config} />);
    expect(draft()).toHaveValue("");
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
