import { describe, expect, it } from "vitest";
import { advisorCatalog } from "../../../src/pages/event-create/problem-advisor";
import {
  normalizeVector,
  rankSemantic,
  semanticDocument,
} from "../../../src/pages/event-create/semantic-search";

describe("semantic search boundaries", () => {
  const unit = (index: number) => Array.from({ length: 768 }, (_, i) => (i === index ? 1 : 0));
  it("rejects invalid inference vectors rather than returning plausible scores", () => {
    expect(() => normalizeVector([1, 2])).toThrow();
    expect(() => normalizeVector(new Array(768).fill(0))).toThrow();
    expect(() => normalizeVector(new Array(768).fill(Number.NaN))).toThrow();
  });
  it("ranks measured vectors only within the current supported scope", () => {
    const ranked = rankSemantic(
      unit(0),
      [
        { id: "outside", vector: unit(0) },
        { id: "second", vector: unit(1) },
        { id: "first", vector: unit(0) },
      ],
      new Set(["first", "second"]),
    );
    expect(ranked.map((r) => r.id)).toEqual(["first", "second"]);
    expect(ranked.map((r) => r.score)).toEqual([1, 0]);
  });
  it("indexes an explicit public projection without hidden material", () => {
    const p = {
      id: "one",
      name: "観察",
      shortDescription: "公開概要",
      difficulty: 1,
      tags: ["log"],
      estimatedDuration: "10分",
      runtime: { provider: "docker", engine: "compose" },
      category: "Challenge",
      status: "ready",
    } as const;
    const c = {
      supported: new Set(["one"]),
      cloud: new Set<string>(),
      loading: false,
      error: null,
      limits: { maxTeams: 1, maxEventJobs: 1 },
      content: new Map([
        [
          "one",
          {
            description: "SECRET_OPERATOR",
            learningGoals: ["証拠を調べる"],
            instructions: "SECRET_ANSWER",
          },
        ],
      ]),
    };
    const documents = advisorCatalog([{ ...p, tags: [...p.tags] }], c, "ja").map(semanticDocument);
    expect(documents[0]).toContain("title: 観察 | text: 公開概要");
    expect(documents[0]).toContain("証拠を調べる");
    expect(documents[0]).not.toContain("SECRET");
  });
});
