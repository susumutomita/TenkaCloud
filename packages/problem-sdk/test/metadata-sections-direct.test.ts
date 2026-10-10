/**
 * [Problem SDK / Issue #2106] Direct tests for the optional-section validation
 * exercised through the public `validateProblemMetadata`. Covers the
 * non-array and invalid-entry branches of each section.
 */

import { describe, expect, it } from "vitest";
import { validateProblemMetadata } from "../src/index.js";

function metadataCodes(metadata: Record<string, unknown>): string[] {
  return validateProblemMetadata(metadata).map((d) => d.code);
}

describe("validateProblemMetadata: optional section validation", () => {
  it("should flag a non-array endpoints / phases / disruptions section", () => {
    expect(metadataCodes({ id: "p", endpoints: "nope" })).toContain("PROBLEM_METADATA_INVALID");
    expect(metadataCodes({ id: "p", phases: 42 })).toContain("PROBLEM_METADATA_INVALID");
    expect(metadataCodes({ id: "p", disruptions: {} })).toContain("PROBLEM_METADATA_INVALID");
  });

  it("should flag an invalid entry inside endpoints / phases / disruptions", () => {
    expect(metadataCodes({ id: "p", endpoints: [{ slot: "" }] })).toContain(
      "PROBLEM_METADATA_INVALID",
    );
    expect(metadataCodes({ id: "p", phases: [{ name: "x" }] })).toContain(
      "PROBLEM_METADATA_INVALID",
    );
    expect(metadataCodes({ id: "p", disruptions: [{ id: "d" }] })).toContain(
      "PROBLEM_METADATA_INVALID",
    );
  });

  it("should flag a present-but-unparseable scoring section", () => {
    expect(metadataCodes({ id: "p", scoring: { kind: "bogus" } })).toContain(
      "PROBLEM_METADATA_INVALID",
    );
  });

  it("should accept valid optional sections with no diagnostics", () => {
    const metadata = {
      id: "p",
      endpoints: [{ slot: "web", default: { from: "cfn-output", key: "Url" } }],
      phases: [{ name: "ramp", afterMinutes: 5 }],
      disruptions: [{ id: "d", name: "D", eventDetailType: "T" }],
      scoring: { kind: "flag", flagOutputKey: "Flag", points: 100 },
    };
    expect(validateProblemMetadata(metadata)).toEqual([]);
  });
});

describe("public authoring credits", () => {
  it("accepts explicit credits and rejects malformed or unsafe data", () => {
    expect(
      validateProblemMetadata({
        id: "p",
        authors: [{ name: "作者", profileUrl: "https://example.com/" }, { name: "共同作者" }],
      }),
    ).toEqual([]);
    for (const authors of [
      null,
      [{}],
      [{ name: " " }],
      [{ name: "作者", profileUrl: ["javascript", "alert(1)"].join(":") }],
      [{ name: "作者", email: "private" }],
    ]) {
      expect(metadataCodes({ id: "p", authors })).toContain("PROBLEM_METADATA_INVALID");
    }
  });
});
