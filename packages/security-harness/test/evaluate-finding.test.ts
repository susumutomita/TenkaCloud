import { describe, expect, it } from "vitest";
import { type EvaluateFindingInput, evaluateFindingVerdict } from "../src/evaluate-finding.js";

function baseInput(overrides: Partial<EvaluateFindingInput> = {}): EvaluateFindingInput {
  return {
    targetDigestMatches: true,
    threatModelDigestMatches: true,
    attempts: 3,
    successes: 3,
    minimumReproductions: 2,
    freshEnvironment: true,
    sandboxFailure: false,
    ...overrides,
  };
}

describe("evaluateFindingVerdict: confirms only real, reproducible, bound evidence", () => {
  it("should confirm when successes meet the minimum in a fresh environment with matching digests", () => {
    expect(evaluateFindingVerdict(baseInput())).toBe("confirmed");
  });

  it("should confirm exactly at the minimum, not only above it", () => {
    expect(
      evaluateFindingVerdict(baseInput({ attempts: 2, successes: 2, minimumReproductions: 2 })),
    ).toBe("confirmed");
  });
});

describe("evaluateFindingVerdict: exact artifact binding", () => {
  it("should reject when the target digest does not match, regardless of how many times it reproduced", () => {
    expect(evaluateFindingVerdict(baseInput({ targetDigestMatches: false }))).toBe("rejected");
  });

  it("should reject when the threat model digest does not match", () => {
    expect(evaluateFindingVerdict(baseInput({ threatModelDigestMatches: false }))).toBe("rejected");
  });
});

describe("evaluateFindingVerdict: no false pass on infrastructure failure", () => {
  it("should never confirm on a sandbox/verifier crash, even with reported successes", () => {
    expect(evaluateFindingVerdict(baseInput({ sandboxFailure: true }))).toBe("inconclusive");
  });

  it("should never confirm from a reused (non-fresh) environment", () => {
    expect(evaluateFindingVerdict(baseInput({ freshEnvironment: false }))).toBe("inconclusive");
  });

  it("should treat zero attempts as inconclusive, not confirmed and not rejected", () => {
    expect(evaluateFindingVerdict(baseInput({ attempts: 0, successes: 0 }))).toBe("inconclusive");
  });
});

describe("evaluateFindingVerdict: baseline first / flaky witnesses never confirm", () => {
  it("should reject when the verifier attempted reproduction and it never once succeeded", () => {
    expect(evaluateFindingVerdict(baseInput({ attempts: 3, successes: 0 }))).toBe("rejected");
  });

  it("should treat a below-threshold partial reproduction as inconclusive, never confirmed", () => {
    expect(
      evaluateFindingVerdict(baseInput({ attempts: 3, successes: 1, minimumReproductions: 2 })),
    ).toBe("inconclusive");
  });
});
