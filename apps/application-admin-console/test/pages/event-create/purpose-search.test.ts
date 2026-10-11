import { describe, expect, it } from "vitest";
import { rankPurpose } from "../../../src/pages/event-create/purpose-search";

import type { SemanticCandidate } from "../../../src/pages/event-create/semantic-search";

const candidates: SemanticCandidate[] = [
  {
    id: "sql",
    name: "SQL injection",
    summary: "データベースの脆弱性を調査",
    goals: ["入力を検証する"],
    tags: ["sql"],
    difficulty: 1,
    duration: "10分",
    runtime: ["docker"],
  },
  {
    id: "crypto",
    name: "Cryptography Battle",
    summary: "暗号の仕組み",
    goals: ["鍵を解析する"],
    tags: ["cryptography"],
    difficulty: 2,
    duration: "20分",
    runtime: ["native"],
  },
  {
    id: "iam",
    name: "IAM permissions",
    summary: "Policy evaluation",
    goals: ["最小権限を設計する"],
    tags: ["iam"],
    difficulty: 2,
    duration: "20分",
    runtime: ["aws"],
  },
];
describe("purpose search in public catalog fields", () => {
  it.each([
    ["暗号を学びたい", "crypto"],
    ["データベースについて練習したい", "sql"],
    ["I want to practice ＳＱＬ", "sql"],
    ["権限について学びたい", "iam"],
  ])("matches %s to an existing candidate", (query, id) => {
    expect(rankPurpose(query, candidates)[0]?.id).toBe(id);
  });
  it("does not invent matches for empty, generic or unrelated requests", () => {
    for (const query of ["", "練習したい", "astronomy"])
      expect(rankPurpose(query, candidates)).toEqual([]);
  });
  it("cannot return an excluded candidate", () => {
    expect(
      rankPurpose(
        "暗号",
        candidates.filter((p) => p.id !== "crypto"),
      ),
    ).toEqual([]);
  });
});
