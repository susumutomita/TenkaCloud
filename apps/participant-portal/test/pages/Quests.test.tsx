import { describe, expect, it } from "vitest";
import type { ParticipantProblemView } from "../../src/api/portal-client";
import { renderSubmissionState } from "../../src/pages/Quests";

/**
 * Issue #1349 — scoring badge per-status pin。 `renderSubmissionState` の 4 状態
 * (= 未着手 / Deploy 中 / 着手中 / 解答済) を unit test し、 解答済 時に
 * `+Npt` (points) が末尾に出ることを確認する。
 */
function problem(partial: Partial<ParticipantProblemView>): ParticipantProblemView {
  return {
    jobId: "job-x",
    problemId: "hello-world",
    region: "ap-northeast-1",
    awsAccountId: "999999999999",
    status: "COMPLETE",
    stackOutputs: {},
    expiresAt: 0,
    score: 0,
    deployLog: { cursor: "", entries: [] },
    ...partial,
  };
}

function pseudoT(key: string, params?: Readonly<Record<string, string | number>>): string {
  if (!params) return `[${key}]`;
  return `[${key}|${Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join(",")}]`;
}

describe("renderSubmissionState scoring badge", () => {
  it("should show error type for FAILED deploys", () => {
    const s = renderSubmissionState(problem({ status: "FAILED" }), pseudoT);
    expect(s.type).toBe("error");
    expect(s.label).toBe("[quests.submission_failed]");
  });

  it("should show in-progress type while the deploy is still PENDING / IN_PROGRESS", () => {
    expect(renderSubmissionState(problem({ status: "PENDING" }), pseudoT).type).toBe("in-progress");
    expect(renderSubmissionState(problem({ status: "IN_PROGRESS" }), pseudoT).type).toBe(
      "in-progress",
    );
  });

  it("should show pending type (= 未着手) when flag is not yet submitted", () => {
    const s = renderSubmissionState(
      problem({ status: "COMPLETE", scoring: { kind: "flag", flagSubmitted: false } }),
      pseudoT,
    );
    expect(s.type).toBe("pending");
    expect(s.label).toBe("[quests.submission_unsolved]");
  });

  it("should include points (+Npt) when flag is submitted and scoring.points is known", () => {
    const s = renderSubmissionState(
      problem({
        status: "COMPLETE",
        scoring: { kind: "flag", flagSubmitted: true, points: 100 },
      }),
      pseudoT,
    );
    expect(s.type).toBe("success");
    expect(s.label).toBe("[quests.submission_cleared_with_points|points=100]");
  });

  it("should fall back to plain cleared label when points is missing", () => {
    const s = renderSubmissionState(
      problem({
        status: "COMPLETE",
        scoring: { kind: "flag", flagSubmitted: true },
      }),
      pseudoT,
    );
    expect(s.label).toBe("[quests.submission_cleared]");
  });

  it("should fall through to 'in progress' info for non-flag uptime scoring", () => {
    const s = renderSubmissionState(
      problem({ status: "COMPLETE", scoring: { kind: "uptime" }, score: 60 }),
      pseudoT,
    );
    expect(s.type).toBe("info");
    expect(s.label).toBe("[quests.submission_in_progress]");
  });
});
