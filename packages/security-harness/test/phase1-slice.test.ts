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
