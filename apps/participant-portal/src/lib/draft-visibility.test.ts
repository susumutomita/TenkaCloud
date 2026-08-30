import type { ProblemCatalogEntry } from "@tenkacloud/portal-contracts";
import { describe, expect, it } from "vitest";
import type { ParticipantProblemView } from "../api/portal-client";
import {
  hideDraftCatalogEntries,
  hideDraftQuestProblems,
  hidesDraftProblems,
  isDraftHideExempt,
  readShowDraftProblems,
  visibleCatalogEntries,
  visibleCourseCatalog,
  visibleQuestProblems,
  writeShowDraftProblems,
} from "./draft-visibility";

function problem(partial: Partial<ParticipantProblemView>): ParticipantProblemView {
  return {
    jobId: "job-x",
    problemId: "problem-x",
    region: "local",
    awsAccountId: "local",
    status: "COMPLETE",
    stackOutputs: {},
    expiresAt: 0,
    score: 0,
    deployLog: { cursor: "", entries: [] },
    ...partial,
  };
}

function entry(
  partial: Partial<ProblemCatalogEntry> & Pick<ProblemCatalogEntry, "id" | "status">,
): ProblemCatalogEntry {
  return {
    name: partial.id,
    category: "Challenge",
    visibility: "public",
    difficulty: 1,
    estimatedDuration: "30m",
    shortDescription: "",
    learningGoals: [],
    tags: [],
    endpoints: [],
    phases: [],
    disruptions: [],
    runtime: { provider: "docker", engine: "compose" },
    ...partial,
  };
}

describe("readShowDraftProblems / writeShowDraftProblems", () => {
  it("should default to hidden when nothing is stored", () => {
    expect(readShowDraftProblems({ getItem: () => null })).toBe(false);
  });

  it("should round-trip the stored preference", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    writeShowDraftProblems(true, storage);
    expect(readShowDraftProblems(storage)).toBe(true);
    writeShowDraftProblems(false, storage);
    expect(readShowDraftProblems(storage)).toBe(false);
  });

  it("should fail closed to hidden when storage throws (private window)", () => {
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readShowDraftProblems(throwing)).toBe(false);
    // 保存失敗は握りつぶす (throw しないこと自体が仕様)。
    expect(() => writeShowDraftProblems(true, throwing)).not.toThrow();
  });

  it("should read and write the real localStorage by default", () => {
    // jsdom 環境の実 localStorage を使う default 引数の経路。
    writeShowDraftProblems(true);
    expect(readShowDraftProblems()).toBe(true);
    writeShowDraftProblems(false);
    expect(readShowDraftProblems()).toBe(false);
  });
});

describe("isDraftHideExempt", () => {
  it("should exempt the pinned intro drill (recommended: true)", () => {
    expect(isDraftHideExempt(problem({ recommended: true }))).toBe(true);
  });

  it("should exempt a container that is not stopped, including error state", () => {
    for (const status of ["starting", "running", "error"] as const) {
      expect(isDraftHideExempt(problem({ lifecycle: { status, runtimeKind: "docker" } }))).toBe(
        true,
      );
    }
    expect(
      isDraftHideExempt(problem({ lifecycle: { status: "stopped", runtimeKind: "docker" } })),
    ).toBe(false);
  });

  it("should exempt any scoring progress", () => {
    expect(isDraftHideExempt(problem({ scoring: { kind: "flag", flagSubmitted: true } }))).toBe(
      true,
    );
    expect(isDraftHideExempt(problem({ scoring: { kind: "flag", flagSubmitted: false } }))).toBe(
      false,
    );
    expect(
      isDraftHideExempt(
        problem({
          scoring: {
            kind: "multi-flag",
            flags: [
              { id: "a", label: "a", solved: true, points: 10 },
              { id: "b", label: "b", solved: false, points: 10 },
            ],
          },
        }),
      ),
    ).toBe(true);
    expect(
      isDraftHideExempt(
        problem({
          scoring: {
            kind: "multi-flag",
            flags: [{ id: "a", label: "a", solved: false, points: 10 }],
          },
        }),
      ),
    ).toBe(false);
  });

  it("should not exempt a bare untouched problem", () => {
    expect(isDraftHideExempt(problem({}))).toBe(false);
  });
});

describe("hideDraftQuestProblems", () => {
  const statusOf = (map: Record<string, ProblemCatalogEntry["status"]>) => (problemId: string) =>
    map[problemId];

  it("should hide an untouched draft and keep ready / deprecated problems", () => {
    const draft = problem({ problemId: "draft-1" });
    const ready = problem({ problemId: "ready-1" });
    const deprecated = problem({ problemId: "old-1" });
    expect(
      hideDraftQuestProblems(
        [draft, ready, deprecated],
        statusOf({ "draft-1": "draft", "ready-1": "ready", "old-1": "deprecated" }),
      ),
    ).toEqual([ready, deprecated]);
  });

  it("should keep a draft the participant is amid (exempt)", () => {
    const started = problem({
      problemId: "draft-1",
      lifecycle: { status: "running", runtimeKind: "docker" },
    });
    expect(hideDraftQuestProblems([started], statusOf({ "draft-1": "draft" }))).toEqual([started]);
  });

  it("should keep a problem the catalog does not know (fail-open, #2882)", () => {
    const stale = problem({ problemId: "not-in-catalog" });
    expect(hideDraftQuestProblems([stale], statusOf({}))).toEqual([stale]);
  });
});

describe("hideDraftCatalogEntries", () => {
  it("should drop draft entries and keep the rest", () => {
    const draft = entry({ id: "draft-1", status: "draft" });
    const ready = entry({ id: "ready-1", status: "ready" });
    expect(hideDraftCatalogEntries([draft, ready], [])).toEqual([ready]);
  });

  it("should keep a draft entry whose problem view is exempt", () => {
    const draft = entry({ id: "draft-1", status: "draft" });
    const inProgress = problem({
      problemId: "draft-1",
      scoring: { kind: "flag", flagSubmitted: true },
    });
    expect(hideDraftCatalogEntries([draft], [inProgress])).toEqual([draft]);
  });

  it("should not let an exempt view keep a different draft entry", () => {
    const draft = entry({ id: "draft-1", status: "draft" });
    const otherExempt = problem({ problemId: "other", recommended: true });
    expect(hideDraftCatalogEntries([draft], [otherExempt])).toEqual([]);
  });
});

describe("hidesDraftProblems", () => {
  it("should hide drafts only in local play, where the list is the whole catalog", () => {
    expect(hidesDraftProblems("local")).toBe(true);
    expect(hidesDraftProblems("real")).toBe(false);
    expect(hidesDraftProblems("mock")).toBe(false);
  });
});

describe("visibleQuestProblems / visibleCatalogEntries (toggle 状態つき)", () => {
  const draftProblem = problem({ problemId: "draft-1" });
  const draftEntry = entry({ id: "draft-1", status: "draft" });
  const statusOf = (problemId: string) =>
    problemId === "draft-1" ? ("draft" as const) : undefined;

  it("should pass everything through while drafts are shown", () => {
    expect(visibleQuestProblems([draftProblem], statusOf, true, "local")).toEqual([draftProblem]);
    expect(visibleCatalogEntries([draftEntry], [], true)).toEqual([draftEntry]);
  });

  it("should hide drafts while they are not shown", () => {
    expect(visibleQuestProblems([draftProblem], statusOf, false, "local")).toEqual([]);
    expect(visibleCatalogEntries([draftEntry], [], false)).toEqual([]);
  });

  it("should keep an operator-deployed draft in cloud modes even with the toggle off", () => {
    // real / mock の一覧は運営が deploy した分だけ。catalog が draft でも、目の前で動いている
    // 問題を既定で消してはいけない (toggle は local 専用の開発者向け導線)。
    for (const cloudMode of ["real", "mock"] as const) {
      expect(visibleQuestProblems([draftProblem], statusOf, false, cloudMode)).toEqual([
        draftProblem,
      ]);
    }
  });
});

describe("visibleCourseCatalog (保存された好みを読む画面向け)", () => {
  const draftEntry = entry({ id: "draft-1", status: "draft" });

  it("should follow the stored preference for both directions", () => {
    expect(visibleCourseCatalog([draftEntry], [], { getItem: () => "true" })).toEqual([draftEntry]);
    expect(visibleCourseCatalog([draftEntry], [], { getItem: () => null })).toEqual([]);
  });
});
