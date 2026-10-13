import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import type { ParticipantProblemView } from "../api/portal-client";
import { catalogForProblemViews, findProblemMetadata, listProblemCatalog } from "../data/problems";
import {
  awsOnlyBadge,
  categoryBadge,
  difficultyBadge,
  questCardTitle,
  studyReportBadge,
} from "./Quests.badges";
import { filterQuestProblems, isQuestCleared } from "./Quests.filters";
import { renderSubmissionState } from "./Quests.submission-state";

const problem: ParticipantProblemView = {
  jobId: "job-study",
  problemId: "study-custom-sample",
  name: "Offline repair",
  runtimeKind: "submission",
  status: "COMPLETE",
  stackOutputs: {},
  expiresAt: 0,
  score: 0,
  deployLog: { cursor: "", entries: [] },
  submission: {
    edition: "v1",
    artifact: "{}",
    points: 100,
    solved: false,
    kind: "self-report",
    assurance: "self-reported",
    checks: ["normal-functionality", "security"],
  },
};
const t = (key: string) => key;
it("shows the server title for an organizer-provided edition and retains the old id fallback", () => {
  expect(questCardTitle(problem.problemId, "en", problem.name)).toBe("Offline repair");
  expect(questCardTitle(problem.problemId, "en")).toBe(problem.problemId);
  expect(questCardTitle(problem.problemId, "en", " ")).toBe(problem.problemId);
  expect(questCardTitle("sqli-demo", "en", "Pinned edition", "submission")).toBe("Pinned edition");
  expect(findProblemMetadata("sqli-demo", "submission")).toBeUndefined();
  expect(questCardTitle("sqli-demo", "en", "Pinned edition")).not.toBe("Pinned edition");
});
it("classifies both pre-start and released submission editions as Challenge and labels reports", () => {
  render(
    <>
      {categoryBadge(problem.problemId, undefined, "Unknown", problem.runtimeKind)}
      {studyReportBadge(problem, t)}
    </>,
  );
  expect(screen.getByText("Challenge")).toBeInTheDocument();
  expect(screen.getByText("study.self_report")).toBeInTheDocument();
  const filters = {
    category: "challenge" as const,
    query: "offline repair",
    difficulty: "all" as const,
    answerStatus: "unsolved" as const,
  };
  expect(filterQuestProblems([problem], filters, new Map())).toEqual([problem]);
  const pending = { ...problem, submission: undefined };
  expect(filterQuestProblems([pending], filters, new Map())).toEqual([pending]);
});
it("moves acknowledged reports into the completed group without implying verified execution", () => {
  const saved = problem.submission;
  if (!saved) throw new Error("Missing study fixture.");
  const accepted = { ...problem, submission: { ...saved, solved: true } };
  expect(isQuestCleared(problem)).toBe(false);
  expect(isQuestCleared(accepted)).toBe(true);
  expect(renderSubmissionState(problem, t)).toEqual({
    type: "pending",
    label: "quests.submission_unsolved",
  });
  expect(renderSubmissionState(accepted, t)).toEqual({
    type: "success",
    label: "study.accepted (study.self_report)",
  });
  expect(
    filterQuestProblems(
      [problem, accepted],
      { category: "all", query: "", difficulty: "all", answerStatus: "cleared" },
      new Map(),
    ),
  ).toEqual([accepted]);
});

it("does not attach an old course, draft, difficulty or AWS capability to a pinned submission ID", () => {
  const views = [{ ...problem, problemId: "sqli-demo" }];
  const base = listProblemCatalog();
  const filtered = catalogForProblemViews(base, views);
  expect(filtered.some((entry) => entry.id === "sqli-demo")).toBe(false);
  expect(
    catalogForProblemViews(base, [{ problemId: "sqli-demo", runtimeKind: "coordination" }]),
  ).toEqual(base);
  expect(difficultyBadge("sqli-demo", t, "submission")).toBeNull();
  expect(awsOnlyBadge("sqli-demo", t, "submission")).toBeNull();
  const stale = new Map([
    [
      "sqli-demo",
      {
        name: "Old name",
        tags: ["old-tag"],
        difficulty: 5 as const,
        status: "draft" as const,
        category: "Battle" as const,
      },
    ],
  ]);
  const filters = {
    category: "all" as const,
    query: "old-tag",
    difficulty: "all" as const,
    answerStatus: "all" as const,
  };
  expect(filterQuestProblems(views, filters, stale)).toEqual([]);
  expect(filterQuestProblems(views, { ...filters, query: "", difficulty: 5 }, stale)).toEqual([]);
  expect(
    filterQuestProblems(
      views,
      { ...filters, query: "Offline repair", category: "challenge" },
      stale,
    ),
  ).toEqual(views);
});
