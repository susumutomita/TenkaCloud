import { describe, expect, it } from "vitest";
import { canonicalJsonStringify, computeDeterministicSignature, dedupeFindings } from "../src/dedupe.js";
import type { FinderHandoff } from "../src/finder-output.js";
import type { HttpSequenceWitness } from "../src/types.js";

function witness(overrides: Partial<HttpSequenceWitness> = {}): HttpSequenceWitness {
  return {
    type: "http-sequence",
    witnessId: "w-default",
    focusArea: "documents-idor",
    steps: [
      { method: "GET", path: "/documents/doc-b1", expectStatus: 200, expectBodyIncludes: "Bob" },
    ],
    ...overrides,
  };
}

function handoff(overrides: Partial<FinderHandoff> = {}): FinderHandoff {
  return {
    focusArea: "documents-idor",
    finderIndex: 0,
    witness: witness(),
    targetMetadata: {},
    ...overrides,
  };
}

describe("canonicalJsonStringify", () => {
  it("should produce identical output regardless of object key order", () => {
    const a = canonicalJsonStringify({ b: 1, a: 2 });
    const b = canonicalJsonStringify({ a: 2, b: 1 });
    expect(a).toBe(b);
  });

  it("should recurse into nested objects and arrays", () => {
    const a = canonicalJsonStringify({ outer: { z: 1, a: { y: 2, x: 3 } }, list: [{ b: 1, a: 2 }] });
    const b = canonicalJsonStringify({ list: [{ a: 2, b: 1 }], outer: { a: { x: 3, y: 2 }, z: 1 } });
    expect(a).toBe(b);
  });

  it("should drop undefined-valued keys so their presence/absence does not change the signature", () => {
    const withUndefined = canonicalJsonStringify({ a: 1, b: undefined });
    const without = canonicalJsonStringify({ a: 1 });
    expect(withUndefined).toBe(without);
  });
});

describe("computeDeterministicSignature", () => {
  it("should be identical for two handoffs with the same focus area and steps but different witnessId (a Finder-chosen label, not evidence)", () => {
    const a = handoff({ witness: witness({ witnessId: "finder-a-picked-this-name" }) });
    const b = handoff({ witness: witness({ witnessId: "finder-b-picked-a-different-name" }) });
    expect(computeDeterministicSignature(a)).toBe(computeDeterministicSignature(b));
  });

  it("should be identical regardless of which finderIndex produced the handoff", () => {
    const a = handoff({ finderIndex: 0 });
    const b = handoff({ finderIndex: 7 });
    expect(computeDeterministicSignature(a)).toBe(computeDeterministicSignature(b));
  });

  it("should be identical regardless of header property declaration order within a step", () => {
    const a = handoff({
      witness: witness({
        steps: [
          {
            method: "GET",
            path: "/documents/doc-b1",
            headers: { authorization: "token-a", "x-trace": "1" },
            expectStatus: 200,
          },
        ],
      }),
    });
    const b = handoff({
      witness: witness({
        steps: [
          {
            method: "GET",
            path: "/documents/doc-b1",
            headers: { "x-trace": "1", authorization: "token-a" },
            expectStatus: 200,
          },
        ],
      }),
    });
    expect(computeDeterministicSignature(a)).toBe(computeDeterministicSignature(b));
  });

  it("should differ when the focus area differs", () => {
    const a = handoff({ focusArea: "documents-idor" });
    const b = handoff({ focusArea: "auth-bypass" });
    expect(computeDeterministicSignature(a)).not.toBe(computeDeterministicSignature(b));
  });

  it("should differ when the request path differs", () => {
    const a = handoff();
    const b = handoff({
      witness: witness({
        steps: [{ method: "GET", path: "/documents/doc-b2", expectStatus: 200 }],
      }),
    });
    expect(computeDeterministicSignature(a)).not.toBe(computeDeterministicSignature(b));
  });

  it("should differ when the number of steps differs", () => {
    const a = handoff();
    const b = handoff({
      witness: witness({
        steps: [
          ...witness().steps,
          { method: "GET", path: "/documents/doc-b2", expectStatus: 200 },
        ],
      }),
    });
    expect(computeDeterministicSignature(a)).not.toBe(computeDeterministicSignature(b));
  });

  it("should be a stable sha256: digest reference, not a random id", () => {
    const signature = computeDeterministicSignature(handoff());
    expect(signature).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(computeDeterministicSignature(handoff())).toBe(signature);
  });
});

describe("dedupeFindings", () => {
  it("should collapse two independent findings that converged on the same witness content into one group", () => {
    const a = handoff({ finderIndex: 0, witness: witness({ witnessId: "a" }) });
    const b = handoff({ finderIndex: 3, witness: witness({ witnessId: "b" }) });
    const manifest = dedupeFindings([a, b]);
    expect(manifest.totalInput).toBe(2);
    expect(manifest.totalUnique).toBe(1);
    expect(manifest.groups).toHaveLength(1);
    expect(manifest.groups[0]?.kept).toEqual(a);
    expect(manifest.groups[0]?.duplicates).toEqual([b]);
  });

  it("should keep two findings in separate groups when their focus areas differ", () => {
    const a = handoff({ focusArea: "documents-idor" });
    const b = handoff({ focusArea: "auth-bypass" });
    const manifest = dedupeFindings([a, b]);
    expect(manifest.totalUnique).toBe(2);
  });

  it("should always keep the first-seen handoff for a signature, deterministically", () => {
    const first = handoff({ finderIndex: 1, witness: witness({ witnessId: "first-seen" }) });
    const second = handoff({ finderIndex: 0, witness: witness({ witnessId: "second-seen" }) });
    const manifest = dedupeFindings([first, second]);
    expect(manifest.groups[0]?.kept.witness.witnessId).toBe("first-seen");
  });

  it("should handle an empty input without error", () => {
    const manifest = dedupeFindings([]);
    expect(manifest).toEqual({ groups: [], totalInput: 0, totalUnique: 0 });
  });

  it("should preserve group order by first-occurrence order of each distinct signature", () => {
    const idor = handoff({ focusArea: "idor" });
    const auth = handoff({ focusArea: "auth" });
    const manifest = dedupeFindings([auth, idor, auth]);
    expect(manifest.groups.map((g) => g.kept.focusArea)).toEqual(["auth", "idor"]);
    expect(manifest.groups[0]?.duplicates).toHaveLength(1);
  });
});
