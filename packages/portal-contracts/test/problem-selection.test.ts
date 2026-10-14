import { describe, expect, it } from "vitest";
import { selectableProblem } from "../src/problem-selection";

describe("new event problem selection", () => {
  it.each([
    "sha256-bytes-padding",
    "sha256-compress-digest",
    "sha256-schedule-logic",
    "ac26-crypto-battle",
    "ac26-w1-constraint-lab",
  ])("excludes the retired lesson %s even without modern tags", (id) => {
    expect(selectableProblem({ id })).toBe(false);
  });

  it.each(["cryptography", "advanced-cryptography", "advanced-cryptography-2026"])(
    "keeps the downloaded-catalog exclusion for %s",
    (tag) => {
      expect(selectableProblem({ id: "a-new-pack-lesson", tags: [tag] })).toBe(false);
    },
  );

  it("retains authentication and ordinary pack choices", () => {
    expect(selectableProblem({ id: "session-defense", tags: ["authentication"] })).toBe(true);
    expect(selectableProblem({ id: "forensic-casebook" })).toBe(true);
  });
});
