import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config";
import type { ProblemCatalogEntry } from "../data/problems";
import { HomePage } from "./Home";

/**
 * [#2882] ホームの「次にどこへ行くか」。
 *
 * 講座トラック画面も推奨する次の 1 問 (#2790) も既にあったのに、 ホームの主ボタンが常に
 * フラットな問題一覧 (`/problems`) を指していた。 実際に local モードで開いた参加者は 71 件の
 * 一覧に着き、 「多すぎて何をやればいいか分からない」で止まった。 UI が壊れていたのではなく、
 * 作ってある道に案内していなかった。
 *
 * ここで固定するのは 2 つ:
 *   - local では次の 1 問を名指しし、 主ボタンはトラック画面へ向く
 *   - トラックが無いとき (AWS mode / 講座外) は従来どおりフラット一覧のまま
 */

vi.mock("../i18n", () => ({
  useT:
    () =>
    (key: string, params?: Record<string, string | number>): string =>
      params ? `${key}:${JSON.stringify(params)}` : key,
}));

const teamView: {
  view: { team: { teamName: string }; problems: unknown[] } | null;
  error: string | null;
  leaderboard: unknown;
} = { view: null, error: null, leaderboard: null };
vi.mock("../auth/TeamViewProvider", () => ({ useTeamView: () => teamView }));
vi.mock("../auth/AuthProvider", () => ({ useAuth: () => ({ session: null }) }));
vi.mock("../config-context", () => ({ useIsMock: () => true }));
vi.mock("../components/NextActionHero", () => ({ NextActionHero: () => null }));
vi.mock("../components/ScoreTimelineChart", () => ({ ScoreTimelineChart: () => null }));
vi.mock("./TeamScorePanel", () => ({ TeamScorePanel: () => null }));

const navigate = vi.fn();
vi.mock("react-router", () => ({ useNavigate: () => navigate }));

const catalog: { entries: ProblemCatalogEntry[] } = { entries: [] };
vi.mock("../data/problems", () => ({ listProblemCatalog: () => catalog.entries }));

function trackedEntry(id: string, order: number, week: number): ProblemCatalogEntry {
  return {
    id,
    name: id,
    category: "Challenge",
    status: "ready",
    visibility: "public",
    difficulty: 2,
    estimatedDuration: "30 分",
    shortDescription: "s",
    learningGoals: [],
    tags: [],
    endpoints: [],
    phases: [],
    disruptions: [],
    runtime: { provider: "docker", engine: "compose" },
    graphNodes: [],
    graphRelations: [],
    track: { id: "ac26", order, chapter: `Week ${week}` },
    courseAlignment: {
      courseId: "advanced-cryptography-program",
      edition: "2026",
      week,
      role: "companion",
      sources: [],
    },
  } as ProblemCatalogEntry;
}

function config(cloudMode: AppConfig["cloudMode"]): AppConfig {
  return {
    apiBaseUrl: "https://api.example.com",
    eventTitle: "Test event",
    eventRegion: "ap-northeast-1",
    mode: "dev-mock",
    cloudMode,
  } as AppConfig;
}

describe("HomePage next destination (#2882)", () => {
  beforeEach(() => {
    navigate.mockReset();
    catalog.entries = [];
    teamView.view = { team: { teamName: "t" }, problems: [] };
  });

  it("should name the next course problem and send the primary button to the track in local mode", async () => {
    const user = userEvent.setup();
    catalog.entries = [trackedEntry("ac26-first", 1, 1), trackedEntry("ac26-second", 2, 1)];
    teamView.view = {
      team: { teamName: "t" },
      problems: [
        { problemId: "ac26-first", jobId: "j1", status: "COMPLETE" },
        { problemId: "ac26-second", jobId: "j2", status: "COMPLETE" },
      ],
    };

    render(<HomePage config={config("local")} />);

    // 件数ではなく、 次にやる 1 問の名前が出る。
    expect(screen.getByText(/home\.course_next_body.*ac26-first/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "home.course_next_button" }));
    expect(navigate).toHaveBeenCalledWith("/course-tracks");
  });

  it("should keep the flat quest list as the primary destination when there is no track", async () => {
    const user = userEvent.setup();
    // AWS mode: showsCourseTracks が false なので、 catalog に track があっても使わない。
    catalog.entries = [trackedEntry("ac26-first", 1, 1)];
    teamView.view = {
      team: { teamName: "t" },
      problems: [{ problemId: "ac26-first", jobId: "j1", status: "COMPLETE" }],
    };

    render(<HomePage config={config("real")} />);

    expect(
      screen.queryByRole("button", { name: "home.course_next_button" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "home.quests_quick_link_button" }));
    expect(navigate).toHaveBeenCalledWith("/problems");
  });

  it("should fall back to the flat list in local mode once the track is finished", () => {
    // 全問クリア = recommendedNext なし。 「次の 1 問」を出しようがないので従来表示へ戻す。
    catalog.entries = [trackedEntry("ac26-first", 1, 1)];
    teamView.view = {
      team: { teamName: "t" },
      problems: [
        {
          problemId: "ac26-first",
          jobId: "j1",
          status: "COMPLETE",
          scoring: { kind: "flag", flagSubmitted: true },
        },
      ],
    };

    render(<HomePage config={config("local")} />);

    expect(
      screen.queryByRole("button", { name: "home.course_next_button" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "home.quests_quick_link_button" }),
    ).toBeInTheDocument();
  });
});
