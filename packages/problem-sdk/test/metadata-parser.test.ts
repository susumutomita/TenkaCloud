/**
 * [Problem SDK / Issue #2106] Direct unit tests for the pure phases / disruptions
 * metadata parsers — the durable public contract, tested in its own right.
 */

import { describe, expect, it } from "vitest";
import {
  parseDisruptionAction,
  parseDisruptionEffect,
  parseDisruptionEntry,
  parseDisruptionRecurrence,
  parseDisruptionsCatalogEnv,
  parseDisruptionTriggers,
  parsePhaseEntry,
} from "../src/metadata-parser.js";

describe("parsePhaseEntry", () => {
  it("should parse a phase with an effect and description", () => {
    expect(
      parsePhaseEntry({
        name: "ramp",
        afterMinutes: 30,
        description: "ramp up",
        effect: { scorePathOverride: "/score2", switchPlatformToDegraded: ["aws", 5] },
      }),
    ).toEqual({
      name: "ramp",
      afterMinutes: 30,
      description: "ramp up",
      effect: { scorePathOverride: "/score2", switchPlatformToDegraded: ["aws"] },
    });
  });

  it("should reject a phase missing name or afterMinutes", () => {
    expect(parsePhaseEntry(undefined)).toBeUndefined();
    expect(parsePhaseEntry({ afterMinutes: 1 })).toBeUndefined();
    expect(parsePhaseEntry({ name: "x" })).toBeUndefined();
  });
});

describe("parseDisruptionEffect", () => {
  it("should parse a penalty effect within bounds", () => {
    expect(parseDisruptionEffect({ kind: "penalty", points: 10, durationSeconds: 60 })).toEqual({
      kind: "penalty",
      points: 10,
      durationSeconds: 60,
    });
  });

  it("should reject a non-penalty kind, non-positive points, or over-cap duration", () => {
    expect(parseDisruptionEffect({ kind: "other", points: 1, durationSeconds: 1 })).toBeUndefined();
    expect(
      parseDisruptionEffect({ kind: "penalty", points: 0, durationSeconds: 1 }),
    ).toBeUndefined();
    expect(
      parseDisruptionEffect({ kind: "penalty", points: 1, durationSeconds: 3601 }),
    ).toBeUndefined();
  });
});

describe("parseDisruptionAction", () => {
  it("should parse an action with a revert", () => {
    expect(
      parseDisruptionAction({
        kind: "ssm-run-command",
        targetRef: "InstanceId",
        documentName: "AWS-RunShellScript",
        revert: { afterSeconds: 120 },
      }),
    ).toMatchObject({ kind: "ssm-run-command", targetRef: "InstanceId" });
  });

  it("should reject an unknown kind, empty targetRef, or missing revert", () => {
    expect(parseDisruptionAction({ kind: "nope", targetRef: "x", revert: {} })).toBeUndefined();
    expect(
      parseDisruptionAction({ kind: "lambda-invoke", targetRef: "", revert: { afterSeconds: 1 } }),
    ).toBeUndefined();
    expect(parseDisruptionAction({ kind: "cfn-stack-update", targetRef: "x" })).toBeUndefined();
  });
});

describe("parseDisruptionTriggers", () => {
  it("should parse each trigger kind and drop unknown ones", () => {
    expect(
      parseDisruptionTriggers([
        { kind: "after-deploy", afterMinutes: 10 },
        { kind: "team-score-above", threshold: 500 },
        { kind: "phase-entered", phaseName: "ramp" },
        { kind: "bogus" },
      ]),
    ).toEqual([
      { kind: "after-deploy", afterMinutes: 10 },
      { kind: "team-score-above", threshold: 500 },
      { kind: "phase-entered", phaseName: "ramp" },
    ]);
  });

  it("should return undefined for a non-array or an all-invalid list", () => {
    expect(parseDisruptionTriggers("x")).toBeUndefined();
    expect(parseDisruptionTriggers([{ kind: "bogus" }])).toBeUndefined();
  });
});

describe("parseDisruptionRecurrence", () => {
  it("should parse a recurrence within bounds", () => {
    expect(parseDisruptionRecurrence({ intervalMinutes: 5, maxFires: 3 })).toEqual({
      intervalMinutes: 5,
      maxFires: 3,
    });
  });

  it("should reject out-of-bounds or non-integer values", () => {
    expect(parseDisruptionRecurrence({ intervalMinutes: 0, maxFires: 1 })).toBeUndefined();
    expect(parseDisruptionRecurrence({ intervalMinutes: 1, maxFires: 61 })).toBeUndefined();
    expect(parseDisruptionRecurrence({ intervalMinutes: 1.5, maxFires: 1 })).toBeUndefined();
  });
});

describe("parseDisruptionEntry", () => {
  it("should parse a full disruption entry with sub-sections", () => {
    const entry = parseDisruptionEntry({
      id: "net-cut",
      name: "Network cut",
      eventDetailType: "NetworkCut",
      description: "cut the network",
      defaultAfterMinutes: 10,
      operatorEditable: ["targetRef", 7],
      parameters: { region: "us-east-1" },
      publicHint: true,
      triggers: [{ kind: "after-deploy", afterMinutes: 5 }],
      action: { kind: "lambda-invoke", targetRef: "Fn", revert: { afterSeconds: 30 } },
      effect: { kind: "penalty", points: 5, durationSeconds: 60 },
      recurrence: { intervalMinutes: 5, maxFires: 2 },
    });
    expect(entry).toMatchObject({ id: "net-cut", operatorEditable: ["targetRef"] });
    expect(entry?.triggers).toHaveLength(1);
    expect(entry?.action).toBeDefined();
    expect(entry?.effect).toBeDefined();
    expect(entry?.recurrence).toBeDefined();
  });

  it("should reject an entry missing id / name / eventDetailType", () => {
    expect(parseDisruptionEntry({ name: "x", eventDetailType: "y" })).toBeUndefined();
    expect(parseDisruptionEntry(undefined)).toBeUndefined();
  });
});

describe("parseDisruptionsCatalogEnv", () => {
  it("should decode a valid env map and reject broken / non-object input", () => {
    const json = JSON.stringify({ p1: [{ id: "d", name: "D", eventDetailType: "T" }] });
    expect(parseDisruptionsCatalogEnv(json)).toHaveProperty("p1");
    expect(parseDisruptionsCatalogEnv(undefined)).toEqual({});
    expect(parseDisruptionsCatalogEnv("not json")).toEqual({});
    expect(parseDisruptionsCatalogEnv("[]")).toEqual({});
  });
});
