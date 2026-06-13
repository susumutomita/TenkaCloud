import { describe, expect, it } from "vitest";
import {
  type EventGate,
  evaluateGate,
} from "../../lib/problem-deploy/handlers/participant-handler/event-gate";

const NOW = Date.parse("2026-06-13T12:00:00.000Z");

function gate(over: Partial<EventGate> = {}): EventGate {
  return {
    scoringLocked: false,
    startsAt: "2026-06-13T10:00:00.000Z",
    endsAt: "2026-06-13T18:00:00.000Z",
    status: "ACTIVE",
    scoreboardFreezeMinutes: undefined,
    ...over,
  };
}

describe("evaluateGate", () => {
  // --- existing behavior (regression guard) ---
  it("should block (scoring_not_started) when the gate is absent (event row missing)", () => {
    expect(evaluateGate(undefined, NOW)).toEqual({ kind: "scoring_not_started" });
  });

  it("should block (scoring_ended) when status is ENDED or ARCHIVED", () => {
    expect(evaluateGate(gate({ status: "ENDED" }), NOW)).toMatchObject({ kind: "scoring_ended" });
    expect(evaluateGate(gate({ status: "ARCHIVED" }), NOW)).toMatchObject({
      kind: "scoring_ended",
    });
  });

  it("should block (scoring_not_started) when startsAt is unset", () => {
    expect(evaluateGate(gate({ startsAt: undefined }), NOW)).toEqual({
      kind: "scoring_not_started",
    });
  });

  it("should block (scoring_not_started) before startsAt", () => {
    expect(evaluateGate(gate({ startsAt: "2026-06-13T13:00:00.000Z" }), NOW)).toMatchObject({
      kind: "scoring_not_started",
    });
  });

  it("should block (scoring_ended) after endsAt", () => {
    expect(evaluateGate(gate({ endsAt: "2026-06-13T11:00:00.000Z" }), NOW)).toMatchObject({
      kind: "scoring_ended",
    });
  });

  it("should block (scoring_locked) when scoringLocked is true within the window", () => {
    expect(evaluateGate(gate({ scoringLocked: true }), NOW)).toEqual({ kind: "scoring_locked" });
  });

  it("should allow (undefined) within the competition window and unlocked", () => {
    expect(evaluateGate(gate(), NOW)).toBeUndefined();
  });

  // --- fail-closed on corrupt timestamps (the bug: module documents fail-closed
  //     but Date.parse NaN previously fell THROUGH to allow scoring) ---
  it("should fail closed (scoring_not_started) when startsAt is an unparseable string", () => {
    // z.string() (no .datetime()) lets a non-ISO startsAt be stored. The old code did
    // `Number.isFinite(NaN) && ...` -> false -> skipped the block -> scoring ALLOWED
    // before any verifiable start. Fail-closed: an unverifiable start blocks scoring.
    expect(evaluateGate(gate({ startsAt: "not-a-date" }), NOW)).toMatchObject({
      kind: "scoring_not_started",
    });
  });

  it("should fail closed (scoring_ended) when endsAt is an unparseable string", () => {
    // A corrupt endsAt means we cannot verify we are before the end. Fail-closed:
    // treat it as ended rather than accept scores past an unverifiable window.
    expect(evaluateGate(gate({ endsAt: "garbage" }), NOW)).toMatchObject({
      kind: "scoring_ended",
    });
  });
});
