import { expect, test } from "bun:test";
import {
  judgeSubmission,
  parseSubmissionCatalog,
  publicSubmission,
  SubmissionInputError,
} from "./submission-grader";

function definition(judge: unknown) {
  const [entry] = parseSubmissionCatalog(
    JSON.stringify([
      {
        problemId: "study-example",
        version: "v1",
        name: "Example",
        instructions: "Solve locally",
        artifact: '{"question":"6 * 7"}',
        points: 100,
        judge,
      },
    ]),
  );
  if (!entry) throw new Error("Missing fixture definition");
  return entry.definition;
}

test("shared grader uses a pinned answer and excludes private grading data from its projection", () => {
  const saved = definition({ kind: "answer", answer: "42" });
  const changed = definition({ kind: "answer", answer: "43" });
  // Public editions must not become an offline answer oracle.
  expect(saved.edition).toBe(changed.edition);
  expect(saved.judge).not.toEqual(changed.judge);
  expect(judgeSubmission(saved, JSON.stringify({ edition: saved.edition, answer: "42" }))).toBe(
    true,
  );
  expect(judgeSubmission(changed, JSON.stringify({ edition: saved.edition, answer: "42" }))).toBe(
    false,
  );
  expect(publicSubmission(saved, false)).toEqual({
    edition: saved.edition,
    artifact: saved.artifact,
    points: 100,
    solved: false,
    kind: "answer",
    assurance: "server-checked-answer",
  });
  expect(JSON.stringify(publicSubmission(saved, true))).not.toContain("digest");
});

test("shared self-report grader rejects blanket denial and retains the low assurance label", () => {
  const saved = definition({ kind: "self-report", checks: ["normal-functionality", "security"] });
  const submit = (normal: boolean) =>
    JSON.stringify({
      edition: saved.edition,
      checks: { "normal-functionality": normal, security: true },
    });
  expect(judgeSubmission(saved, submit(false))).toBe(false);
  expect(judgeSubmission(saved, submit(true))).toBe(true);
  expect(publicSubmission(saved, true).assurance).toBe("self-reported");
  expect(() =>
    judgeSubmission(saved, JSON.stringify({ edition: saved.edition, checks: {} })),
  ).toThrow(SubmissionInputError);
});

test("shared grader rejects invalid envelopes and edition drift before evaluating submissions", () => {
  const saved = definition({ kind: "answer", answer: "42" });
  const malformed = new SubmissionInputError(400, "Expected a versioned submission envelope.");
  expect(malformed.code).toBe("request_failed");
  for (const payload of [
    "not-json",
    "[]",
    "null",
    JSON.stringify({ edition: saved.edition, answer: 42 }),
    JSON.stringify({ edition: saved.edition, answer: "x".repeat(4097) }),
    JSON.stringify({ edition: saved.edition, answer: "42", url: "https://example.invalid" }),
    JSON.stringify({ edition: saved.edition, answer: "42", code: "return true" }),
    JSON.stringify({ edition: saved.edition, answer: "42", points: 10000 }),
  ])
    expect(() => judgeSubmission(saved, payload)).toThrow(SubmissionInputError);
  try {
    judgeSubmission(saved, JSON.stringify({ edition: "old", answer: "42" }));
    throw new Error("Expected edition rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(SubmissionInputError);
    expect((error as SubmissionInputError).status).toBe(409);
    expect((error as SubmissionInputError).code).toBe("edition_mismatch");
  }
});
