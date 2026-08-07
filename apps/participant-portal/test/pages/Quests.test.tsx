import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParticipantProblemView } from "../../src/api/portal-client";
import type { ProblemCatalogEntry } from "../../src/data/problems";

/**
 * Quests: pure helper `renderSubmissionState` の全 status 分岐と、 QuestsPage component の
 * render (error / loading / category filter + counts / 未解決・解決済 section split / card の
 * category・difficulty badge + Link navigate) を pin する。 共有 hook と findProblemMetadata は
 * mock、 categoryOf (lib/category) は実物。
 */
const { mockTeamView, mockNav, mockIsMock, mockAppConfig, mockFindMeta, mockListCatalog } =
  vi.hoisted(() => ({
    mockTeamView: vi.fn(),
    mockNav: vi.fn(),
    mockIsMock: vi.fn(),
    mockAppConfig: vi.fn(),
    mockFindMeta: vi.fn(),
    mockListCatalog: vi.fn(),
  }));

vi.mock("react-router", () => ({ useNavigate: () => mockNav }));
vi.mock("../../src/auth/TeamViewProvider", () => ({ useTeamView: mockTeamView }));
vi.mock("../../src/config-context", () => ({
  useAppConfig: mockAppConfig,
  useIsMock: mockIsMock,
}));
vi.mock("../../src/i18n", () => ({
  useT: () => (key: string, params?: Readonly<Record<string, string | number>>) =>
    params ? `${key}|${JSON.stringify(params)}` : key,
  // [#2928] The hero and the quest guidance resolve a problem's display name, which is
  // locale-aware, so the stub must expose the locale too.
  useI18n: () => ({ locale: "ja" }),
}));
vi.mock("../../src/data/problems", () => ({
  findProblemMetadata: mockFindMeta,
  listProblemCatalog: mockListCatalog,
}));
vi.mock("@cloudscape-design/components/text-filter", () => ({
  default: ({
    filteringAriaLabel,
    filteringPlaceholder,
    filteringText,
    onChange,
  }: {
    filteringAriaLabel: string;
    filteringPlaceholder: string;
    filteringText: string;
    onChange: (event: { detail: { filteringText: string } }) => void;
  }) => (
    <input
      aria-label={filteringAriaLabel}
      placeholder={filteringPlaceholder}
      value={filteringText}
      onChange={(event) => onChange({ detail: { filteringText: event.currentTarget.value } })}
    />
  ),
}));
vi.mock("@cloudscape-design/components/select", () => ({
  default: ({
    ariaLabel,
    onChange,
    options,
    selectedOption,
  }: {
    ariaLabel: string;
    onChange: (event: { detail: { selectedOption: { label: string; value: string } } }) => void;
    options: readonly { label: string; value: string }[];
    selectedOption: { label: string; value: string };
  }) => (
    <select
      aria-label={ariaLabel}
      value={selectedOption.value}
      onChange={(event) => {
        const option = options.find((candidate) => candidate.value === event.currentTarget.value);
        if (option) onChange({ detail: { selectedOption: option } });
      }}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

const { renderSubmissionState, questCardTitle, QuestsPage } = await import(
  "../../src/pages/Quests"
);

function problem(partial: Partial<ParticipantProblemView>): ParticipantProblemView {
  return {
    jobId: "job-x",
    problemId: "hello-world",
    region: "ap-northeast-1",
    awsAccountId: "999999999999",
    status: "COMPLETE",
    stackOutputs: {},
    expiresAt: 0,
    score: 0,
    deployLog: { cursor: "", entries: [] },
    ...partial,
  };
}

function alignedCatalogEntry(id: string, name: string): ProblemCatalogEntry {
  return {
    id,
    name,
    category: "Challenge",
    status: "ready",
    visibility: "public",
    difficulty: 1,
    estimatedDuration: "20 min",
    shortDescription: "course problem",
    learningGoals: [],
    tags: [],
    endpoints: [],
    phases: [],
    disruptions: [],
    runtime: { provider: "docker", engine: "compose" },
    track: { id: "ac26", order: 10, chapter: "Fine-grained chapter" },
    courseAlignment: {
      courseId: "advanced-cryptography-program",
      edition: "2026",
      week: 1,
      role: "diagnostic",
      sources: [],
    },
    graphNodes: [],
    graphRelations: [],
  };
}

function pseudoT(key: string, params?: Readonly<Record<string, string | number>>): string {
  if (!params) return `[${key}]`;
  return `[${key}|${Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join(",")}]`;
}

describe("renderSubmissionState scoring badge", () => {
  it("should show error type for FAILED deploys", () => {
    const s = renderSubmissionState(problem({ status: "FAILED" }), pseudoT);
    expect(s.type).toBe("error");
    expect(s.label).toBe("[quests.submission_failed]");
  });

  it("should show warning for EXPIRED and stopped for DELETED / AUTO_DELETED", () => {
    expect(renderSubmissionState(problem({ status: "EXPIRED" }), pseudoT).type).toBe("warning");
    expect(renderSubmissionState(problem({ status: "DELETED" }), pseudoT).type).toBe("stopped");
    expect(renderSubmissionState(problem({ status: "AUTO_DELETED" }), pseudoT).type).toBe(
      "stopped",
    );
  });

  it("should show in-progress type while the deploy is PENDING / IN_PROGRESS / DELETING", () => {
    expect(renderSubmissionState(problem({ status: "PENDING" }), pseudoT).type).toBe("in-progress");
    expect(renderSubmissionState(problem({ status: "IN_PROGRESS" }), pseudoT).type).toBe(
      "in-progress",
    );
    expect(renderSubmissionState(problem({ status: "DELETING" }), pseudoT).type).toBe(
      "in-progress",
    );
  });

  it("Issue #2019: should show in-progress (not solvable) for a held APPROVAL_PENDING deploy", () => {
    const s = renderSubmissionState(problem({ status: "APPROVAL_PENDING" }), pseudoT);
    // Held deploy has no stack — never present it as solvable; reuse the PENDING label.
    expect(s.type).toBe("in-progress");
    expect(s.label).toBe("[quests.status_label.PENDING]");
  });

  it("should show pending type (= 未着手) when flag is not yet submitted", () => {
    const s = renderSubmissionState(
      problem({ status: "COMPLETE", scoring: { kind: "flag", flagSubmitted: false } }),
      pseudoT,
    );
    expect(s.type).toBe("pending");
    expect(s.label).toBe("[quests.submission_unsolved]");
  });

  it("should include points (+Npt) when flag is submitted and scoring.points is known", () => {
    const s = renderSubmissionState(
      problem({ status: "COMPLETE", scoring: { kind: "flag", flagSubmitted: true, points: 100 } }),
      pseudoT,
    );
    expect(s.type).toBe("success");
    expect(s.label).toBe("[quests.submission_cleared_with_points|points=100]");
  });

  it("should fall back to plain cleared label when points is missing", () => {
    const s = renderSubmissionState(
      problem({ status: "COMPLETE", scoring: { kind: "flag", flagSubmitted: true } }),
      pseudoT,
    );
    expect(s.label).toBe("[quests.submission_cleared]");
  });

  it("#2885: should show an untouched multi-flag problem as unsolved", () => {
    const s = renderSubmissionState(
      problem({
        scoring: {
          kind: "multi-flag",
          flags: [
            { id: "a", label: "A", points: 20, solved: false },
            { id: "b", label: "B", points: 30, solved: false },
          ],
        },
      }),
      pseudoT,
    );
    expect(s).toEqual({ type: "pending", label: "[quests.submission_unsolved]" });
  });

  it("#2885: should show solved and total counts for a partial multi-flag problem", () => {
    const s = renderSubmissionState(
      problem({
        scoring: {
          kind: "multi-flag",
          flags: [
            { id: "a", label: "A", points: 20, solved: true },
            { id: "b", label: "B", points: 30, solved: false },
          ],
        },
      }),
      pseudoT,
    );
    expect(s).toEqual({
      type: "info",
      label: "[quests.submission_in_progress_with_count|solved=1,total=2]",
    });
  });

  it("#2885: should show a fully solved multi-flag problem as cleared with total points", () => {
    const s = renderSubmissionState(
      problem({
        scoring: {
          kind: "multi-flag",
          points: 50,
          flags: [
            { id: "a", label: "A", points: 20, solved: true },
            { id: "b", label: "B", points: 30, solved: true },
          ],
        },
      }),
      pseudoT,
    );
    expect(s).toEqual({
      type: "success",
      label: "[quests.submission_cleared_with_points|points=50]",
    });
  });

  it("#2885: should use the plain cleared label when multi-flag total points are absent", () => {
    const s = renderSubmissionState(
      problem({
        scoring: {
          kind: "multi-flag",
          flags: [{ id: "a", label: "A", points: 20, solved: true }],
        },
      }),
      pseudoT,
    );
    expect(s).toEqual({ type: "success", label: "[quests.submission_cleared]" });
  });

  it("#2885: should treat a legacy multi-flag view without flags as unsolved", () => {
    const s = renderSubmissionState(problem({ scoring: { kind: "multi-flag" } }), pseudoT);
    expect(s).toEqual({ type: "pending", label: "[quests.submission_unsolved]" });
  });

  it("should fall through to 'in progress' info for non-flag uptime scoring", () => {
    const s = renderSubmissionState(
      problem({ status: "COMPLETE", scoring: { kind: "uptime" }, score: 60 }),
      pseudoT,
    );
    expect(s.type).toBe("info");
    expect(s.label).toBe("[quests.submission_in_progress]");
  });
});

const flagUnsolved = problem({
  problemId: "ctf-unsolved",
  jobId: "job-1",
  scoring: { kind: "flag", flagSubmitted: false },
});
const flagCleared = problem({
  problemId: "ctf-cleared",
  jobId: "job-2",
  scoring: { kind: "flag", flagSubmitted: true, points: 50 },
});
const battle = problem({
  problemId: "uptime-battle",
  jobId: "job-3",
  scoring: { kind: "uptime" },
});
const uncategorized = problem({ problemId: "legacy", jobId: "job-4", scoring: undefined });

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

beforeEach(() => {
  mockIsMock.mockReturnValue(false);
  mockAppConfig.mockReturnValue({ cloudMode: "mock" });
  mockListCatalog.mockReturnValue([]);
  mockNav.mockClear();
  mockFindMeta.mockReset();
  // difficulty badge: 既知 problem は metadata あり、 それ以外は undefined (= badge 無し)。
  mockFindMeta.mockImplementation((id: string) =>
    id === "ctf-unsolved" ? { difficulty: 3 } : undefined,
  );
});

afterEach(() => vi.clearAllMocks());

describe("questCardTitle (issue #2189: card must show the display name, not the id)", () => {
  it("should return the catalog display name when metadata is found", () => {
    mockFindMeta.mockImplementation((id: string) =>
      id === "sqli-demo" ? { name: "スタッフ専用ログイン" } : undefined,
    );
    expect(questCardTitle("sqli-demo")).toBe("スタッフ専用ログイン");
  });

  it("should fall back to the problem id when no metadata is found", () => {
    mockFindMeta.mockImplementation(() => undefined);
    expect(questCardTitle("unknown-problem")).toBe("unknown-problem");
  });
});

describe("QuestsPage", () => {
  it("#2882: should keep all 40 unaligned problems and leave the course problem to /course-tracks", () => {
    mockAppConfig.mockReturnValue({ cloudMode: "local" });
    const aligned = problem({
      problemId: "course-first",
      jobId: "job-course-first",
      scoring: { kind: "flag", flagSubmitted: false },
    });
    const unaligned = Array.from({ length: 40 }, (_, index) =>
      problem({
        problemId: `legacy-${index + 1}`,
        jobId: `job-legacy-${index + 1}`,
        scoring: { kind: "flag", flagSubmitted: false },
      }),
    );
    mockListCatalog.mockReturnValue([alignedCatalogEntry("course-first", "Course first")]);
    mockTeamView.mockReturnValue({ view: { problems: [aligned, ...unaligned] }, error: null });

    render(<QuestsPage />);

    // 学習ルートそのものは出さない (置き場は /course-tracks)。 一覧が持つのは行き先だけ。
    expect(screen.queryByTestId("course-guidance")).not.toBeInTheDocument();
    expect(screen.queryByTestId("course-recommended")).not.toBeInTheDocument();
    expect(screen.queryByTestId("course-problem-course-first")).not.toBeInTheDocument();
    expect(screen.queryByText("Week 1")).not.toBeInTheDocument();

    // 講座の問題は一覧から外れたままで、 それ以外の 40 問はこれまでどおり全部出る。
    expect(screen.getByText("legacy-1")).toBeInTheDocument();
    expect(screen.getByText("legacy-40")).toBeInTheDocument();
    expect(screen.getAllByText(/quests\.filter_all \(40\)/).length).toBeGreaterThan(0);
  });

  it("should send the participant to /course-tracks for the course learning path", () => {
    mockAppConfig.mockReturnValue({ cloudMode: "local" });
    mockListCatalog.mockReturnValue([alignedCatalogEntry("course-first", "Course first")]);
    mockTeamView.mockReturnValue({ view: { problems: [] }, error: null });

    render(<QuestsPage />);
    fireEvent.click(screen.getByTestId("course-tracks-link"));

    expect(mockNav).toHaveBeenCalledWith("/course-tracks");
  });

  it("should explain the two local learning paths and open the recommended first problem", () => {
    mockAppConfig.mockReturnValue({ cloudMode: "local" });
    const aligned = problem({
      problemId: "course-first",
      jobId: "job-course-first",
      scoring: { kind: "flag", flagSubmitted: false },
    });
    mockListCatalog.mockReturnValue([alignedCatalogEntry("course-first", "Course first")]);
    mockTeamView.mockReturnValue({ view: { problems: [aligned] }, error: null });

    render(<QuestsPage />);

    const guidance = screen.getByTestId("local-start-guidance");
    expect(guidance).toHaveTextContent("quests.local_start_course_body");
    expect(guidance).toHaveTextContent("quests.local_start_other_body");
    expect(guidance).toHaveTextContent("Course first");

    fireEvent.click(screen.getByTestId("local-next-problem"));
    expect(mockNav).toHaveBeenCalledWith("/problems/job-course-first");
  });

  /**
   * [#2928] The only course track is a graduate-level cryptography programme, so "new here?
   * start with a course track" pointed a first-time participant at the hardest thing in the
   * catalog. When the platform has pinned an intro drill and the participant has solved
   * nothing, the drill is the primary action and the track drops to the secondary one.
   */
  it("should send a first-time participant to the pinned intro drill, not the course track", () => {
    mockAppConfig.mockReturnValue({ cloudMode: "local" });
    const intro = problem({
      problemId: "sqli-demo",
      jobId: "job-intro",
      name: "スタッフ専用ログイン",
      recommended: true,
      scoring: { kind: "flag", flagSubmitted: false },
    });
    const aligned = problem({
      problemId: "course-first",
      jobId: "job-course-first",
      scoring: { kind: "flag", flagSubmitted: false },
    });
    mockListCatalog.mockReturnValue([alignedCatalogEntry("course-first", "Course first")]);
    mockTeamView.mockReturnValue({ view: { problems: [aligned, intro] }, error: null });

    render(<QuestsPage />);

    const guidance = screen.getByTestId("local-start-guidance");
    expect(guidance).toHaveTextContent("quests.local_start_intro_body");
    expect(guidance).toHaveTextContent("スタッフ専用ログイン");
    // The course track stays reachable, just not as the headline for a newcomer.
    expect(screen.queryByTestId("local-next-problem")).not.toBeInTheDocument();
    expect(screen.getByTestId("course-tracks-link")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("local-intro-problem"));
    expect(mockNav).toHaveBeenCalledWith("/problems/job-intro");
  });

  it("should return to the course-track guidance once the participant has solved anything", () => {
    mockAppConfig.mockReturnValue({ cloudMode: "local" });
    const intro = problem({
      problemId: "sqli-demo",
      jobId: "job-intro",
      name: "スタッフ専用ログイン",
      recommended: true,
      scoring: { kind: "flag", flagSubmitted: true },
    });
    const aligned = problem({
      problemId: "course-first",
      jobId: "job-course-first",
      scoring: { kind: "flag", flagSubmitted: false },
    });
    mockListCatalog.mockReturnValue([alignedCatalogEntry("course-first", "Course first")]);
    mockTeamView.mockReturnValue({ view: { problems: [aligned, intro] }, error: null });

    render(<QuestsPage />);

    const guidance = screen.getByTestId("local-start-guidance");
    expect(guidance).toHaveTextContent("quests.local_start_course_body");
    expect(screen.queryByTestId("local-intro-problem")).not.toBeInTheDocument();
    expect(screen.getByTestId("local-next-problem")).toBeInTheDocument();
  });

  it.each([
    "mock",
    "real",
  ] as const)("should not show local start guidance in %s mode", (cloudMode) => {
    mockAppConfig.mockReturnValue({ cloudMode });
    mockListCatalog.mockReturnValue([alignedCatalogEntry("course-first", "Course first")]);
    mockTeamView.mockReturnValue({ view: { problems: [] }, error: null });

    render(<QuestsPage />);

    expect(screen.queryByTestId("local-start-guidance")).not.toBeInTheDocument();
  });

  it("should show the problem's display name (not its raw id) on the quest card", () => {
    mockFindMeta.mockImplementation((id: string) =>
      id === "ctf-unsolved" ? { difficulty: 3, name: "スタッフ専用ログイン" } : undefined,
    );
    mockTeamView.mockReturnValue({ view: { problems: [flagUnsolved] }, error: null });
    render(<QuestsPage />);
    expect(screen.getByText("スタッフ専用ログイン")).toBeInTheDocument();
    expect(screen.queryByText("ctf-unsolved")).not.toBeInTheDocument();
  });

  it("should show a loading spinner while the view is undefined", () => {
    mockTeamView.mockReturnValue({ view: undefined, error: null });
    render(<QuestsPage />);
    expect(screen.getByText("quests.loading_text")).toBeInTheDocument();
  });

  it("should show an error alert (and not the loading spinner)", () => {
    mockTeamView.mockReturnValue({ view: undefined, error: "boom" });
    render(<QuestsPage />);
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(screen.queryByText("quests.loading_text")).not.toBeInTheDocument();
  });

  it("should not show a spinner in mock mode even without a view", () => {
    mockIsMock.mockReturnValue(true);
    mockTeamView.mockReturnValue({ view: undefined, error: null });
    render(<QuestsPage />);
    expect(screen.queryByText("quests.loading_text")).not.toBeInTheDocument();
    // unsolved も cleared も空 → 両 empty state。
    expect(screen.getByText("quests.empty_unsolved")).toBeInTheDocument();
  });

  it("should split unsolved vs cleared and render category + difficulty badges", () => {
    mockTeamView.mockReturnValue({
      view: { problems: [flagUnsolved, flagCleared, battle, uncategorized] },
      error: null,
    });
    render(<QuestsPage />);
    // unsolved card (challenge badge + difficulty badge)。 Challenge は flagUnsolved と
    // flagCleared の 2 枚に出る (cleared section は collapsed でも DOM 上にある)。
    expect(screen.getByText("ctf-unsolved")).toBeInTheDocument();
    expect(screen.getAllByText("Challenge")).toHaveLength(2);
    expect(screen.getByText(/quests\.difficulty_label/)).toBeInTheDocument();
    // battle category badge + uncategorized badge
    expect(screen.getByText("Battle")).toBeInTheDocument();
    expect(screen.getByText("quests.category_uncategorized")).toBeInTheDocument();
    // counts in the segmented control: all=4, battle=1, challenge=2
    // (SegmentedControl は segment + responsive select の 2 箇所に text を出す)
    expect(screen.getAllByText(/quests\.filter_all \(4\)/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/quests\.filter_battle \(1\)/).length).toBeGreaterThan(0);
  });

  it("should navigate to the problem detail when a card link is followed", () => {
    mockTeamView.mockReturnValue({ view: { problems: [flagUnsolved] }, error: null });
    render(<QuestsPage />);
    fireEvent.click(screen.getByText("ctf-unsolved"));
    expect(mockNav).toHaveBeenCalledWith("/problems/job-1");
  });

  it("should filter to a single category via the segmented control", () => {
    mockTeamView.mockReturnValue({ view: { problems: [flagUnsolved, battle] }, error: null });
    render(<QuestsPage />);
    expect(screen.getByText("uptime-battle")).toBeInTheDocument();
    // battle filter を選ぶと challenge の ctf-unsolved が消える (segment button = 先頭要素)。
    fireEvent.click(screen.getAllByText(/quests\.filter_battle \(1\)/)[0]);
    expect(screen.getByText("uptime-battle")).toBeInTheDocument();
    expect(screen.queryByText("ctf-unsolved")).not.toBeInTheDocument();
  });

  it("should search problem titles, descriptions, and tags", () => {
    mockListCatalog.mockReturnValue([
      {
        ...alignedCatalogEntry("ctf-unsolved", "Database Login"),
        shortDescription: "Find the unsafe query",
        tags: ["SQL", "authentication"],
      },
      alignedCatalogEntry("uptime-battle", "Keep It Running"),
    ]);
    mockFindMeta.mockImplementation((id: string) =>
      id === "ctf-unsolved" ? { difficulty: 1, name: "Database Login" } : undefined,
    );
    mockTeamView.mockReturnValue({ view: { problems: [flagUnsolved, battle] }, error: null });
    render(<QuestsPage />);

    const search = screen.getByLabelText("quests.search_label");
    fireEvent.change(search, { target: { value: "authentication" } });

    expect(screen.getByText("Database Login")).toBeInTheDocument();
    expect(screen.queryByText("uptime-battle")).not.toBeInTheDocument();
  });

  it("should combine difficulty and answer-status filters", () => {
    mockListCatalog.mockReturnValue([
      { ...alignedCatalogEntry("ctf-unsolved", "Unsolved"), difficulty: 3 },
      { ...alignedCatalogEntry("ctf-cleared", "Cleared"), difficulty: 3 },
      { ...alignedCatalogEntry("uptime-battle", "Battle"), difficulty: 4 },
    ]);
    mockTeamView.mockReturnValue({
      view: { problems: [flagUnsolved, flagCleared, battle] },
      error: null,
    });
    render(<QuestsPage />);

    fireEvent.change(screen.getByLabelText("quests.difficulty_filter_label"), {
      target: { value: "3" },
    });
    fireEvent.change(screen.getByLabelText("quests.answer_status_filter_label"), {
      target: { value: "cleared" },
    });

    expect(screen.getByText("ctf-cleared")).toBeInTheDocument();
    expect(screen.queryByText("ctf-unsolved")).not.toBeInTheDocument();
    expect(screen.queryByText("uptime-battle")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("quests.difficulty_filter_label"), {
      target: { value: "all" },
    });
    expect(screen.getByText("ctf-cleared")).toBeInTheDocument();
  });

  it("should show one explicit empty state when active filters match no problems", () => {
    mockListCatalog.mockReturnValue([alignedCatalogEntry("ctf-unsolved", "Database Login")]);
    mockTeamView.mockReturnValue({ view: { problems: [flagUnsolved] }, error: null });
    render(<QuestsPage />);

    fireEvent.change(screen.getByLabelText("quests.search_label"), {
      target: { value: "does-not-exist" },
    });

    expect(screen.getByText("quests.filter_empty_header")).toBeInTheDocument();
    expect(screen.getByText("quests.filter_empty_body")).toBeInTheDocument();
    expect(screen.queryByText("quests.empty_unsolved")).not.toBeInTheDocument();
  });

  it("should show the empty-cleared box when there are no cleared problems", () => {
    mockTeamView.mockReturnValue({ view: { problems: [flagUnsolved] }, error: null });
    render(<QuestsPage />);
    expect(screen.getByText("quests.empty_cleared")).toBeInTheDocument();
  });

  it("should render a cleared problem in the cleared section", () => {
    mockTeamView.mockReturnValue({ view: { problems: [flagCleared] }, error: null });
    render(<QuestsPage />);
    // 未解決は空。
    expect(screen.getByText("quests.empty_unsolved")).toBeInTheDocument();
    // 解決済 section に cleared card。
    expect(screen.getByText("ctf-cleared")).toBeInTheDocument();
  });

  it("#2885: should move only a fully solved multi-flag problem to the cleared section", () => {
    const partial = problem({
      problemId: "multi-partial",
      jobId: "job-multi-partial",
      scoring: {
        kind: "multi-flag",
        flags: [
          { id: "a", label: "A", points: 20, solved: true },
          { id: "b", label: "B", points: 30, solved: false },
        ],
      },
    });
    const complete = problem({
      problemId: "multi-complete",
      jobId: "job-multi-complete",
      scoring: {
        kind: "multi-flag",
        points: 50,
        flags: [
          { id: "a", label: "A", points: 20, solved: true },
          { id: "b", label: "B", points: 30, solved: true },
        ],
      },
    });
    const legacyWithoutFlags = problem({
      problemId: "multi-legacy",
      jobId: "job-multi-legacy",
      scoring: { kind: "multi-flag" },
    });
    mockTeamView.mockReturnValue({
      view: { problems: [partial, complete, legacyWithoutFlags] },
      error: null,
    });

    render(<QuestsPage />);

    expect(screen.queryByText("quests.empty_unsolved")).not.toBeInTheDocument();
    expect(screen.getByText("multi-partial")).toBeInTheDocument();
    expect(screen.getByText("multi-complete")).toBeInTheDocument();
    expect(screen.getByText("multi-legacy")).toBeInTheDocument();
    expect(screen.getByText(/quests\.submission_in_progress_with_count/)).toBeInTheDocument();
    expect(screen.getByText(/quests\.submission_cleared_with_points/)).toBeInTheDocument();
  });

  // Local play's fixed intro drill (sqli-demo): the backend
  // pins it first in `view.problems` and flags it `recommended: true`; the portal's
  // only job is to render the "start here" badge on that card.
  it("should show a start-here badge on the recommended intro drill", () => {
    const introDrill = problem({
      problemId: "sqli-demo",
      jobId: "job-sqli",
      scoring: { kind: "flag", flagSubmitted: false },
      recommended: true,
    });
    mockTeamView.mockReturnValue({ view: { problems: [introDrill] }, error: null });
    render(<QuestsPage />);
    expect(screen.getByText("quests.recommended_start_here")).toBeInTheDocument();
  });

  it("should not show the start-here badge on a problem without the recommended flag", () => {
    mockTeamView.mockReturnValue({ view: { problems: [flagUnsolved] }, error: null });
    render(<QuestsPage />);
    expect(screen.queryByText("quests.recommended_start_here")).not.toBeInTheDocument();
  });
});

// ── Issue #2283: Progression Gate の badge / 解放条件表示 ─────────────────────
const gateProgression = (over: Record<string, unknown> = {}) => ({
  gateProblemId: "uptime-battle",
  gateCompleted: false,
  policy: "required",
  completionBonus: 100,
  lockedProblemIds: ["ctf-unsolved"],
  ...over,
});

describe("QuestsPage Progression Gate (Issue #2283)", () => {
  it("should show a locked badge and the unlock condition on a locked card (still visible)", () => {
    mockTeamView.mockReturnValue({
      view: { problems: [flagUnsolved, battle], progression: gateProgression() },
      error: null,
    });
    render(<QuestsPage />);
    // locked card は隠さない
    expect(screen.getByText("ctf-unsolved")).toBeInTheDocument();
    expect(screen.getByText("quests.locked_badge")).toBeInTheDocument();
    // gate 問題の name は view に無い → problemId に fall back
    expect(
      screen.getByText('quests.locked_unlock_condition|{"gateName":"uptime-battle"}'),
    ).toBeInTheDocument();
  });

  it("should resolve the gate display name for the unlock condition when the view carries it", () => {
    const namedGate = problem({
      problemId: "uptime-battle",
      jobId: "job-3",
      name: "Hello World Battle",
      scoring: { kind: "uptime" },
    });
    mockTeamView.mockReturnValue({
      view: { problems: [flagUnsolved, namedGate], progression: gateProgression() },
      error: null,
    });
    render(<QuestsPage />);
    expect(
      screen.getByText('quests.locked_unlock_condition|{"gateName":"Hello World Battle"}'),
    ).toBeInTheDocument();
  });

  it("should show the start-here badge and the completion bonus on the incomplete gate card", () => {
    mockTeamView.mockReturnValue({
      view: { problems: [flagUnsolved, battle], progression: gateProgression() },
      error: null,
    });
    render(<QuestsPage />);
    expect(screen.getByText("quests.gate_start_here")).toBeInTheDocument();
    expect(screen.getByText('quests.gate_completion_bonus|{"points":100}')).toBeInTheDocument();
  });

  it("should omit the completion-bonus badge when the bonus is 0", () => {
    mockTeamView.mockReturnValue({
      view: {
        problems: [flagUnsolved, battle],
        progression: gateProgression({ completionBonus: 0 }),
      },
      error: null,
    });
    render(<QuestsPage />);
    expect(screen.getByText("quests.gate_start_here")).toBeInTheDocument();
    expect(screen.queryByText(/quests\.gate_completion_bonus/)).not.toBeInTheDocument();
  });

  it("should show the bonus badge but no unlock promise for a policy-off team (Issue #2283)", () => {
    // policy "off" の team は lockedProblemIds が空 → 「最初にここから (完了で解放)」は虚偽なので
    // 出さない。 完了 bonus は locked の有無と無関係に付与されるため badge は残す。
    mockTeamView.mockReturnValue({
      view: {
        problems: [flagUnsolved, battle],
        progression: gateProgression({ policy: "off", lockedProblemIds: [] }),
      },
      error: null,
    });
    render(<QuestsPage />);
    expect(screen.queryByText("quests.gate_start_here")).not.toBeInTheDocument();
    expect(screen.queryByText("quests.locked_badge")).not.toBeInTheDocument();
    expect(screen.getByText('quests.gate_completion_bonus|{"points":100}')).toBeInTheDocument();
  });

  it("should drop all gate badges once the gate is completed (locked list emptied)", () => {
    mockTeamView.mockReturnValue({
      view: {
        problems: [flagUnsolved, battle],
        progression: gateProgression({ gateCompleted: true, lockedProblemIds: [] }),
      },
      error: null,
    });
    render(<QuestsPage />);
    expect(screen.queryByText("quests.gate_start_here")).not.toBeInTheDocument();
    expect(screen.queryByText("quests.locked_badge")).not.toBeInTheDocument();
    expect(screen.queryByText(/quests\.locked_unlock_condition/)).not.toBeInTheDocument();
    expect(screen.queryByText(/quests\.gate_completion_bonus/)).not.toBeInTheDocument();
  });

  it("should render no gate UI at all without progression (= feature flag OFF / no gate config)", () => {
    mockTeamView.mockReturnValue({ view: { problems: [flagUnsolved, battle] }, error: null });
    render(<QuestsPage />);
    expect(screen.queryByText("quests.gate_start_here")).not.toBeInTheDocument();
    expect(screen.queryByText("quests.locked_badge")).not.toBeInTheDocument();
  });
});
