import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParticipantProblemView } from "../../src/api/portal-client";

/**
 * Quests: pure helper `renderSubmissionState` の全 status 分岐と、 QuestsPage component の
 * render (error / loading / category filter + counts / 未解決・解決済 section split / card の
 * category・difficulty badge + Link navigate) を pin する。 共有 hook と findProblemMetadata は
 * mock、 categoryOf (lib/category) は実物。
 */
const { mockTeamView, mockNav, mockIsMock, mockFindMeta } = vi.hoisted(() => ({
  mockTeamView: vi.fn(),
  mockNav: vi.fn(),
  mockIsMock: vi.fn(),
  mockFindMeta: vi.fn(),
}));

vi.mock("react-router", () => ({ useNavigate: () => mockNav }));
vi.mock("../../src/auth/TeamViewProvider", () => ({ useTeamView: mockTeamView }));
vi.mock("../../src/config-context", () => ({ useIsMock: mockIsMock }));
vi.mock("../../src/i18n", () => ({
  useT: () => (key: string, params?: Readonly<Record<string, string | number>>) =>
    params ? `${key}|${JSON.stringify(params)}` : key,
}));
vi.mock("../../src/data/problems", () => ({ findProblemMetadata: mockFindMeta }));

const { renderSubmissionState, QuestsPage } = await import("../../src/pages/Quests");

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
  mockNav.mockClear();
  mockFindMeta.mockReset();
  // difficulty badge: 既知 problem は metadata あり、 それ以外は undefined (= badge 無し)。
  mockFindMeta.mockImplementation((id: string) =>
    id === "ctf-unsolved" ? { difficulty: 3 } : undefined,
  );
});

afterEach(() => vi.clearAllMocks());

describe("QuestsPage", () => {
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
});
