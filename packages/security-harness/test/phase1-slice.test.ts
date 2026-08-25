/**
 * The end-to-end conformance test for Issue #3036's Phase 1 vertical slice. Every server here is
 * a real `node:http` server on a real loopback socket — nothing about the target or the HTTP
 * traffic is mocked. Determinism comes from the target/witness content being fixed, not from
 * faking the transport (see ../src/phase1-slice.ts's doc comment).
 */

import { describe, expect, it } from "vitest";
import { runPhase1Slice } from "../src/phase1-slice.js";

const FIXED_CLOCK = (): string => "2026-01-01T00:00:00.000Z";

describe("runPhase1Slice: the issue's 'First E2E' acceptance criteria", () => {
  it("should reproduce the baseline IDOR against a fresh instance of the intentionally vulnerable target", async () => {
    const result = await runPhase1Slice({
      runId: "e2e-baseline",
      baselineVariant: "vulnerable",
      patchVariant: "patched-correct",
      now: FIXED_CLOCK,
    });
    expect(result.finding?.verdict).toBe("confirmed");
    expect(result.finding?.reproduction.successes).toBe(result.finding?.reproduction.attempts);
  });

  it("should certify a correct authorization patch as verified-fixed", async () => {
    const result = await runPhase1Slice({
      runId: "e2e-correct-patch",
      baselineVariant: "vulnerable",
      patchVariant: "patched-correct",
      now: FIXED_CLOCK,
    });
    expect(result.finalState).toBe("COMPLETED");
    expect(result.patchEvaluation?.verdict).toBe("verified-fixed");
    expect(result.goldenTests?.every((t) => t.passed)).toBe(true);
    expect(result.patchEvaluation?.originalWitnessReplay).toBe("blocked");
    expect(result.patchEvaluation?.freshReattack).toBe("no-witness-found");
  });

  it("should fail an id-denylist-only patch via the fresh re-attack, as still-vulnerable", async () => {
    const result = await runPhase1Slice({
      runId: "e2e-denylist-patch",
      baselineVariant: "vulnerable",
      patchVariant: "patched-denylist-only",
      now: FIXED_CLOCK,
    });
    expect(result.finalState).toBe("COMPLETED");
    expect(result.patchEvaluation?.originalWitnessReplay).toBe("blocked");
    expect(result.patchEvaluation?.freshReattack).toBe("witness-confirmed");
    expect(result.patchEvaluation?.verdict).toBe("still-vulnerable");
  });

  it("should fail an endpoint-removal fake fix via the golden behavior tests, as regressed", async () => {
    const result = await runPhase1Slice({
      runId: "e2e-endpoint-removed-patch",
      baselineVariant: "vulnerable",
      patchVariant: "patched-endpoint-removed",
      now: FIXED_CLOCK,
    });
    expect(result.finalState).toBe("COMPLETED");
    expect(result.goldenTests?.some((t) => !t.passed)).toBe(true);
    expect(result.patchEvaluation?.verdict).toBe("regressed");
  });

  it("should never fail closed to a participant verdict when the declared baseline is not actually reproducible", async () => {
    const result = await runPhase1Slice({
      runId: "e2e-baseline-not-reproducible",
      baselineVariant: "patched-correct",
      patchVariant: "patched-correct",
      now: FIXED_CLOCK,
    });
    expect(result.finalState).toBe("INCONCLUSIVE");
    expect(result.finding?.verdict).not.toBe("confirmed");
    expect(result.patchEvaluation).toBeUndefined();
  });
});

describe("runPhase1Slice: cancellation stops new work", () => {
  it("should stop at CANCELLED right after DEDUPING and never reach remediation or launch a patch", async () => {
    // shouldCancel is checked before BUILDING (1st), before VERIFYING (2nd), and right after
    // DEDUPING (3rd) — cancelling on the 3rd check proves the run stops before READY_FOR_REMEDIATION
    // and before the patch variant is ever launched, without needing to spy on the fixture module.
    let calls = 0;
    const result = await runPhase1Slice({
      runId: "e2e-cancel-before-remediation",
      baselineVariant: "vulnerable",
      patchVariant: "patched-correct",
      now: FIXED_CLOCK,
      shouldCancel: () => {
        calls += 1;
        return calls >= 3;
      },
    });
    expect(result.finalState).toBe("CANCELLED");
    expect(result.states).toEqual(["QUEUED", "BUILDING", "VERIFYING", "DEDUPING", "CANCELLED"]);
    expect(result.finding?.verdict).toBe("confirmed");
    expect(result.patchEvaluation).toBeUndefined();
  });

  it("should stop before BUILDING when cancellation is requested immediately", async () => {
    const result = await runPhase1Slice({
      runId: "e2e-cancel-immediately",
      baselineVariant: "vulnerable",
      patchVariant: "patched-correct",
      now: FIXED_CLOCK,
      shouldCancel: () => true,
    });
    expect(result.finalState).toBe("CANCELLED");
    expect(result.states).toEqual(["QUEUED", "CANCELLED"]);
    expect(result.finding).toBeUndefined();
    expect(result.patchEvaluation).toBeUndefined();
  });
});

describe("runPhase1Slice: patch evaluation state machine completion (Phase 3)", () => {
  it("should evaluate a patch target that fails to build/start as build:'failed' -> inconclusive, never an uncaught exception", async () => {
    const result = await runPhase1Slice({
      runId: "e2e-patch-build-failure",
      baselineVariant: "vulnerable",
      patchVariant: "patched-build-failure",
      now: FIXED_CLOCK,
    });
    expect(result.finalState).toBe("COMPLETED");
    expect(result.patchEvaluation?.build).toBe("failed");
    expect(result.patchEvaluation?.verdict).toBe("inconclusive");
    expect(result.patchEvaluation?.reasons.some((r) => r.includes("build failed"))).toBe(true);
    // A build failure never even attempts golden tests — there is no live target to run them
    // against — so `goldenTests` stays absent rather than being reported as a false pass/fail.
    expect(result.goldenTests).toBeUndefined();
  });

  it("should record every stage — including the build-failure short-circuit — on the timeline", async () => {
    const result = await runPhase1Slice({
      runId: "e2e-patch-build-failure-timeline",
      baselineVariant: "vulnerable",
      patchVariant: "patched-build-failure",
      now: FIXED_CLOCK,
    });
    const types = result.timeline.map((e) => e.type);
    expect(types).toContain("finding-recorded");
    expect(types).toContain("patch-evaluation-recorded");
    expect(result.timeline.every((e) => e.runId === "e2e-patch-build-failure-timeline")).toBe(true);
    // Sequence numbers are strictly increasing insertion order.
    expect(result.timeline.map((e) => e.sequence)).toEqual(result.timeline.map((_, i) => i));
  });

  it("should evaluate a target/verifier crash during golden-tests-and-replay as inconclusive, never a silent pass", async () => {
    const result = await runPhase1Slice({
      runId: "e2e-golden-replay-crash",
      baselineVariant: "vulnerable",
      patchVariant: "patched-correct",
      now: FIXED_CLOCK,
      makeHttpClient: () => ({
        request: () => Promise.reject(new Error("simulated target crash")),
      }),
    });
    expect(result.finalState).toBe("COMPLETED");
    expect(result.patchEvaluation?.goldenBehavior).toBe("inconclusive");
    expect(result.patchEvaluation?.originalWitnessReplay).toBe("inconclusive");
    expect(result.patchEvaluation?.verdict).toBe("inconclusive");
    expect(result.patchEvaluation?.verdict).not.toBe("verified-fixed");
  });

  it("should evaluate a crash isolated to JUST the fresh-reattack stage as inconclusive, not verified-fixed", async () => {
    let callCount = 0;
    const result = await runPhase1Slice({
      runId: "e2e-reattack-crash-only",
      baselineVariant: "vulnerable",
      patchVariant: "patched-correct",
      now: FIXED_CLOCK,
      makeHttpClient: (baseUrl) => ({
        request: async (step) => {
          callCount += 1;
          // Golden tests + original-witness-replay all run first and must keep succeeding
          // normally; only the fresh re-attack witness (a distinct witnessId/path) is made to
          // crash, isolating this test to "the reattack executor itself failed" rather than
          // "everything failed".
          if (step.path === "/documents/doc-b2") {
            throw new Error("simulated verifier crash during fresh re-attack");
          }
          const response = await fetch(`${baseUrl}${step.path}`, {
            method: step.method,
            headers: step.headers,
            body: step.body,
          });
          return { status: response.status, body: await response.text() };
        },
      }),
    });
    expect(callCount).toBeGreaterThan(0);
    expect(result.patchEvaluation?.goldenBehavior).toBe("passed");
    expect(result.patchEvaluation?.originalWitnessReplay).toBe("blocked");
    expect(result.patchEvaluation?.freshReattack).toBe("inconclusive");
    expect(result.patchEvaluation?.verdict).toBe("inconclusive");
    expect(result.patchEvaluation?.verdict).not.toBe("verified-fixed");
  });

  it("should still cancel cleanly (no patch evaluation) even with a crash-simulating client installed but never invoked", async () => {
    let calls = 0;
    const result = await runPhase1Slice({
      runId: "e2e-cancel-with-crash-client",
      baselineVariant: "vulnerable",
      patchVariant: "patched-correct",
      now: FIXED_CLOCK,
      makeHttpClient: () => ({
        request: () => Promise.reject(new Error("should never be called")),
      }),
      shouldCancel: () => {
        calls += 1;
        return calls >= 3;
      },
    });
    expect(result.finalState).toBe("CANCELLED");
    expect(result.patchEvaluation).toBeUndefined();
  });
});

describe("runPhase1Slice: run timeline (Phase 3)", () => {
  it("should timestamp every timeline event from the injected clock, never Date.now()", async () => {
    const result = await runPhase1Slice({
      runId: "e2e-timeline-clock",
      baselineVariant: "vulnerable",
      patchVariant: "patched-correct",
      now: FIXED_CLOCK,
    });
    expect(result.timeline.length).toBeGreaterThan(0);
    expect(result.timeline.every((e) => e.occurredAt === FIXED_CLOCK())).toBe(true);
  });

  it("should record a state-transition event for every entry in `states`, in the same order", async () => {
    const result = await runPhase1Slice({
      runId: "e2e-timeline-states",
      baselineVariant: "vulnerable",
      patchVariant: "patched-correct",
      now: FIXED_CLOCK,
    });
    const recordedStates = result.timeline
      .filter((e) => e.type === "state-transition")
      .map((e) => (e.type === "state-transition" ? e.state : undefined));
    expect(recordedStates).toEqual(result.states);
  });

  it("should stop appending to the timeline once cancelled — nothing recorded after the CANCELLED event", async () => {
    let calls = 0;
    const result = await runPhase1Slice({
      runId: "e2e-timeline-cancel",
      baselineVariant: "vulnerable",
      patchVariant: "patched-correct",
      now: FIXED_CLOCK,
      shouldCancel: () => {
        calls += 1;
        return calls >= 3;
      },
    });
    const lastEvent = result.timeline.at(-1);
    expect(lastEvent?.type).toBe("state-transition");
    expect(lastEvent?.type === "state-transition" ? lastEvent.state : undefined).toBe("CANCELLED");
  });
});

describe("runPhase1Slice: fresh environment per run", () => {
  it("should not carry document state between separate runs against the same variant", async () => {
    const first = await runPhase1Slice({
      runId: "e2e-fresh-1",
      baselineVariant: "vulnerable",
      patchVariant: "patched-correct",
      now: FIXED_CLOCK,
    });
    const second = await runPhase1Slice({
      runId: "e2e-fresh-2",
      baselineVariant: "vulnerable",
      patchVariant: "patched-correct",
      now: FIXED_CLOCK,
    });
    // Both runs see the same baseline confirmation — if state leaked between runs (e.g. a
    // create-and-list golden test from run 1 polluting run 2's document set), the two runs would
    // stop agreeing on outcomes.
    expect(first.finding?.verdict).toBe(second.finding?.verdict);
    expect(first.patchEvaluation?.verdict).toBe(second.patchEvaluation?.verdict);
  });
});
