import { describe, expect, it } from "vitest";
import { evaluatePatch, evaluatePatchVerdict } from "../src/evaluate-patch.js";
import type { FindingEvidence, PatchEvaluationInput } from "../src/types.js";

const CONFIRMED_FINDING: FindingEvidence = {
  runId: "run-1",
  findingId: "run-1-finding-1",
  targetDigest: "sha256:baseline",
  threatModelDigest: "sha256:threat-model",
  focusArea: "documents-idor",
  witnessType: "http-sequence",
  witnessDigest: "sha256:witness",
  reproduction: { attempts: 2, successes: 2, freshEnvironment: true },
  verifier: { id: "v1", version: "1.0.0", policyDigest: "sha256:policy" },
  verdict: "confirmed",
  generatedAt: "2026-01-01T00:00:00.000Z",
};

function baseInput(overrides: Partial<PatchEvaluationInput> = {}): PatchEvaluationInput {
  return {
    runId: "run-1",
    baselineTargetDigest: "sha256:baseline",
    patchDigest: "sha256:patch",
    baselineFinding: CONFIRMED_FINDING,
    build: "passed",
    goldenBehavior: "passed",
    originalWitnessReplay: "blocked",
    freshReattack: "no-witness-found",
    forbiddenSideEffects: [],
    digestsMatch: true,
    ...overrides,
  };
}

describe("evaluatePatchVerdict: verified-fixed requires every condition", () => {
  it("should certify a fix when build, golden behavior, original-witness-blocked, and no fresh witness all hold", () => {
    const { verdict, reasons } = evaluatePatchVerdict(baseInput());
    expect(verdict).toBe("verified-fixed");
    expect(reasons.length).toBeGreaterThan(0);
  });
});

describe("evaluatePatchVerdict: no false pass on binding or baseline", () => {
  it("should never certify a fix when digests do not bind to one artifact", () => {
    expect(evaluatePatchVerdict(baseInput({ digestsMatch: false })).verdict).toBe("inconclusive");
  });

  it("should never certify a fix against a baseline that was not independently confirmed", () => {
    expect(
      evaluatePatchVerdict(
        baseInput({ baselineFinding: { ...CONFIRMED_FINDING, verdict: "inconclusive" } }),
      ).verdict,
    ).toBe("inconclusive");
    expect(
      evaluatePatchVerdict(
        baseInput({ baselineFinding: { ...CONFIRMED_FINDING, verdict: "rejected" } }),
      ).verdict,
    ).toBe("inconclusive");
  });
});

describe("evaluatePatchVerdict: rejects the issue's named fake-fix patterns", () => {
  it("should mark an endpoint-killing patch as regressed, not verified-fixed, even though the exploit no longer lands", () => {
    // The endpoint is gone entirely: golden behavior fails, and the original witness also gets a
    // non-200 (blocked-looking) response — this proves golden-behavior is checked BEFORE the
    // witness replay, so a broken endpoint is never rewarded for "blocking" the exploit.
    const result = evaluatePatchVerdict(
      baseInput({ goldenBehavior: "failed", originalWitnessReplay: "blocked" }),
    );
    expect(result.verdict).toBe("regressed");
  });

  it("should mark an id-denylist-only patch as still-vulnerable when a fresh re-attack lands on a different id", () => {
    const result = evaluatePatchVerdict(
      baseInput({ originalWitnessReplay: "blocked", freshReattack: "witness-confirmed" }),
    );
    expect(result.verdict).toBe("still-vulnerable");
  });

  it("should mark the patch still-vulnerable when the original witness itself still lands", () => {
    expect(evaluatePatchVerdict(baseInput({ originalWitnessReplay: "landed" })).verdict).toBe(
      "still-vulnerable",
    );
  });
});

describe("evaluatePatchVerdict: no false pass on infrastructure/verification gaps", () => {
  it("should stay inconclusive, not pass, when the patch build failed", () => {
    expect(evaluatePatchVerdict(baseInput({ build: "failed" })).verdict).toBe("inconclusive");
  });

  it("should stay inconclusive when golden behavior could not be determined", () => {
    expect(evaluatePatchVerdict(baseInput({ goldenBehavior: "inconclusive" })).verdict).toBe(
      "inconclusive",
    );
  });

  it("should stay inconclusive when the original witness replay could not be determined", () => {
    expect(evaluatePatchVerdict(baseInput({ originalWitnessReplay: "inconclusive" })).verdict).toBe(
      "inconclusive",
    );
  });

  it("should stay inconclusive when the fresh re-attack could not run to completion", () => {
    expect(evaluatePatchVerdict(baseInput({ freshReattack: "inconclusive" })).verdict).toBe(
      "inconclusive",
    );
  });

  it("should stay inconclusive on any declared forbidden side effect, even if everything else looks clean", () => {
    expect(
      evaluatePatchVerdict(baseInput({ forbiddenSideEffects: ["escaped read-only mount"] }))
        .verdict,
    ).toBe("inconclusive");
  });
});

describe("evaluatePatch", () => {
  it("should return the full evaluation record with the computed verdict and reasons attached", () => {
    const input = baseInput();
    const evaluation = evaluatePatch(input);
    expect(evaluation).toMatchObject(input);
    expect(evaluation.verdict).toBe("verified-fixed");
    expect(evaluation.reasons.length).toBeGreaterThan(0);
  });
});
