import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LeaderboardResponse, ParticipantTeamView } from "../../src/api/portal-client";

/**
 * Issue #1349: NextActionHero の render 4 状態 (not_started / ended / all_cleared / running) と
 * 「次の問題を開く」 button → navigate を pin する。 pure 戦術関数 (pickNextProblem 等) は別 test
 * で網羅済。 useT は key echo、 useNavigate は spy に差し替える。
 */
const { mockNavigate } = vi.hoisted(() => ({ mockNavigate: vi.fn() }));
vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return { ...actual, useNavigate: () => mockNavigate };
});
vi.mock("../../src/i18n", () => ({
  useT: () => (key: string, params?: Readonly<Record<string, string | number>>) =>
    params ? `${key}|${JSON.stringify(params)}` : key,
}));

const { NextActionHero, shouldShowNextActionHero } = await import(
  "../../src/components/NextActionHero"
);

const view = (over: Partial<ParticipantTeamView>): ParticipantTeamView =>
  ({ eventGate: undefined, problems: [], ...over }) as unknown as ParticipantTeamView;
const board = (over: Partial<LeaderboardResponse>): LeaderboardResponse =>
  ({ entries: [], ...over }) as unknown as LeaderboardResponse;

const UNSOLVED = {
  problemId: "p1",
  jobId: "job-1",
  status: "COMPLETE",
  score: 0,
  scoring: { kind: "flag", flagSubmitted: false },
};
const SOLVED = {
  problemId: "p2",
  jobId: "job-2",
  status: "COMPLETE",
  score: 100,
  scoring: { kind: "flag", flagSubmitted: true },
};
const UPTIME_UP = {
  problemId: "p3",
  jobId: "job-3",
  status: "COMPLETE",
  score: 100,
  scoring: { kind: "uptime" },
};

afterEach(() => vi.clearAllMocks());

describe("NextActionHero (render)", () => {
  it("should keep all states in mock and local modes", () => {
    for (const cloudMode of ["mock", "local"] as const) {
      expect(shouldShowNextActionHero(cloudMode, "running")).toBe(true);
      expect(shouldShowNextActionHero(cloudMode, "ended")).toBe(true);
    }
  });

  it("should hide only the duplicated running state in real competitions", () => {
    expect(shouldShowNextActionHero("real", "running")).toBe(false);
    for (const stateKind of ["not_started", "ended", "all_cleared", "defending"] as const) {
      expect(shouldShowNextActionHero("real", stateKind)).toBe(true);
    }
  });

  it("should suppress a real running hero while retaining the real ended summary", () => {
    const running = render(
      <NextActionHero
        cloudMode="real"
        view={view({ problems: [UNSOLVED] as never })}
        leaderboard={null}
      />,
    );
    expect(running.container.textContent).toBe("");
    running.unmount();

    const ended = render(
      <NextActionHero
        cloudMode="real"
        view={view({ eventGate: { kind: "scoring_ended" } })}
        leaderboard={null}
      />,
    );
    expect(ended.container.textContent).toContain("next_action.ended_no_rank");
  });

  it("should render nothing when there is no team view", () => {
    const { container } = render(
      <NextActionHero cloudMode="mock" view={null} leaderboard={null} />,
    );
    expect(container.textContent).toBe("");
  });

  it("should show the not-started countdown (with and without a startsAt)", () => {
    const withStart = render(
      <NextActionHero
        cloudMode="mock"
        view={view({
          eventGate: { kind: "scoring_not_started", startsAt: "2999-01-01T00:00:00Z" },
        })}
        leaderboard={null}
      />,
    );
    expect(withStart.container.textContent).toContain("next_action.not_started_starts_at");
    withStart.unmount();

    const noStart = render(
      <NextActionHero
        cloudMode="mock"
        view={view({ eventGate: { kind: "scoring_not_started" } })}
        leaderboard={null}
      />,
    );
    expect(noStart.container.textContent).toContain("next_action.not_started_unknown");
  });

  it("should show the ended summary with a final rank and without one", () => {
    const withRank = render(
      <NextActionHero
        cloudMode="mock"
        view={view({ eventGate: { kind: "scoring_ended" } })}
        leaderboard={board({ entries: [{ isMyTeam: true, rank: 3 }] as never })}
      />,
    );
    expect(withRank.container.textContent).toContain("next_action.ended_with_rank");
    withRank.unmount();

    const noRank = render(
      <NextActionHero
        cloudMode="mock"
        view={view({ eventGate: { kind: "scoring_ended" } })}
        leaderboard={null}
      />,
    );
    expect(noRank.container.textContent).toContain("next_action.ended_no_rank");
  });

  it("should show all-cleared when every problem is a submitted flag", () => {
    const { container } = render(
      <NextActionHero
        cloudMode="mock"
        view={view({ problems: [SOLVED] as never })}
        leaderboard={null}
      />,
    );
    expect(container.textContent).toContain("next_action.all_cleared");
  });

  it("should show defending (not all-cleared) for a scoring uptime Battle problem", () => {
    const { container } = render(
      <NextActionHero
        cloudMode="mock"
        view={view({ problems: [UPTIME_UP] as never })}
        leaderboard={null}
      />,
    );
    expect(container.textContent).toContain("next_action.defending");
    expect(container.textContent).not.toContain("next_action.all_cleared");
  });

  it("should suggest the next problem and navigate to it on click", () => {
    render(
      <NextActionHero
        cloudMode="mock"
        view={view({ problems: [UNSOLVED] as never })}
        leaderboard={null}
      />,
    );
    expect(screen.getByText(/next_action\.running_pick/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "next_action.running_open_button" }));
    expect(mockNavigate).toHaveBeenCalledWith("/problems/job-1");
  });

  it("should fall back to a non-COMPLETE unsolved problem when none are deploy-ready", () => {
    // ready (= COMPLETE) が 0 件 → pickNextProblem は unsolved pool をそのまま使う分岐。
    const inProgress = {
      problemId: "p3",
      jobId: "job-3",
      status: "IN_PROGRESS",
      score: 0,
      scoring: { kind: "uptime" },
    };
    render(
      <NextActionHero
        cloudMode="mock"
        view={view({ problems: [inProgress] as never })}
        leaderboard={null}
      />,
    );
    expect(screen.getByText(/next_action\.running_pick/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "next_action.running_open_button" }));
    expect(mockNavigate).toHaveBeenCalledWith("/problems/job-3");
  });

  it("should show the no-ready-problem running state when there is nothing to open", () => {
    // problems が空 → running 状態だが nextProblem 無し → button を出さず no_ready ラベル。
    const { container } = render(
      <NextActionHero cloudMode="mock" view={view({ problems: [] })} leaderboard={null} />,
    );
    expect(container.textContent).toContain("next_action.running_no_ready");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
