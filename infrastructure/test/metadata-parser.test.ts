import { describe, expect, it } from "vitest";
import {
  DISRUPTION_ACTION_KINDS,
  DISRUPTION_EFFECT_MAX_DURATION_SECONDS,
  parseDisruptionEntry,
  parsePhaseEntry,
} from "../lib/utils/metadata-parser";

/**
 * SRP refactor (catalog-parser split): discover-problems-catalog.ts の pure parser を
 * metadata-parser.ts に切り出した。 本 test は新 module を **直接 import** して、
 * 旧 catalog file 経由ではなく単体で importable かつ挙動同一であることを pin する。
 *
 * parseDisruptionEntry / parsePhaseEntry は移設前 private だったため、 catalog 経由の
 * discover-problems-extractors.test.ts でしか間接 cover されていなかった。 移設で export 面に
 * 出たので、 ここで guard を直接 pin する (= INVARIANT_PR_TESTS_COUPLED_WITH_CHANGE)。
 */

describe("parsePhaseEntry", () => {
  it("should return a minimal phase when name and afterMinutes are present", () => {
    expect(parsePhaseEntry({ name: "spike", afterMinutes: 10 })).toEqual({
      name: "spike",
      afterMinutes: 10,
    });
  });

  it("should keep effect and description, filtering non-string degraded entries", () => {
    expect(
      parsePhaseEntry({
        name: "spike",
        afterMinutes: 30,
        description: "load spike",
        effect: {
          scorePathOverride: "/score-v2",
          switchPlatformToDegraded: ["web", 5, "api"],
        },
      }),
    ).toEqual({
      name: "spike",
      afterMinutes: 30,
      description: "load spike",
      effect: {
        scorePathOverride: "/score-v2",
        switchPlatformToDegraded: ["web", "api"],
      },
    });
  });

  it("should reject entries missing name or afterMinutes", () => {
    expect(parsePhaseEntry(undefined)).toBeUndefined();
    expect(parsePhaseEntry("spike")).toBeUndefined();
    expect(parsePhaseEntry({ name: "spike" })).toBeUndefined();
    expect(parsePhaseEntry({ afterMinutes: 10 })).toBeUndefined();
  });
});

describe("parseDisruptionEntry", () => {
  it("should parse a minimal disruption with the three required fields", () => {
    expect(
      parseDisruptionEntry({ id: "latency", name: "EC2 latency", eventDetailType: "Degraded" }),
    ).toEqual({ id: "latency", name: "EC2 latency", eventDetailType: "Degraded" });
  });

  it("should fold optional sub-sections (operatorEditable / parameters / effect)", () => {
    expect(
      parseDisruptionEntry({
        id: "latency",
        name: "EC2 latency",
        eventDetailType: "Degraded",
        defaultAfterMinutes: 5,
        operatorEditable: ["delayMs", 7],
        parameters: { delayMs: 200 },
        publicHint: true,
        effect: { kind: "penalty", points: 40, durationSeconds: 300 },
      }),
    ).toEqual({
      id: "latency",
      name: "EC2 latency",
      eventDetailType: "Degraded",
      defaultAfterMinutes: 5,
      operatorEditable: ["delayMs"],
      parameters: { delayMs: 200 },
      publicHint: true,
      effect: { kind: "penalty", points: 40, durationSeconds: 300 },
    });
  });

  it("should drop array-shaped parameters (typeof [] === object leak guard)", () => {
    const parsed = parseDisruptionEntry({
      id: "x",
      name: "x",
      eventDetailType: "x",
      parameters: ["nope"],
    });
    expect(parsed).toEqual({ id: "x", name: "x", eventDetailType: "x" });
  });

  it("should reject entries missing any required field", () => {
    expect(parseDisruptionEntry(undefined)).toBeUndefined();
    expect(parseDisruptionEntry({ id: "x", name: "x" })).toBeUndefined();
    expect(parseDisruptionEntry({ name: "x", eventDetailType: "x" })).toBeUndefined();
  });
});

describe("metadata-parser constants", () => {
  it("should expose the disruption action allow-list and effect duration cap", () => {
    expect(DISRUPTION_ACTION_KINDS).toEqual([
      "ssm-run-command",
      "lambda-invoke",
      "cfn-stack-update",
    ]);
    expect(DISRUPTION_EFFECT_MAX_DURATION_SECONDS).toBe(3600);
  });
});
