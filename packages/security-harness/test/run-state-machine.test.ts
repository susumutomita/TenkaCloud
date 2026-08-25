import { describe, expect, it } from "vitest";
import {
  canTransition,
  IllegalSecurityRunTransitionError,
  isTerminalState,
  TERMINAL_STATES,
  transitionSecurityRun,
} from "../src/run-state-machine.js";
import type { SecurityRunState } from "../src/types.js";

describe("transitionSecurityRun: the happy path", () => {
  it("should walk the full Phase 1 fast path (no Recon/Find loop)", () => {
    const path: SecurityRunState[] = [
      "QUEUED",
      "BUILDING",
      "VERIFYING",
      "DEDUPING",
      "READY_FOR_REMEDIATION",
      "VALIDATING_PATCH",
      "REATTACKING",
      "COMPLETED",
    ];
    let state: SecurityRunState = path[0];
    for (const next of path.slice(1)) {
      state = transitionSecurityRun(state, next);
      expect(state).toBe(next);
    }
  });

  it("should also allow the full Recon/Find loop for Phase 2+", () => {
    const path: SecurityRunState[] = [
      "QUEUED",
      "BUILDING",
      "RECONNING",
      "FINDING",
      "VERIFYING",
      "DEDUPING",
    ];
    let state: SecurityRunState = path[0];
    for (const next of path.slice(1)) {
      state = transitionSecurityRun(state, next);
    }
    expect(state).toBe("DEDUPING");
  });
});

describe("transitionSecurityRun: idempotent resume", () => {
  it("should treat re-issuing the current state as a no-op success", () => {
    expect(transitionSecurityRun("VERIFYING", "VERIFYING")).toBe("VERIFYING");
  });

  it("should treat replaying a terminal state as a no-op success", () => {
    expect(transitionSecurityRun("COMPLETED", "COMPLETED")).toBe("COMPLETED");
    expect(transitionSecurityRun("CANCELLED", "CANCELLED")).toBe("CANCELLED");
  });
});

describe("transitionSecurityRun: illegal moves", () => {
  it("should reject skipping straight to a downstream state", () => {
    expect(() => transitionSecurityRun("QUEUED", "COMPLETED")).toThrow(
      IllegalSecurityRunTransitionError,
    );
  });

  it("should reject moving backwards", () => {
    expect(() => transitionSecurityRun("VERIFYING", "BUILDING")).toThrow(
      IllegalSecurityRunTransitionError,
    );
  });

  it("should reject any new work once a run has been CANCELLED — no execution after cancellation", () => {
    expect(() => transitionSecurityRun("CANCELLED", "BUILDING")).toThrow(
      IllegalSecurityRunTransitionError,
    );
    expect(() => transitionSecurityRun("CANCELLED", "VERIFYING")).toThrow(
      IllegalSecurityRunTransitionError,
    );
  });

  it("should reject any new work once a run has FAILED or gone INCONCLUSIVE", () => {
    expect(() => transitionSecurityRun("FAILED", "BUILDING")).toThrow(
      IllegalSecurityRunTransitionError,
    );
    expect(() => transitionSecurityRun("INCONCLUSIVE", "VERIFYING")).toThrow(
      IllegalSecurityRunTransitionError,
    );
  });

  it("should carry the attempted from/to states on the thrown error", () => {
    try {
      transitionSecurityRun("QUEUED", "COMPLETED");
      expect.fail("expected transitionSecurityRun to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(IllegalSecurityRunTransitionError);
      expect((error as IllegalSecurityRunTransitionError).from).toBe("QUEUED");
      expect((error as IllegalSecurityRunTransitionError).to).toBe("COMPLETED");
    }
  });

  it("should never let a confirmed-baseline run silently fall back to INCONCLUSIVE from READY_FOR_REMEDIATION onward", () => {
    expect(canTransition("READY_FOR_REMEDIATION", "INCONCLUSIVE")).toBe(false);
    expect(canTransition("VALIDATING_PATCH", "INCONCLUSIVE")).toBe(false);
    expect(canTransition("REATTACKING", "INCONCLUSIVE")).toBe(false);
  });
});

describe("terminal states", () => {
  it("should classify exactly the four terminal states", () => {
    expect(TERMINAL_STATES).toEqual(new Set(["COMPLETED", "FAILED", "CANCELLED", "INCONCLUSIVE"]));
  });

  it("should agree with isTerminalState for every state", () => {
    const all: SecurityRunState[] = [
      "QUEUED",
      "BUILDING",
      "RECONNING",
      "FINDING",
      "VERIFYING",
      "DEDUPING",
      "READY_FOR_REMEDIATION",
      "VALIDATING_PATCH",
      "REATTACKING",
      "COMPLETED",
      "FAILED",
      "CANCELLED",
      "INCONCLUSIVE",
    ];
    for (const s of all) {
      expect(isTerminalState(s)).toBe(TERMINAL_STATES.has(s));
    }
  });

  it("should allow every non-terminal state to be killed via CANCELLED or FAILED", () => {
    const nonTerminal: SecurityRunState[] = [
      "QUEUED",
      "BUILDING",
      "RECONNING",
      "FINDING",
      "VERIFYING",
      "DEDUPING",
    ];
    for (const s of nonTerminal) {
      expect(canTransition(s, "CANCELLED")).toBe(true);
      expect(canTransition(s, "FAILED")).toBe(true);
    }
  });
});
