import { describe, expect, it } from "vitest";
import type { HttpSequenceWitness } from "../src/types.js";
import {
  type HttpClient,
  runHttpSequenceWitness,
  validateHttpSequenceWitness,
} from "../src/witness.js";

const VALID: HttpSequenceWitness = {
  type: "http-sequence",
  witnessId: "w-1",
  focusArea: "documents-idor",
  steps: [
    { method: "GET", path: "/documents/doc-b1", expectStatus: 200, expectBodyIncludes: "Bob" },
  ],
};

describe("validateHttpSequenceWitness", () => {
  it("should accept a well-formed witness", () => {
    const result = validateHttpSequenceWitness(VALID);
    expect(result.ok).toBe(true);
    expect(result.value).toEqual(VALID);
  });

  it("should reject a non-object", () => {
    expect(validateHttpSequenceWitness("not an object").ok).toBe(false);
    expect(validateHttpSequenceWitness(null).ok).toBe(false);
    expect(validateHttpSequenceWitness([VALID]).ok).toBe(false);
  });

  it("should reject an unknown top-level field instead of silently dropping it", () => {
    const result = validateHttpSequenceWitness({
      ...VALID,
      reasoning: "the model's own chain of thought",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("reasoning"))).toBe(true);
  });

  it("should reject the wrong witness type", () => {
    expect(validateHttpSequenceWitness({ ...VALID, type: "crash-input" }).ok).toBe(false);
  });

  it("should reject an empty step list", () => {
    expect(validateHttpSequenceWitness({ ...VALID, steps: [] }).ok).toBe(false);
  });

  it("should reject more steps than the bound allows", () => {
    const tooMany = Array.from({ length: 21 }, () => VALID.steps[0]);
    expect(validateHttpSequenceWitness({ ...VALID, steps: tooMany }).ok).toBe(false);
  });

  it("should reject a step with an unsupported method", () => {
    const bad = { ...VALID, steps: [{ ...VALID.steps[0], method: "TRACE" }] };
    expect(validateHttpSequenceWitness(bad).ok).toBe(false);
  });

  it("should reject a path that is not same-origin absolute", () => {
    for (const path of [
      "documents/doc-1",
      "https://evil.example/steal",
      "/documents/../../etc/passwd",
    ]) {
      const bad = { ...VALID, steps: [{ ...VALID.steps[0], path }] };
      expect(validateHttpSequenceWitness(bad).ok, path).toBe(false);
    }
  });

  it("should reject an oversized body", () => {
    const bad = {
      ...VALID,
      steps: [{ ...VALID.steps[0], method: "POST", body: "x".repeat(4097) }],
    };
    expect(validateHttpSequenceWitness(bad).ok).toBe(false);
  });

  it("should reject a non-integer or out-of-range expectStatus", () => {
    expect(
      validateHttpSequenceWitness({ ...VALID, steps: [{ ...VALID.steps[0], expectStatus: 200.5 }] })
        .ok,
    ).toBe(false);
    expect(
      validateHttpSequenceWitness({ ...VALID, steps: [{ ...VALID.steps[0], expectStatus: 999 }] })
        .ok,
    ).toBe(false);
  });

  it("should reject an unknown field inside a step", () => {
    const bad = { ...VALID, steps: [{ ...VALID.steps[0], severity: "critical" }] };
    const result = validateHttpSequenceWitness(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("severity"))).toBe(true);
  });
});

function fakeClient(responses: readonly { status: number; body: string }[]): HttpClient {
  let i = 0;
  return {
    request: async () => {
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return r;
    },
  };
}

describe("runHttpSequenceWitness", () => {
  it("should succeed when every step's response matches its expectation", async () => {
    const result = await runHttpSequenceWitness(
      VALID,
      fakeClient([{ status: 200, body: "Bob private note" }]),
    );
    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].passed).toBe(true);
  });

  it("should fail when the status does not match", async () => {
    const result = await runHttpSequenceWitness(
      VALID,
      fakeClient([{ status: 403, body: "forbidden" }]),
    );
    expect(result.success).toBe(false);
    expect(result.steps[0].passed).toBe(false);
  });

  it("should fail when expectBodyIncludes does not match even if status matches", async () => {
    const result = await runHttpSequenceWitness(
      VALID,
      fakeClient([{ status: 200, body: "someone else" }]),
    );
    expect(result.success).toBe(false);
  });

  it("should fail the whole run if any one step in a multi-step sequence fails", async () => {
    const witness: HttpSequenceWitness = {
      ...VALID,
      steps: [
        { method: "POST", path: "/documents", expectStatus: 201 },
        {
          method: "GET",
          path: "/documents/mine",
          expectStatus: 200,
          expectBodyIncludes: "golden note",
        },
      ],
    };
    const result = await runHttpSequenceWitness(
      witness,
      fakeClient([
        { status: 201, body: "" },
        { status: 200, body: "no such note" },
      ]),
    );
    expect(result.success).toBe(false);
    expect(result.steps[0].passed).toBe(true);
    expect(result.steps[1].passed).toBe(false);
  });

  it("should fail when expectBodyExcludes is present in the response", async () => {
    const witness: HttpSequenceWitness = {
      ...VALID,
      steps: [
        { method: "GET", path: "/documents/doc-a1", expectStatus: 200, expectBodyExcludes: "Bob" },
      ],
    };
    const result = await runHttpSequenceWitness(
      witness,
      fakeClient([{ status: 200, body: "Bob leaked here" }]),
    );
    expect(result.success).toBe(false);
  });
});
