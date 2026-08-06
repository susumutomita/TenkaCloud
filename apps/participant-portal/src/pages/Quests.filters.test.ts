import { describe, expect, it } from "vitest";
import type { ParticipantProblemView } from "../api/portal-client";
import {
  filterQuestProblems,
  type QuestFilterState,
  type QuestSearchMetadata,
} from "./Quests.filters";

function problem(partial: Partial<ParticipantProblemView>): ParticipantProblemView {
  return {
    jobId: "job-x",
    problemId: "problem-x",
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

const ALL_FILTERS: QuestFilterState = {
  category: "all",
  query: "",
  difficulty: "all",
  answerStatus: "all",
};

describe("filterQuestProblems", () => {
  it("should search the participant-safe title, description, tags, and problem id", () => {
    const target = problem({ problemId: "crypto-lab" });
    const metadata = new Map<string, QuestSearchMetadata>([
      [
        "crypto-lab",
        {
          name: "Toy Verifier",
          shortDescription: "満たす性質と破れる性質を分類する",
          tags: ["Z3", "challenge"],
          difficulty: 3,
          i18n: { en: { name: "Satisfy and Break", shortDescription: "Classify properties" } },
        },
      ],
    ]);

    for (const query of ["verifier", "破れる", "z3", "CRYPTO-LAB", "classify properties"]) {
      expect(filterQuestProblems([target], { ...ALL_FILTERS, query }, metadata)).toEqual([target]);
    }
    expect(filterQuestProblems([target], { ...ALL_FILTERS, query: "network" }, metadata)).toEqual(
      [],
    );
  });

  it("should combine category and difficulty filters", () => {
    const beginner = problem({
      problemId: "beginner-challenge",
      scoring: { kind: "flag", flagSubmitted: false },
    });
    const advanced = problem({
      problemId: "advanced-challenge",
      scoring: { kind: "flag", flagSubmitted: false },
    });
    const battle = problem({ problemId: "advanced-battle", scoring: { kind: "uptime" } });
    const metadata = new Map<string, QuestSearchMetadata>([
      ["beginner-challenge", { difficulty: 1 }],
      ["advanced-challenge", { difficulty: 4 }],
      ["advanced-battle", { difficulty: 4 }],
    ]);

    expect(
      filterQuestProblems(
        [beginner, advanced, battle],
        { ...ALL_FILTERS, category: "challenge", difficulty: 4 },
        metadata,
      ),
    ).toEqual([advanced]);
  });

  it("should distinguish unsolved, in-progress, and cleared answer states", () => {
    const unsolved = problem({
      problemId: "unsolved",
      scoring: { kind: "flag", flagSubmitted: false },
    });
    const partial = problem({
      problemId: "partial",
      scoring: {
        kind: "multi-flag",
        flags: [
          { id: "a", label: "A", points: 10, solved: true },
          { id: "b", label: "B", points: 10, solved: false },
        ],
      },
    });
    const ongoing = problem({ problemId: "ongoing", scoring: { kind: "uptime" } });
    const cleared = problem({
      problemId: "cleared",
      scoring: { kind: "flag", flagSubmitted: true },
    });
    const multiCleared = problem({
      problemId: "multi-cleared",
      scoring: {
        kind: "multi-flag",
        flags: [{ id: "a", label: "A", points: 10, solved: true }],
      },
    });
    const untouchedMulti = problem({
      problemId: "untouched-multi",
      scoring: { kind: "multi-flag" },
    });
    const problems = [unsolved, partial, ongoing, cleared, multiCleared, untouchedMulti];
    const metadata = new Map<string, QuestSearchMetadata>();

    expect(
      filterQuestProblems(problems, { ...ALL_FILTERS, answerStatus: "unsolved" }, metadata),
    ).toEqual([unsolved, untouchedMulti]);
    expect(
      filterQuestProblems(problems, { ...ALL_FILTERS, answerStatus: "in-progress" }, metadata),
    ).toEqual([partial, ongoing]);
    expect(
      filterQuestProblems(problems, { ...ALL_FILTERS, answerStatus: "cleared" }, metadata),
    ).toEqual([cleared, multiCleared]);
  });

  it("should trim an empty query and exclude unknown metadata from a difficulty match", () => {
    const target = problem({ problemId: "unknown" });
    const metadata = new Map<string, QuestSearchMetadata>();

    expect(filterQuestProblems([target], { ...ALL_FILTERS, query: "   " }, metadata)).toEqual([
      target,
    ]);
    expect(filterQuestProblems([target], { ...ALL_FILTERS, query: "UNKNOWN" }, metadata)).toEqual([
      target,
    ]);
    expect(filterQuestProblems([target], { ...ALL_FILTERS, difficulty: 2 }, metadata)).toEqual([]);
  });
});
