/**
 * Integration coverage for Issue #3036 Phase 2's TenkaCloud-owned slice: proves `planRecon`,
 * `runFinders`, and `dedupeFindings` compose into one deterministic, model-free flow — Recon
 * partitions a threat model, Finders run in parallel through `FixtureModelProvider` (no live
 * model), succeeding/redundant/failing outputs all land in an explicit checkpoint, and dedupe
 * collapses the two Finders that converged on the same focus area.
 *
 * This intentionally stops at the deduped candidate-findings stage. Independent verification
 * (confirming a candidate witness in a fresh sandbox) and everything downstream of it —
 * patch evaluation, the artifact store, the audit timeline, reveal policy — are explicitly out of
 * scope for this slice; see `../src/index.ts`'s package doc comment.
 */

import { describe, expect, it } from "vitest";
import { dedupeFindings } from "../src/dedupe.js";
import { runFinders } from "../src/finder-orchestration.js";
import {
  FixtureModelProvider,
  fixtureFailure,
  fixtureSuccess,
} from "../src/fixture-model-provider.js";
import type { ReconThreatModel } from "../src/recon.js";
import { planRecon } from "../src/recon.js";

function claimText(focusArea: string, witnessId: string, path: string): string {
  return JSON.stringify({
    witness: {
      type: "http-sequence",
      witnessId,
      focusArea,
      steps: [{ method: "GET", path, expectStatus: 200, expectBodyIncludes: "leaked" }],
    },
  });
}

describe("Phase 2 Recon -> Find -> Dedupe (model-free)", () => {
  it("should partition a threat model, run every finder through the fixture adapter, and dedupe the two finders that converged on the same focus area", async () => {
    const threatModel: ReconThreatModel = {
      threatModelDigest: "sha256:threat-model",
      focusAreas: [
        { id: "documents-idor", description: "IDOR on /documents/:id", priority: 5 },
        { id: "auth-bypass", description: "auth bypass", priority: 1 },
      ],
    };
    // maxFinders=3 with 2 focus areas => the highest-priority area (documents-idor) gets a
    // primary finder AND the round-robin spare (see ./recon.ts), so two independent finders
    // target the same focus area — exactly the convergence case dedupe exists for.
    const reconPlan = planRecon(threatModel, 3);
    expect(reconPlan.assignments.map((a) => a.focusArea)).toEqual([
      "documents-idor",
      "auth-bypass",
      "documents-idor",
    ]);

    const adapter = new FixtureModelProvider({
      scripts: {
        "documents-idor": [
          // finder 0 (primary) and finder 2 (redundant) both consume this same script queue in
          // call order — both entries describe the identical underlying witness, proving dedupe
          // collapses genuinely-independent finder calls, not just literal duplicate objects.
          fixtureSuccess(claimText("documents-idor", "finder-0-witness", "/documents/doc-b1")),
          fixtureSuccess(claimText("documents-idor", "finder-2-witness", "/documents/doc-b1")),
        ],
        "auth-bypass": [
          fixtureFailure("invalid_response", "model returned unusable output", false),
        ],
      },
    });

    const { checkpoints } = await runFinders({
      runId: "phase2-demo",
      assignments: reconPlan.assignments,
      adapter,
      buildPrompt: (focusArea) => ({
        systemPrompt: `Search focus area: ${focusArea}`,
        userPrompt: "Find a PoC.",
        maxOutputTokens: 512,
      }),
      wait: () => Promise.resolve(),
    });

    expect(checkpoints).toHaveLength(3);
    const byIndex = new Map(checkpoints.map((c) => [c.finderIndex, c]));
    expect(byIndex.get(0)?.status).toBe("succeeded");
    expect(byIndex.get(1)?.status).toBe("model_error"); // auth-bypass: no false pass on a model failure
    expect(byIndex.get(2)?.status).toBe("succeeded");

    const candidates = checkpoints
      .filter((c) => c.status === "succeeded" && c.handoff !== undefined)
      .map((c) => c.handoff)
      .filter((h): h is NonNullable<typeof h> => h !== undefined);
    expect(candidates).toHaveLength(2);

    const manifest = dedupeFindings(candidates);
    expect(manifest.totalInput).toBe(2);
    expect(manifest.totalUnique).toBe(1);
    expect(manifest.groups[0]?.kept.witness.witnessId).toBe("finder-0-witness");
    expect(manifest.groups[0]?.duplicates).toHaveLength(1);

    // The auth-bypass model failure never silently disappears — it is reachable in the
    // checkpoints returned to the caller, not swallowed by dedupe or by runFinders.
    expect(byIndex.get(1)?.errors.length).toBeGreaterThan(0);
  });
});
