import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProblemCatalogEntry } from "../data/problems";
import { CourseTracksPage } from "./CourseTracks";

/**
 * Issue #2786: 講座 track 画面。
 *
 * catalog は build 時 glob なので、 submodule の pin 次第で track 付き問題が 0 件のことも
 * ある。 テストは catalog を差し替えて、 「track がある / 無い」 両方を固定する。
 */

vi.mock("../i18n", () => ({
  useT:
    () =>
    (key: string, params?: Record<string, string | number>): string =>
      params ? `${key}:${JSON.stringify(params)}` : key,
}));

const teamView: {
  view: { problems: { problemId: string; jobId: string; scoring?: unknown }[] } | null;
  error: string | null;
} = { view: null, error: null };
vi.mock("../auth/TeamViewProvider", () => ({ useTeamView: () => teamView }));

const navigate = vi.fn();
vi.mock("react-router", () => ({ useNavigate: () => navigate }));

const catalog: { entries: ProblemCatalogEntry[] } = { entries: [] };
vi.mock("../data/problems", () => ({ listProblemCatalog: () => catalog.entries }));

function entry(overrides: Partial<ProblemCatalogEntry>): ProblemCatalogEntry {
  return {
    id: "p",
    name: "p",
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
    ...overrides,
  } as ProblemCatalogEntry;
}

function tracked(
  id: string,
  order: number,
  chapter: string,
  extra: Partial<ProblemCatalogEntry> = {},
) {
  return entry({ id, name: id, track: { id: "ac26", order, chapter }, ...extra });
}

function alignment(role: string, sources: ProblemCourseAlignmentSources = []) {
  return {
    courseAlignment: {
      courseId: "advanced-cryptography-program",
      edition: "2026",
      week: 1,
      role,
      sources,
    },
  } as Partial<ProblemCatalogEntry>;
}
type ProblemCourseAlignmentSources = NonNullable<ProblemCatalogEntry["courseAlignment"]>["sources"];

describe("CourseTracksPage (#2786)", () => {
  beforeEach(() => {
    teamView.view = null;
    teamView.error = null;
    catalog.entries = [];
    navigate.mockReset();
  });

  it("should explain the empty state instead of rendering a blank page", () => {
    catalog.entries = [entry({ id: "legacy" })];
    render(<CourseTracksPage />);
    expect(screen.getByTestId("course-empty")).toBeInTheDocument();
  });

  it("should list a tracked problem under its chapter", () => {
    catalog.entries = [tracked("a", 10, "Week 1")];
    render(<CourseTracksPage />);
    expect(screen.getByText("Week 1")).toBeInTheDocument();
    expect(screen.getByTestId("course-problem-a")).toBeInTheDocument();
  });

  it("should surface a fetch error without hiding the track list", () => {
    catalog.entries = [tracked("a", 10, "Week 1")];
    teamView.error = "boom";
    render(<CourseTracksPage />);
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(screen.getByTestId("course-problem-a")).toBeInTheDocument();
  });

  it("should show the suggested next problem for a fresh team", () => {
    catalog.entries = [tracked("a", 10, "Week 1")];
    render(<CourseTracksPage />);
    expect(screen.getByTestId("course-recommended")).toHaveTextContent("recommended_next");
  });

  it("should switch to a completion notice once the track is solved", () => {
    catalog.entries = [tracked("a", 10, "Week 1")];
    teamView.view = {
      problems: [{ problemId: "a", jobId: "j", scoring: { flagSubmitted: true } }],
    };
    render(<CourseTracksPage />);
    expect(screen.getByTestId("course-complete")).toBeInTheDocument();
    expect(screen.queryByTestId("course-recommended")).not.toBeInTheDocument();
  });

  it("should navigate to the deployed job when a problem is opened", async () => {
    catalog.entries = [tracked("a", 10, "Week 1")];
    teamView.view = { problems: [{ problemId: "a", jobId: "job-1" }] };
    render(<CourseTracksPage />);
    await userEvent.click(screen.getByText("a"));
    expect(navigate).toHaveBeenCalledWith("/problems/job-1");
  });

  it("should send an undeployed problem to the problem list rather than a dead link", async () => {
    // catalog に載っていても deploy されていなければ jobId が無い。 404 へ送らない。
    catalog.entries = [tracked("a", 10, "Week 1")];
    render(<CourseTracksPage />);
    await userEvent.click(screen.getByText("a"));
    expect(navigate).toHaveBeenCalledWith("/problems");
  });

  it("should let the header action jump straight to the suggested problem", async () => {
    catalog.entries = [tracked("a", 10, "Week 1")];
    teamView.view = { problems: [{ problemId: "a", jobId: "job-1" }] };
    render(<CourseTracksPage />);
    await userEvent.click(screen.getByRole("button", { name: /start_recommended/ }));
    expect(navigate).toHaveBeenCalledWith("/problems/job-1");
  });

  it("should show checkpoint progress only for a problem that has checkpoints", () => {
    catalog.entries = [tracked("multi", 10, "Week 1"), tracked("single", 20, "Week 1")];
    teamView.view = {
      problems: [
        {
          problemId: "multi",
          jobId: "j1",
          scoring: { flags: [{ solved: true }, { solved: false }] },
        },
        { problemId: "single", jobId: "j2", scoring: { flagSubmitted: false } },
      ],
    };
    render(<CourseTracksPage />);
    const multi = screen.getByTestId("course-problem-multi");
    expect(multi).toHaveTextContent('checkpoints:{"solved":1,"total":2}');
    expect(screen.getByTestId("course-problem-single")).not.toHaveTextContent("checkpoints:");
  });

  it("should translate a known alignment role", () => {
    catalog.entries = [tracked("a", 10, "Week 1", alignment("mechanism"))];
    render(<CourseTracksPage />);
    expect(screen.getByTestId("course-problem-a")).toHaveTextContent("role_mechanism");
  });

  it("should print an unknown role verbatim rather than blanking the badge", () => {
    // 新しい role が catalog に入っても画面が壊れないこと。
    catalog.entries = [tracked("a", 10, "Week 1", alignment("brand-new-role"))];
    render(<CourseTracksPage />);
    expect(screen.getByTestId("course-problem-a")).toHaveTextContent("brand-new-role");
  });

  it("should link a pinned course source at its exact commit", () => {
    catalog.entries = [
      tracked(
        "a",
        10,
        "Week 1",
        alignment("mechanism", [
          {
            repository: "org/course",
            ref: "a".repeat(40),
            path: "week1/README.md",
            kind: "lecture",
          },
        ]),
      ),
    ];
    render(<CourseTracksPage />);
    expect(screen.getByRole("link", { name: /week1\/README\.md/ })).toHaveAttribute(
      "href",
      `https://github.com/org/course/blob/${"a".repeat(40)}/week1/README.md`,
    );
  });

  it("should show the track edition in the header when one is declared", () => {
    catalog.entries = [tracked("a", 10, "Week 1", alignment("mechanism"))];
    render(<CourseTracksPage />);
    expect(screen.getByText(/ac26 \(2026\)/)).toBeInTheDocument();
  });

  it("should render a track with no aligned problem without an edition suffix", () => {
    catalog.entries = [tracked("a", 10, "Week 1")];
    render(<CourseTracksPage />);
    expect(screen.getByText("ac26")).toBeInTheDocument();
  });

  it("should show a track-level checkpoint total across problems", () => {
    catalog.entries = [tracked("a", 10, "Week 1"), tracked("b", 20, "Week 1")];
    teamView.view = {
      problems: [
        { problemId: "a", jobId: "j1", scoring: { flags: [{ solved: true }, { solved: true }] } },
        { problemId: "b", jobId: "j2", scoring: { flags: [{ solved: false }] } },
      ],
    };
    render(<CourseTracksPage />);
    // ProgressBar は label を可視要素と aria 用の両方に出すので複数一致する。
    expect(screen.getAllByText(/track_checkpoint_label/).length).toBeGreaterThan(0);
    expect(screen.getByText('course_track.checkpoints:{"solved":2,"total":3}')).toBeInTheDocument();
  });

  it("should keep later chapters collapsed so the current position stays visible", async () => {
    catalog.entries = [tracked("a", 10, "Week 1"), tracked("b", 200, "Week 2")];
    render(<CourseTracksPage />);

    // 7 週分すべて開くと画面が長すぎて現在地を見失うので、最初の章だけ開く。
    const [week1, week2] = screen.getAllByRole("button", { name: /Week/ });
    expect(week1).toHaveAttribute("aria-expanded", "true");
    expect(week2).toHaveAttribute("aria-expanded", "false");

    // 畳んでいるだけで、開けば中身は出る (= 到達不能にはしていない)。
    await userEvent.click(week2 as HTMLElement);
    expect(week2).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("course-problem-b")).toBeInTheDocument();
  });
});
