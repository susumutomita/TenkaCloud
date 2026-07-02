import { describe, expect, it } from "vitest";
import type {
  ParticipantProblemView,
  ParticipantProgressionView,
} from "../../src/api/portal-client";
import {
  findGateProblem,
  gateProblemDisplayName,
  hasGateCompletionBonus,
  isGateAwaitingCompletion,
  isPrerequisiteLocked,
} from "../../src/lib/progression";
import {
  canRenderEndpointOverride,
  canRenderProblemDetailBody,
  isProblemDetailLocked,
} from "../../src/pages/ProblemDetail";

describe("ProblemDetail helpers", () => {
  it("should lock when the scoring_not_started gate is active", () => {
    expect(isProblemDetailLocked({ kind: "scoring_not_started" })).toBe(true);
  });

  it("should not lock when there is no gate or the gate is not scoring_not_started", () => {
    expect(isProblemDetailLocked(undefined)).toBe(false);
    expect(isProblemDetailLocked({ kind: "ok" })).toBe(false);
    expect(isProblemDetailLocked({ kind: "scoring_ended" })).toBe(false);
  });

  it("should display the problem body when a problem exists and is not locked", () => {
    expect(canRenderProblemDetailBody({ hasProblem: true, locked: false })).toBe(true);
  });

  it("should not display the problem body when no problem exists or it is locked", () => {
    expect(canRenderProblemDetailBody({ hasProblem: false, locked: false })).toBe(false);
    expect(canRenderProblemDetailBody({ hasProblem: true, locked: true })).toBe(false);
  });

  it("should display endpoint override when problem / metadata / endpoint exist and not locked", () => {
    expect(
      canRenderEndpointOverride({
        hasProblem: true,
        hasMetadata: true,
        endpointCount: 1,
        locked: false,
      }),
    ).toBe(true);
  });

  it("should not display when endpoint override preconditions are missing or it is locked", () => {
    expect(
      canRenderEndpointOverride({
        hasProblem: true,
        hasMetadata: true,
        endpointCount: 0,
        locked: false,
      }),
    ).toBe(false);
    expect(
      canRenderEndpointOverride({
        hasProblem: true,
        hasMetadata: false,
        endpointCount: 1,
        locked: false,
      }),
    ).toBe(false);
    expect(
      canRenderEndpointOverride({
        hasProblem: true,
        hasMetadata: true,
        endpointCount: 1,
        locked: true,
      }),
    ).toBe(false);
  });
});

// ── Issue #2283: Progression Gate (問題アンロック) の pure predicate 群 ──────────
const progression = (
  over: Partial<ParticipantProgressionView> = {},
): ParticipantProgressionView => ({
  gateProblemId: "hello-world-battle",
  gateCompleted: false,
  policy: "required",
  completionBonus: 50,
  lockedProblemIds: ["s3-treasure", "vpc-maze"],
  ...over,
});

const gateDeploy = (over: Partial<ParticipantProblemView> = {}): ParticipantProblemView =>
  ({
    jobId: "job-gate",
    problemId: "hello-world-battle",
    name: "Hello World Battle",
    region: "ap-northeast-1",
    awsAccountId: "999999999999",
    status: "COMPLETE",
    stackOutputs: {},
    expiresAt: 0,
    score: 0,
    deployLog: { cursor: "", entries: [] },
    ...over,
  }) as ParticipantProblemView;

describe("Progression Gate predicates (Issue #2283)", () => {
  it("should lock a problem listed in lockedProblemIds", () => {
    expect(isPrerequisiteLocked(progression(), "s3-treasure")).toBe(true);
    expect(isPrerequisiteLocked(progression(), "vpc-maze")).toBe(true);
  });

  it("should not lock the gate problem itself or an unlisted problem", () => {
    expect(isPrerequisiteLocked(progression(), "hello-world-battle")).toBe(false);
    expect(isPrerequisiteLocked(progression(), "other-problem")).toBe(false);
  });

  it("should not lock anything without progression or without a problemId", () => {
    expect(isPrerequisiteLocked(undefined, "s3-treasure")).toBe(false);
    expect(isPrerequisiteLocked(progression(), undefined)).toBe(false);
  });

  it("should not lock once the gate is completed (backend sends an empty locked list)", () => {
    expect(
      isPrerequisiteLocked(
        progression({ gateCompleted: true, lockedProblemIds: [] }),
        "s3-treasure",
      ),
    ).toBe(false);
  });

  it("should flag the gate problem as awaiting completion only while incomplete", () => {
    expect(isGateAwaitingCompletion(progression(), "hello-world-battle")).toBe(true);
    expect(
      isGateAwaitingCompletion(progression({ gateCompleted: true }), "hello-world-battle"),
    ).toBe(false);
    expect(isGateAwaitingCompletion(progression(), "s3-treasure")).toBe(false);
    expect(isGateAwaitingCompletion(undefined, "hello-world-battle")).toBe(false);
    expect(isGateAwaitingCompletion(progression(), undefined)).toBe(false);
  });

  it("should not promise an unlock when nothing is locked for the team (policy off)", () => {
    // policy "off" の team は Gate 未完了でも lockedProblemIds が空 → 「完了で解放」は虚偽。
    expect(
      isGateAwaitingCompletion(
        progression({ policy: "off", lockedProblemIds: [] }),
        "hello-world-battle",
      ),
    ).toBe(false);
  });

  it("should show the completion bonus on the incomplete gate problem regardless of locks", () => {
    expect(hasGateCompletionBonus(progression(), "hello-world-battle")).toBe(true);
    // policy "off" (= locked 無し) でも bonus は付与される → badge は出す。
    expect(
      hasGateCompletionBonus(
        progression({ policy: "off", lockedProblemIds: [] }),
        "hello-world-battle",
      ),
    ).toBe(true);
  });

  it("should hide the completion bonus when it is 0, completed, or not the gate problem", () => {
    expect(hasGateCompletionBonus(progression({ completionBonus: 0 }), "hello-world-battle")).toBe(
      false,
    );
    expect(hasGateCompletionBonus(progression({ gateCompleted: true }), "hello-world-battle")).toBe(
      false,
    );
    expect(hasGateCompletionBonus(progression(), "s3-treasure")).toBe(false);
    expect(hasGateCompletionBonus(undefined, "hello-world-battle")).toBe(false);
    expect(hasGateCompletionBonus(progression(), undefined)).toBe(false);
  });

  it("should find the gate problem deploy row in the team view", () => {
    const gate = gateDeploy();
    expect(findGateProblem(progression(), [gate])).toBe(gate);
    expect(findGateProblem(progression(), [gateDeploy({ problemId: "other" })])).toBeUndefined();
    expect(findGateProblem(undefined, [gate])).toBeUndefined();
    expect(findGateProblem(progression(), undefined)).toBeUndefined();
  });

  it("should resolve the gate display name from the team view and fall back to the problemId", () => {
    expect(gateProblemDisplayName(progression(), [gateDeploy()])).toBe("Hello World Battle");
    // name 不在 (AWS mode の旧 view) → problemId slug に fall back
    expect(gateProblemDisplayName(progression(), [gateDeploy({ name: undefined })])).toBe(
      "hello-world-battle",
    );
    // gate 問題が deploy されていない → problemId に fall back
    expect(gateProblemDisplayName(progression(), [])).toBe("hello-world-battle");
    expect(gateProblemDisplayName(undefined, [gateDeploy()])).toBe("");
  });
});
