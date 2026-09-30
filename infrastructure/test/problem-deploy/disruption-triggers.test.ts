import { describe, expect, it } from "vitest";
import type { PhaseEntry } from "../../../scripts/lib/scoring-common";
import {
  parseScoringState,
  resolveActivePhase,
} from "../../lib/problem-deploy/handlers/generic-scoring-handler/scoring-kernel";
import {
  type ProblemDisruptionEntry,
  parseDisruptionAction,
  parseDisruptionEffect,
  parseDisruptionsCatalogEnv,
  parseDisruptionTriggers,
} from "../../lib/utils/discover-problems-catalog";

/**
 * #1422: condition-triggered disruption の純粋ロジックを pin する。
 * - catalog の triggers[] / env パース
 * - trigger 単体判定 + OR 評価 + idempotency 抑制 + phase 解決
 * - scoringState の firedDisruptions persist / parse + resolveActivePhase 共有
 */

const baseDisruption = (over: Partial<ProblemDisruptionEntry> = {}): ProblemDisruptionEntry => ({
  id: "latency",
  name: "EC2 latency",
  eventDetailType: "DegradedDisruptionFired",
  parameters: { delayMs: 200 },
  ...over,
});

describe("parseDisruptionTriggers", () => {
  it("should parse the three supported trigger kinds and drop unknown / malformed", () => {
    const parsed = parseDisruptionTriggers([
      { kind: "after-deploy", afterMinutes: 60 },
      { kind: "team-score-above", threshold: 5000 },
      { kind: "phase-entered", phaseName: "degraded" },
      { kind: "after-deploy" }, // missing afterMinutes → drop
      { kind: "team-score-above", threshold: "nope" }, // wrong type → drop
      { kind: "unknown-kind", x: 1 }, // unknown → drop
      "not-an-object",
    ]);
    expect(parsed).toEqual([
      { kind: "after-deploy", afterMinutes: 60 },
      { kind: "team-score-above", threshold: 5000 },
      { kind: "phase-entered", phaseName: "degraded" },
    ]);
  });

  it("should return undefined for a non-array or all-invalid input", () => {
    expect(parseDisruptionTriggers(undefined)).toBeUndefined();
    expect(parseDisruptionTriggers("x")).toBeUndefined();
    expect(parseDisruptionTriggers([{ kind: "bogus" }])).toBeUndefined();
  });
});

describe("parseDisruptionAction (#1419)", () => {
  it("should parse a well-formed action carrying optional fields and a required revert", () => {
    const action = parseDisruptionAction({
      kind: "ssm-run-command",
      targetRef: "WorkerInstanceIds",
      documentName: "AWS-RunShellScript",
      paramTemplate: { commands: ["tc qdisc add dev {{device}} root netem delay {{delayMs}}ms"] },
      revert: { afterSeconds: 600, documentName: "AWS-RunShellScript" },
    });
    expect(action).toEqual({
      kind: "ssm-run-command",
      targetRef: "WorkerInstanceIds",
      documentName: "AWS-RunShellScript",
      paramTemplate: { commands: ["tc qdisc add dev {{device}} root netem delay {{delayMs}}ms"] },
      revert: { afterSeconds: 600, documentName: "AWS-RunShellScript" },
    });
  });

  it("should carry the lambda-invoke functionRef and drop unknown extra fields", () => {
    const action = parseDisruptionAction({
      kind: "lambda-invoke",
      targetRef: "FaultFunctionName",
      functionRef: "FaultFunctionName",
      revert: { afterSeconds: 30 },
      bogus: "ignored",
    });
    expect(action).toEqual({
      kind: "lambda-invoke",
      targetRef: "FaultFunctionName",
      functionRef: "FaultFunctionName",
      revert: { afterSeconds: 30 },
    });
  });

  it("should fail-safe to undefined when the kind is not in the allow-list", () => {
    expect(
      parseDisruptionAction({ kind: "rm-rf", targetRef: "X", revert: { afterSeconds: 1 } }),
    ).toBeUndefined();
  });

  it("should fail-safe to undefined when targetRef is missing or empty", () => {
    expect(
      parseDisruptionAction({ kind: "cfn-stack-update", revert: { afterSeconds: 1 } }),
    ).toBeUndefined();
    expect(
      parseDisruptionAction({
        kind: "cfn-stack-update",
        targetRef: "",
        revert: { afterSeconds: 1 },
      }),
    ).toBeUndefined();
  });

  it("should fail-safe to undefined when revert is missing or afterSeconds is non-positive / non-finite", () => {
    expect(parseDisruptionAction({ kind: "lambda-invoke", targetRef: "X" })).toBeUndefined();
    expect(
      parseDisruptionAction({ kind: "lambda-invoke", targetRef: "X", revert: { afterSeconds: 0 } }),
    ).toBeUndefined();
    expect(
      parseDisruptionAction({
        kind: "lambda-invoke",
        targetRef: "X",
        revert: { afterSeconds: Number.POSITIVE_INFINITY },
      }),
    ).toBeUndefined();
    expect(
      parseDisruptionAction({
        kind: "lambda-invoke",
        targetRef: "X",
        revert: { afterSeconds: "600" },
      }),
    ).toBeUndefined();
  });

  it("should fail-safe to undefined for non-object / array / null input", () => {
    expect(parseDisruptionAction(undefined)).toBeUndefined();
    expect(parseDisruptionAction(null)).toBeUndefined();
    expect(parseDisruptionAction("x")).toBeUndefined();
    expect(parseDisruptionAction([{ kind: "ssm-run-command" }])).toBeUndefined();
  });

  it("should drop a non-object paramTemplate / revert.paramTemplate but keep the action", () => {
    const action = parseDisruptionAction({
      kind: "ssm-run-command",
      targetRef: "X",
      paramTemplate: ["not", "an", "object"],
      revert: { afterSeconds: 5, paramTemplate: "nope" },
    });
    expect(action).toEqual({
      kind: "ssm-run-command",
      targetRef: "X",
      revert: { afterSeconds: 5 },
    });
  });
});

describe("parseDisruptionEffect (#1665)", () => {
  it("should parse a valid penalty effect", () => {
    expect(parseDisruptionEffect({ kind: "penalty", points: 40, durationSeconds: 300 })).toEqual({
      kind: "penalty",
      points: 40,
      durationSeconds: 300,
    });
  });

  it("should fail-safe to undefined for an unknown kind", () => {
    expect(
      parseDisruptionEffect({ kind: "unavailability", points: 1, durationSeconds: 1 }),
    ).toBeUndefined();
  });

  it("should reject non-positive / non-finite points", () => {
    expect(
      parseDisruptionEffect({ kind: "penalty", points: 0, durationSeconds: 60 }),
    ).toBeUndefined();
    expect(
      parseDisruptionEffect({ kind: "penalty", points: -5, durationSeconds: 60 }),
    ).toBeUndefined();
    expect(
      parseDisruptionEffect({ kind: "penalty", points: "40", durationSeconds: 60 }),
    ).toBeUndefined();
  });

  it("should reject duration <= 0 or above the 1h cap", () => {
    expect(
      parseDisruptionEffect({ kind: "penalty", points: 1, durationSeconds: 0 }),
    ).toBeUndefined();
    expect(
      parseDisruptionEffect({ kind: "penalty", points: 1, durationSeconds: 3601 }),
    ).toBeUndefined();
    expect(parseDisruptionEffect({ kind: "penalty", points: 1, durationSeconds: 3600 })).toEqual({
      kind: "penalty",
      points: 1,
      durationSeconds: 3600,
    });
  });

  it("should fail-safe to undefined for non-object / array / null input", () => {
    expect(parseDisruptionEffect(undefined)).toBeUndefined();
    expect(parseDisruptionEffect(null)).toBeUndefined();
    expect(parseDisruptionEffect("penalty")).toBeUndefined();
    expect(parseDisruptionEffect([{ kind: "penalty" }])).toBeUndefined();
  });

  it("should preserve a declared effect through the catalog env round-trip", () => {
    const env = JSON.stringify({
      p1: [baseDisruption({ effect: { kind: "penalty", points: 10, durationSeconds: 120 } })],
    });
    expect(parseDisruptionsCatalogEnv(env).p1?.[0]?.effect).toEqual({
      kind: "penalty",
      points: 10,
      durationSeconds: 120,
    });
  });
});

describe("parseDisruptionsCatalogEnv", () => {
  it("should parse a serialized catalog env", () => {
    const env = JSON.stringify({
      p1: [baseDisruption({ triggers: [{ kind: "after-deploy", afterMinutes: 1 }] })],
    });
    const parsed = parseDisruptionsCatalogEnv(env);
    expect(parsed.p1?.[0]?.triggers?.[0]).toEqual({ kind: "after-deploy", afterMinutes: 1 });
  });

  it("should return an empty map for unset / malformed / non-object JSON", () => {
    expect(parseDisruptionsCatalogEnv(undefined)).toEqual({});
    expect(parseDisruptionsCatalogEnv("{not json")).toEqual({});
    expect(parseDisruptionsCatalogEnv("[]")).toEqual({});
    expect(parseDisruptionsCatalogEnv("null")).toEqual({});
  });
});

describe("resolveActivePhase (shared, used by phased-polling + triggers)", () => {
  it("should return the last phase whose afterMinutes <= elapsed, defensively sorted", () => {
    const phases: readonly PhaseEntry[] = [
      { name: "degraded", afterMinutes: 20 },
      { name: "normal", afterMinutes: 0 },
    ];
    expect(resolveActivePhase(phases, 5)?.name).toBe("normal");
    expect(resolveActivePhase(phases, 25)?.name).toBe("degraded");
    expect(resolveActivePhase([], 10)).toBeUndefined();
  });
});

describe("parseScoringState firedDisruptions (#1422 idempotency record)", () => {
  it("should round-trip firedDisruptions string[]", () => {
    expect(parseScoringState(JSON.stringify({ firedDisruptions: ["a", "b", 3] }))).toEqual({
      firedDisruptions: ["a", "b"],
    });
  });
  it("should omit firedDisruptions when absent / empty / not an array", () => {
    expect(parseScoringState(JSON.stringify({ attackCount: 1 }))).toEqual({ attackCount: 1 });
    expect(parseScoringState(JSON.stringify({ firedDisruptions: [] }))).toEqual({});
    expect(parseScoringState(JSON.stringify({ firedDisruptions: "x" }))).toEqual({});
  });
});
