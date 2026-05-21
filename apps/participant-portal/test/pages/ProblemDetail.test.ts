import { describe, expect, it } from "vitest";
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
