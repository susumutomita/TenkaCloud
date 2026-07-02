/**
 * [Problem Test Harness / Issue #2107] Deterministic scorer unit suite.
 *
 * Exercises every scoring kind the harness dispatches (flag / multi-flag /
 * attack-detection / uptime-flat + legacy uptime / uptime-multi /
 * composite-probe / phased-polling), every diagnostic code, and the faked
 * probe-result decision table. Pure data in, pure data out — no I/O.
 */

import { describe, expect, it } from "vitest";
import { runScorer, SCORING_DIAGNOSTIC_CODES, type ScoreInput } from "../src/scorer.js";
import type { ProblemScoringMetadata } from "../src/scoring-types.js";

function score(input: Partial<ScoreInput> & { scoring: ProblemScoringMetadata }) {
  return runScorer({
    outputs: {},
    probeResults: {},
    declaredTargetIds: [],
    ...input,
  });
}

describe("runScorer", () => {
  describe("flag", () => {
    it("should succeed when the flag output key holds a non-empty string", () => {
      const result = score({
        scoring: { kind: "flag", flagOutputKey: "FlagValue", points: 100 },
        outputs: { FlagValue: "T{x}" },
      });
      expect(result).toEqual({ outcome: "success", diagnostics: [] });
    });

    it("should be not-runnable with MISSING_OUTPUT_KEY when the flag output is absent", () => {
      const result = score({
        scoring: { kind: "flag", flagOutputKey: "FlagValue", points: 100 },
      });
      expect(result.outcome).toBe("not-runnable");
      expect(result.diagnostics[0]?.code).toBe(SCORING_DIAGNOSTIC_CODES.MISSING_OUTPUT_KEY);
    });

    it("should treat an empty-string output as missing", () => {
      const result = score({
        scoring: { kind: "flag", flagOutputKey: "FlagValue", points: 100 },
        outputs: { FlagValue: "" },
      });
      expect(result.outcome).toBe("not-runnable");
    });
  });

  describe("multi-flag", () => {
    const scoring: ProblemScoringMetadata = {
      kind: "multi-flag",
      flags: [
        { id: "a", label: "Flag A", flagOutputKey: "FlagA", points: 50 },
        { id: "b", label: "Flag B", flagOutputKey: "FlagB", points: 50 },
      ],
    };

    it("should succeed when every sub-flag output is present", () => {
      const result = score({ scoring, outputs: { FlagA: "T{a}", FlagB: "T{b}" } });
      expect(result).toEqual({ outcome: "success", diagnostics: [] });
    });

    it("should be not-runnable naming the first missing sub-flag", () => {
      const result = score({ scoring, outputs: { FlagA: "T{a}" } });
      expect(result.outcome).toBe("not-runnable");
      expect(result.diagnostics[0]?.path).toContain("flags[b]");
    });
  });

  describe("attack-detection", () => {
    it("should succeed when the stats output key is present", () => {
      const result = score({
        scoring: {
          kind: "attack-detection",
          statsOutputKey: "StatsUrl",
          pointsPerAttack: 10,
        } as ProblemScoringMetadata,
        outputs: { StatsUrl: "https://stats.example/" },
      });
      expect(result.outcome).toBe("success");
    });

    it("should be not-runnable when the stats output key is absent", () => {
      const result = score({
        scoring: {
          kind: "attack-detection",
          statsOutputKey: "StatsUrl",
          pointsPerAttack: 10,
        } as ProblemScoringMetadata,
      });
      expect(result.outcome).toBe("not-runnable");
      expect(result.diagnostics[0]?.code).toBe(SCORING_DIAGNOSTIC_CODES.MISSING_OUTPUT_KEY);
    });
  });

  describe("phased-polling", () => {
    it("should succeed when the probe meta path output is present", () => {
      const result = score({
        scoring: {
          kind: "phased-polling",
          probe: { metaPath: "MetaUrl" },
          phases: [],
        } as unknown as ProblemScoringMetadata,
        outputs: { MetaUrl: "https://meta.example/" },
      });
      expect(result.outcome).toBe("success");
    });
  });

  describe("uptime-flat (and legacy 'uptime' alias)", () => {
    function uptime(kind: "uptime-flat" | "uptime"): ProblemScoringMetadata {
      return {
        kind,
        pointsPerInterval: 5,
        endpoints: [{ slot: "AppUrl", expectStatus: [200, 204] }],
      } as unknown as ProblemScoringMetadata;
    }

    it("should succeed when the probed endpoint returns an expected status", () => {
      const result = score({
        scoring: uptime("uptime-flat"),
        outputs: { AppUrl: "https://app.example/" },
        probeResults: { "https://app.example/": { status: 204, reachable: true } },
      });
      expect(result).toEqual({ outcome: "success", diagnostics: [] });
    });

    it("should dispatch the legacy 'uptime' kind through the same scorer", () => {
      const result = score({
        scoring: uptime("uptime"),
        outputs: { AppUrl: "https://app.example/" },
        probeResults: { "https://app.example/": { status: 200, reachable: true } },
      });
      expect(result.outcome).toBe("success");
    });

    it("should fail with PROBE_FAILED when the endpoint returns an unexpected status", () => {
      const result = score({
        scoring: uptime("uptime-flat"),
        outputs: { AppUrl: "https://app.example/" },
        probeResults: { "https://app.example/": { status: 500, reachable: true } },
      });
      expect(result.outcome).toBe("failure");
      expect(result.diagnostics[0]?.code).toBe(SCORING_DIAGNOSTIC_CODES.PROBE_FAILED);
    });

    it("should be not-runnable when the endpoint's output key is absent", () => {
      const result = score({ scoring: uptime("uptime-flat") });
      expect(result.outcome).toBe("not-runnable");
      expect(result.diagnostics[0]?.code).toBe(SCORING_DIAGNOSTIC_CODES.MISSING_OUTPUT_KEY);
    });

    it("should prefer an explicit outputKey over the slot name", () => {
      const scoring = {
        kind: "uptime-flat",
        pointsPerInterval: 5,
        endpoints: [{ slot: "AppUrl", outputKey: "PublicUrl" }],
      } as unknown as ProblemScoringMetadata;
      const result = score({
        scoring,
        outputs: { PublicUrl: "https://pub.example/" },
        probeResults: { "https://pub.example/": { status: 200, reachable: true } },
      });
      expect(result.outcome).toBe("success");
    });

    it("should skip an endpoint that declares neither slot nor outputKey", () => {
      const scoring = {
        kind: "uptime-flat",
        pointsPerInterval: 5,
        endpoints: [{}],
      } as unknown as ProblemScoringMetadata;
      const result = score({ scoring });
      expect(result).toEqual({ outcome: "success", diagnostics: [] });
    });
  });

  describe("uptime-multi", () => {
    const scoring = {
      kind: "uptime-multi",
      probedSlots: [{ slot: "ApiUrl", expectStatus: [200] }, { slot: "WebUrl" }],
    } as unknown as ProblemScoringMetadata;

    it("should succeed when every probed slot passes", () => {
      const result = score({
        scoring,
        outputs: { ApiUrl: "https://api.example/", WebUrl: "https://web.example/" },
        probeResults: {
          "https://api.example/": { status: 200, reachable: true },
          "https://web.example/": { status: 200, reachable: true },
        },
      });
      expect(result).toEqual({ outcome: "success", diagnostics: [] });
    });

    it("should be not-runnable when a probed slot's output is absent", () => {
      const result = score({ scoring, outputs: { ApiUrl: "https://api.example/" } });
      expect(result.outcome).toBe("not-runnable");
    });

    it("should collect a PROBE_FAILED diagnostic per failing slot", () => {
      const result = score({
        scoring,
        outputs: { ApiUrl: "https://api.example/", WebUrl: "https://web.example/" },
        probeResults: {
          "https://api.example/": { status: 503, reachable: true },
          "https://web.example/": { reachable: false },
        },
      });
      expect(result.outcome).toBe("failure");
      expect(result.diagnostics).toHaveLength(2);
    });
  });

  describe("composite-probe", () => {
    const scoring = {
      kind: "composite-probe",
      success: "all",
      pointsAllOk: 400,
      targets: [{ targetId: "aws", probe: "https", outputKey: "AwsUrl", expectStatus: [200] }],
    } as unknown as ProblemScoringMetadata;

    it("should be not-runnable with UNDECLARED_TARGET for an unknown targetId", () => {
      const result = score({ scoring, declaredTargetIds: ["gcp"] });
      expect(result.outcome).toBe("not-runnable");
      expect(result.diagnostics[0]?.code).toBe(SCORING_DIAGNOSTIC_CODES.UNDECLARED_TARGET);
    });

    it("should be not-runnable when a declared target's output key is absent", () => {
      const result = score({ scoring, declaredTargetIds: ["aws"] });
      expect(result.outcome).toBe("not-runnable");
      expect(result.diagnostics[0]?.code).toBe(SCORING_DIAGNOSTIC_CODES.MISSING_OUTPUT_KEY);
    });

    it("should fail with PROBE_FAILED when a target's probe misses", () => {
      const result = score({
        scoring,
        declaredTargetIds: ["aws"],
        outputs: { AwsUrl: "https://aws.example/" },
        probeResults: { "https://aws.example/": { status: 404, reachable: true } },
      });
      expect(result.outcome).toBe("failure");
      expect(result.diagnostics[0]?.code).toBe(SCORING_DIAGNOSTIC_CODES.PROBE_FAILED);
    });
  });

  describe("faked probe decision table", () => {
    const scoring = {
      kind: "uptime-multi",
      probedSlots: [{ slot: "Url" }],
    } as unknown as ProblemScoringMetadata;
    const outputs = { Url: "https://x.example/" };

    it("should fail when no probe result exists for the URL", () => {
      expect(score({ scoring, outputs }).outcome).toBe("failure");
    });

    it("should fail when the probe result has a non-numeric status", () => {
      const result = score({
        scoring,
        outputs,
        probeResults: { "https://x.example/": { reachable: true } },
      });
      expect(result.outcome).toBe("failure");
    });

    it("should default the expected statuses to [200] when none are declared", () => {
      const ok = score({
        scoring,
        outputs,
        probeResults: { "https://x.example/": { status: 200, reachable: true } },
      });
      expect(ok.outcome).toBe("success");
      const miss = score({
        scoring,
        outputs,
        probeResults: { "https://x.example/": { status: 204, reachable: true } },
      });
      expect(miss.outcome).toBe("failure");
    });
  });

  it("should be not-runnable with UNSUPPORTED_KIND for a kind outside the union", () => {
    const result = score({
      scoring: { kind: "made-up-kind" } as unknown as ProblemScoringMetadata,
    });
    expect(result.outcome).toBe("not-runnable");
    expect(result.diagnostics[0]?.code).toBe(SCORING_DIAGNOSTIC_CODES.UNSUPPORTED_KIND);
  });
});
