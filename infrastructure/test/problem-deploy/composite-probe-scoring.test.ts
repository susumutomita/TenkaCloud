/**
 * [Composite Runtime / Issue #2070] Composite-aware scoring (`composite-probe`).
 *
 * Two surfaces are pinned:
 *   - the metadata schema/validator addition in `scoring-metadata.ts`
 *     (opt-in kind, legacy kinds untouched), and
 *   - the pure `scoreCompositeProbe` scorer with an INJECTED fake probe (no real
 *     network) — one probe per declared target, success only when all succeed,
 *     and a target-specific diagnostic on any failure.
 */

import { describe, expect, it, vi } from "vitest";
import {
  type CompositeProbeFn,
  type CompositeProbeInput,
  scoreCompositeProbe,
} from "../../lib/problem-deploy/handlers/generic-scoring-handler/kinds/composite-probe";
import {
  type CompositeProbeScoringMetadata,
  parseScoringMetadata,
} from "../../lib/utils/scoring-metadata";

// --------------------------------------------------------------------------
// Metadata schema + validator
// --------------------------------------------------------------------------

describe("parseScoringMetadata composite-probe kind", () => {
  it("should narrow a valid composite-probe metadata with success all", () => {
    expect(
      parseScoringMetadata({
        kind: "composite-probe",
        success: "all",
        pointsAllOk: 100,
        targets: [
          { targetId: "aws-api", probe: "https", outputKey: "ApiUrl" },
          { targetId: "gcp-web", probe: "https", outputKey: "WebUrl", path: "/health" },
        ],
      }),
    ).toEqual({
      kind: "composite-probe",
      success: "all",
      pointsAllOk: 100,
      targets: [
        { targetId: "aws-api", probe: "https", outputKey: "ApiUrl" },
        { targetId: "gcp-web", probe: "https", outputKey: "WebUrl", path: "/health" },
      ],
    });
  });

  it("should reject duplicate scoring target ids", () => {
    expect(
      parseScoringMetadata({
        kind: "composite-probe",
        success: "all",
        pointsAllOk: 10,
        targets: [
          { targetId: "dup", probe: "https", outputKey: "ApiUrl" },
          { targetId: "dup", probe: "https", outputKey: "WebUrl" },
        ],
      }),
    ).toBeUndefined();
  });

  it("should require explicit output key for each probe", () => {
    // No outputKey → the scorer must not infer a URL field, so the whole
    // metadata is rejected (fail loud).
    expect(
      parseScoringMetadata({
        kind: "composite-probe",
        success: "all",
        pointsAllOk: 10,
        targets: [{ targetId: "aws-api", probe: "https" }],
      }),
    ).toBeUndefined();
  });

  it("should reject an unknown success value", () => {
    for (const success of ["any", "quorum", "weighted", 1, undefined]) {
      expect(
        parseScoringMetadata({
          kind: "composite-probe",
          success,
          pointsAllOk: 10,
          targets: [{ targetId: "aws-api", probe: "https", outputKey: "ApiUrl" }],
        }),
      ).toBeUndefined();
    }
  });

  it("should reject an unknown probe kind", () => {
    expect(
      parseScoringMetadata({
        kind: "composite-probe",
        success: "all",
        pointsAllOk: 10,
        targets: [{ targetId: "aws-api", probe: "dns", outputKey: "ApiUrl" }],
      }),
    ).toBeUndefined();
  });

  it("should keep legacy flag scoring unchanged", () => {
    expect(
      parseScoringMetadata({ kind: "flag", flagOutputKey: "ParameterValue", points: 100 }),
    ).toEqual({
      kind: "flag",
      flagOutputKey: "ParameterValue",
      points: 100,
      wrongAnswerPenalty: undefined,
      hints: undefined,
    });
  });

  it("should keep legacy phased polling unchanged", () => {
    expect(
      parseScoringMetadata({
        kind: "phased-polling",
        intervalMinutes: 5,
        probe: { metaPath: "/meta", scorePath: "/score" },
        platformRules: { ecs: { points: 10 } },
      }),
    ).toEqual({
      kind: "phased-polling",
      intervalMinutes: 5,
      probe: { metaPath: "/meta", scorePath: "/score" },
      platformRules: { ecs: { points: 10 } },
    });
  });
});

// --------------------------------------------------------------------------
// Pure scorer with injected fake probe
// --------------------------------------------------------------------------

const FOUR_TARGET_SCORING: CompositeProbeScoringMetadata = {
  kind: "composite-probe",
  success: "all",
  pointsAllOk: 400,
  targets: [
    { targetId: "aws-api", probe: "https", outputKey: "ApiUrl" },
    { targetId: "gcp-web", probe: "https", outputKey: "WebUrl" },
    { targetId: "azure-fn", probe: "https", outputKey: "FnUrl" },
    { targetId: "sakura-app", probe: "https", outputKey: "AppUrl" },
  ],
};

const FOUR_TARGET_INPUT: CompositeProbeInput = {
  parentDeploymentId: "PARENT1",
  parentStatus: "COMPLETE",
  targets: [
    {
      targetId: "aws-api",
      provider: "aws",
      status: "COMPLETE",
      outputs: { ApiUrl: "https://api.aws.example" },
    },
    {
      targetId: "gcp-web",
      provider: "gcp",
      status: "COMPLETE",
      outputs: { WebUrl: "https://web.gcp.example" },
    },
    {
      targetId: "azure-fn",
      provider: "azure",
      status: "COMPLETE",
      outputs: { FnUrl: "https://fn.azure.example" },
    },
    {
      targetId: "sakura-app",
      provider: "sakura",
      status: "COMPLETE",
      outputs: { AppUrl: "https://app.sakura.example" },
    },
  ],
};

function okProbe(): CompositeProbeFn {
  return vi.fn(async () => ({ ok: true }));
}

describe("scoreCompositeProbe", () => {
  it("should run one probe per declared composite target", async () => {
    const probe = okProbe();
    await scoreCompositeProbe(FOUR_TARGET_INPUT, FOUR_TARGET_SCORING, probe);
    expect(probe).toHaveBeenCalledTimes(4);
  });

  it("should return success only when every target probe succeeds", async () => {
    const probe = okProbe();
    const result = await scoreCompositeProbe(FOUR_TARGET_INPUT, FOUR_TARGET_SCORING, probe);
    expect(result.success).toBe(true);
    expect(result.notReady).toBe(false);
    expect(result.pointsAwarded).toBe(400);
    expect(result.data.failures).toEqual([]);
  });

  it("should report the failed target id when one probe fails", async () => {
    // gcp-web fails its probe; every other target is healthy.
    const probe: CompositeProbeFn = vi.fn(async (url) => ({
      ok: !url.includes("web.gcp.example"),
    }));
    const result = await scoreCompositeProbe(FOUR_TARGET_INPUT, FOUR_TARGET_SCORING, probe);
    expect(result.success).toBe(false);
    expect(result.pointsAwarded).toBe(0);
    expect(result.data.failures).toEqual([{ targetId: "gcp-web", reason: "probe-failed" }]);
  });

  it("should not run before parent COMPLETE", async () => {
    const probe = okProbe();
    const result = await scoreCompositeProbe(
      { ...FOUR_TARGET_INPUT, parentStatus: "IN_PROGRESS" },
      FOUR_TARGET_SCORING,
      probe,
    );
    expect(probe).not.toHaveBeenCalled();
    expect(result.notReady).toBe(true);
    expect(result.success).toBe(false);
    expect(result.pointsAwarded).toBe(0);
  });

  it("should report a scoring target absent from runtime targets", async () => {
    const probe = okProbe();
    const input: CompositeProbeInput = {
      ...FOUR_TARGET_INPUT,
      targets: FOUR_TARGET_INPUT.targets.filter((t) => t.targetId !== "azure-fn"),
    };
    const result = await scoreCompositeProbe(input, FOUR_TARGET_SCORING, probe);
    expect(result.success).toBe(false);
    // The absent target is never probed, but it surfaces as a diagnostic.
    expect(probe).toHaveBeenCalledTimes(3);
    expect(result.data.failures).toContainEqual({ targetId: "azure-fn", reason: "target-absent" });
  });

  it("should report a target that is not yet COMPLETE", async () => {
    const probe = okProbe();
    const input: CompositeProbeInput = {
      ...FOUR_TARGET_INPUT,
      targets: FOUR_TARGET_INPUT.targets.map((t) =>
        t.targetId === "sakura-app" ? { ...t, status: "IN_PROGRESS" } : t,
      ),
    };
    const result = await scoreCompositeProbe(input, FOUR_TARGET_SCORING, probe);
    expect(result.success).toBe(false);
    expect(result.data.failures).toContainEqual({
      targetId: "sakura-app",
      reason: "target-not-complete",
    });
  });

  it("should report a target whose declared output key is missing", async () => {
    const probe = okProbe();
    const input: CompositeProbeInput = {
      ...FOUR_TARGET_INPUT,
      targets: FOUR_TARGET_INPUT.targets.map((t) =>
        t.targetId === "aws-api" ? { ...t, outputs: { SomethingElse: "https://x.example" } } : t,
      ),
    };
    const result = await scoreCompositeProbe(input, FOUR_TARGET_SCORING, probe);
    expect(result.success).toBe(false);
    expect(result.data.failures).toContainEqual({ targetId: "aws-api", reason: "output-missing" });
  });

  it("should score a four-target AWS/GCP/Azure/Sakura fixture with all probes succeeding", async () => {
    const probe = okProbe();
    const result = await scoreCompositeProbe(FOUR_TARGET_INPUT, FOUR_TARGET_SCORING, probe);
    expect(result.success).toBe(true);
    expect(result.pointsAwarded).toBe(400);
    expect(result.probedTargetIds).toEqual(["aws-api", "gcp-web", "azure-fn", "sakura-app"]);
  });

  it("should award no points and surface the target-specific diagnostic when one of four targets fails", async () => {
    // azure-fn fails — no award, diagnostic names exactly that target.
    const probe: CompositeProbeFn = vi.fn(async (url) => ({
      ok: !url.includes("fn.azure.example"),
    }));
    const result = await scoreCompositeProbe(FOUR_TARGET_INPUT, FOUR_TARGET_SCORING, probe);
    expect(result.success).toBe(false);
    expect(result.pointsAwarded).toBe(0);
    expect(result.data.failures).toEqual([{ targetId: "azure-fn", reason: "probe-failed" }]);
  });
});
