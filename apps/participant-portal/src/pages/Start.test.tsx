import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { ParticipantTeamView } from "../api/portal-client";
import { StartPage } from "./Start";

/**
 * #2707 P0-5: LP hero 「始める」→ `/start` は「表示順で最初の未得点問題」へ直行する。
 * 表示順はオンボーディング 3 部作を先頭に pin してある (dev-mock-fixtures.test.ts) ので、
 * fresh visitor は問題 1 (TenkaCloud を理解する) に 1 クリックで到達する。
 */

vi.mock("../i18n", () => ({
  useT: () => (key: string) => key,
}));

const teamView: { view: ParticipantTeamView | null; error: string | null } = {
  view: null,
  error: null,
};

vi.mock("../auth/TeamViewProvider", () => ({
  useTeamView: () => teamView,
}));

function DetailStub() {
  const { jobId } = useParams<{ jobId: string }>();
  return <div>detail:{jobId}</div>;
}

function renderStart() {
  return render(
    <MemoryRouter initialEntries={["/start"]}>
      <Routes>
        <Route path="/start" element={<StartPage />} />
        <Route path="/problems" element={<div>quests-list</div>} />
        <Route path="/problems/:jobId" element={<DetailStub />} />
      </Routes>
    </MemoryRouter>,
  );
}

function viewWith(problems: Array<{ jobId: string; score: number }>): ParticipantTeamView {
  return { problems } as unknown as ParticipantTeamView;
}

describe("StartPage (#2707)", () => {
  it("should show a loading state until the team view arrives", () => {
    teamView.view = null;
    teamView.error = null;
    renderStart();
    expect(screen.getByText("app.loading")).toBeDefined();
  });

  it("should land on the first unsolved problem in view order", () => {
    teamView.view = viewWith([
      { jobId: "j-solved", score: 200 },
      { jobId: "j-first-unsolved", score: 0 },
      { jobId: "j-later", score: 0 },
    ]);
    teamView.error = null;
    renderStart();
    expect(screen.getByText("detail:j-first-unsolved")).toBeDefined();
  });

  it("should fall back to the first problem when everything is already solved", () => {
    teamView.view = viewWith([
      { jobId: "j-a", score: 100 },
      { jobId: "j-b", score: 50 },
    ]);
    teamView.error = null;
    renderStart();
    expect(screen.getByText("detail:j-a")).toBeDefined();
  });

  it("should fall back to the quests list when the view has no problems", () => {
    teamView.view = viewWith([]);
    teamView.error = null;
    renderStart();
    expect(screen.getByText("quests-list")).toBeDefined();
  });

  it("should fall back to the quests list when the team view failed to load", () => {
    teamView.view = null;
    teamView.error = "boom";
    renderStart();
    expect(screen.getByText("quests-list")).toBeDefined();
  });
});
