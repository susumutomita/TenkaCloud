import { describe, expect, it } from "vitest";
import { extractFinderHandoff } from "../src/finder-output.js";
import type { HttpSequenceWitness } from "../src/types.js";

const VALID_WITNESS: HttpSequenceWitness = {
  type: "http-sequence",
  witnessId: "w-1",
  focusArea: "documents-idor",
  steps: [
    { method: "GET", path: "/documents/doc-b1", expectStatus: 200, expectBodyIncludes: "Bob" },
  ],
};

function claim(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ witness: VALID_WITNESS, ...extra });
}

describe("extractFinderHandoff: PoC-only handoff (Issue #3036)", () => {
  it("should accept a clean claim with only a witness", () => {
    const result = extractFinderHandoff({
      focusArea: "documents-idor",
      finderIndex: 0,
      rawOutputText: claim(),
    });
    expect(result.ok).toBe(true);
    expect(result.handoff?.witness).toEqual(VALID_WITNESS);
    expect(result.handoff?.focusArea).toBe("documents-idor");
    expect(result.handoff?.finderIndex).toBe(0);
    expect(result.handoff?.targetMetadata).toEqual({});
  });

  it("should accept minimal target metadata alongside the witness", () => {
    const result = extractFinderHandoff({
      focusArea: "documents-idor",
      finderIndex: 0,
      rawOutputText: claim({
        targetMetadata: { targetId: "doc-b1", endpointHint: "/documents/:id" },
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.handoff?.targetMetadata).toEqual({
      targetId: "doc-b1",
      endpointHint: "/documents/:id",
    });
  });

  it("should structurally return a handoff with exactly the four allowed keys, nothing else", () => {
    const result = extractFinderHandoff({
      focusArea: "documents-idor",
      finderIndex: 0,
      rawOutputText: claim(),
    });
    expect(result.ok).toBe(true);
    expect(Object.keys(result.handoff ?? {}).sort()).toEqual(
      ["finderIndex", "focusArea", "targetMetadata", "witness"].sort(),
    );
  });

  // --- The critical invariant: Finder reasoning/self-assessment/severity/conclusion never reach
  // the handoff. Each of these is tested independently so a regression in any one path is caught.

  it("should reject the whole claim (not just the extra field) when reasoning is present, even alongside an otherwise-valid witness", () => {
    const result = extractFinderHandoff({
      focusArea: "documents-idor",
      finderIndex: 0,
      rawOutputText: claim({ reasoning: "I noticed the id was not checked against the token" }),
    });
    expect(result.ok).toBe(false);
    expect(result.handoff).toBeUndefined();
    expect(result.errors.some((e) => e.includes("reasoning"))).toBe(true);
  });

  it("should reject a claim carrying a self-assessed severity", () => {
    const result = extractFinderHandoff({
      focusArea: "documents-idor",
      finderIndex: 0,
      rawOutputText: claim({ selfAssessedSeverity: "critical" }),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("selfAssessedSeverity"))).toBe(true);
  });

  it("should reject a claim carrying a conclusion", () => {
    const result = extractFinderHandoff({
      focusArea: "documents-idor",
      finderIndex: 0,
      rawOutputText: claim({ conclusion: "this is definitely exploitable" }),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("conclusion"))).toBe(true);
  });

  it("should reject a claim carrying a confidence score", () => {
    const result = extractFinderHandoff({
      focusArea: "documents-idor",
      finderIndex: 0,
      rawOutputText: claim({ confidence: 0.97 }),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("confidence"))).toBe(true);
  });

  it("should reject reasoning smuggled inside targetMetadata rather than at the top level", () => {
    const result = extractFinderHandoff({
      focusArea: "documents-idor",
      finderIndex: 0,
      rawOutputText: claim({ targetMetadata: { targetId: "doc-b1", reasoning: "sneaky" } }),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("targetMetadata") && e.includes("reasoning"))).toBe(
      true,
    );
  });

  it("should never let the resulting handoff's serialized form contain forbidden markers, even when the raw claim tried to include them", () => {
    const withEverything = claim({
      reasoning: "chain of thought",
      selfAssessedSeverity: "critical",
      conclusion: "confirmed exploit",
      confidence: 1,
    });
    const result = extractFinderHandoff({
      focusArea: "documents-idor",
      finderIndex: 0,
      rawOutputText: withEverything,
    });
    // The claim is rejected wholesale (asserted above in other cases); here we additionally prove
    // there is no handoff object at all to leak from.
    expect(result.ok).toBe(false);
    expect(result.handoff).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/chain of thought|confirmed exploit/);
  });

  // --- Other schema-boundary behavior, matching the rest of this package's validators.

  it("should reject invalid JSON", () => {
    const result = extractFinderHandoff({
      focusArea: "documents-idor",
      finderIndex: 0,
      rawOutputText: "not json at all {{{",
    });
    expect(result.ok).toBe(false);
  });

  it("should reject a JSON array or primitive at the top level", () => {
    expect(
      extractFinderHandoff({
        focusArea: "documents-idor",
        finderIndex: 0,
        rawOutputText: "[1,2,3]",
      }).ok,
    ).toBe(false);
    expect(
      extractFinderHandoff({
        focusArea: "documents-idor",
        finderIndex: 0,
        rawOutputText: '"just a string"',
      }).ok,
    ).toBe(false);
  });

  it("should reject a malformed witness (delegating to the same validateHttpSequenceWitness the rest of the package uses)", () => {
    const result = extractFinderHandoff({
      focusArea: "documents-idor",
      finderIndex: 0,
      rawOutputText: JSON.stringify({ witness: { ...VALID_WITNESS, steps: [] } }),
    });
    expect(result.ok).toBe(false);
  });

  it("should reject a witness whose declared focusArea does not match the finder's assigned focus area", () => {
    const result = extractFinderHandoff({
      focusArea: "different-focus-area",
      finderIndex: 0,
      rawOutputText: claim(),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("does not match"))).toBe(true);
  });

  it("should reject an unknown field inside targetMetadata instead of silently dropping it", () => {
    const result = extractFinderHandoff({
      focusArea: "documents-idor",
      finderIndex: 0,
      rawOutputText: claim({ targetMetadata: { targetId: "doc-b1", extra: "nope" } }),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("extra"))).toBe(true);
  });
});
