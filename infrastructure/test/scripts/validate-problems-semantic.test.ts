import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkDisruptionTriggerRefs,
  checkFlagSemantics,
  checkPhaseTimeline,
  checkUptimeMultiSemantics,
} from "../../../scripts/lib/semantic-check";
import { checkCrossRefs } from "../../../scripts/validate-problems";

/**
 * Issue #1777: JSON Schema が構造を保証した後の field 間整合性 (= semantic rules) を
 * validate-problems が enforce することを保証する。 fixture はすべて inline (実カタログ非依存)。
 *
 *   - uptime-multi: probedSlots[].slot の一意性 / endpoints[].slot への参照解決 / weight の正値
 *   - phased-polling: phases[] の昇順 (= time-ordered, non-overlapping) と name の一意性
 *   - disruptions: triggers[].phase-entered の phaseName が phases[].name に実在
 *   - flag: flagOutputKey 非空 / points 正値 / wrongAnswerPenalty 整合 / hints penalty 合計 < points
 */

describe("checkUptimeMultiSemantics (#1777)", () => {
  const wellFormed = () => ({
    endpoints: [
      { slot: "frontend", default: { from: "cfn-output", key: "FrontendUrl" } },
      { slot: "api", default: { from: "cfn-output", key: "ApiUrl" } },
    ],
    scoring: {
      kind: "uptime-multi",
      probedSlots: [
        { slot: "frontend", path: "/", expectStatus: [200] },
        { slot: "api", path: "/api/v1/apistatus", expectStatus: [200] },
      ],
      pointsAllOk: 100,
      failurePenalty: 0,
      attackBlocked: { slot: "api", path: "/api/v1/blocked", pointsPerBlock: 10 },
      attackProbes: [
        { slot: "api", path: "/api/v1/auth", method: "POST", vulnerableStatus: [200], penalty: 50 },
      ],
    },
  });

  it("should pass a well-formed uptime-multi scoring with unique probed slots", () => {
    expect(checkUptimeMultiSemantics(wellFormed())).toEqual([]);
  });

  it("should be a no-op for non-uptime-multi kinds", () => {
    expect(
      checkUptimeMultiSemantics({
        scoring: { kind: "flag", flagOutputKey: "AnswerFlag", points: 100 },
      }),
    ).toEqual([]);
    expect(checkUptimeMultiSemantics({})).toEqual([]);
  });

  it("should reject duplicate probedSlots slot names", () => {
    const meta = wellFormed();
    meta.scoring.probedSlots.push({ slot: "api", path: "/other", expectStatus: [200] });
    const errs = checkUptimeMultiSemantics(meta);
    expect(errs.some((e) => e.includes('slot="api"') && e.includes("duplicated"))).toBe(true);
  });

  it("should reject a probedSlot referencing an undeclared endpoint slot", () => {
    const meta = wellFormed();
    meta.scoring.probedSlots[1].slot = "database";
    const errs = checkUptimeMultiSemantics(meta);
    expect(
      errs.some((e) => e.includes('slot="database"') && e.includes("not declared in endpoints[]")),
    ).toBe(true);
  });

  it("should reject attackBlocked / attackProbes referencing undeclared slots", () => {
    const meta = wellFormed();
    meta.scoring.attackBlocked.slot = "ghost-blocked";
    meta.scoring.attackProbes[0].slot = "ghost-probe";
    const errs = checkUptimeMultiSemantics(meta);
    expect(errs.some((e) => e.includes("attackBlocked") && e.includes("ghost-blocked"))).toBe(true);
    expect(errs.some((e) => e.includes("attackProbes") && e.includes("ghost-probe"))).toBe(true);
  });

  it("should reject probed slots when the problem declares no endpoints at all", () => {
    const meta = wellFormed() as Record<string, unknown>;
    delete meta.endpoints;
    const errs = checkUptimeMultiSemantics(meta);
    expect(errs.some((e) => e.includes("not declared in endpoints[]"))).toBe(true);
  });

  it("should reject non-positive weights (pointsAllOk / pointsPerBlock / penalty)", () => {
    const meta = wellFormed();
    meta.scoring.pointsAllOk = 0;
    meta.scoring.attackBlocked.pointsPerBlock = -5;
    meta.scoring.attackProbes[0].penalty = Number.NaN;
    const errs = checkUptimeMultiSemantics(meta);
    expect(errs.some((e) => e.includes("pointsAllOk") && e.includes("positive"))).toBe(true);
    expect(errs.some((e) => e.includes("pointsPerBlock") && e.includes("positive"))).toBe(true);
    expect(errs.some((e) => e.includes("attackProbes[0].penalty") && e.includes("positive"))).toBe(
      true,
    );
  });
});

describe("checkPhaseTimeline (#1777)", () => {
  const phases = () => [
    { name: "degraded", afterMinutes: 60, effect: { switchPlatformToDegraded: ["ec2"] } },
    { name: "legacy", afterMinutes: 90, effect: { scorePathOverride: "/score?legacy=true" } },
  ];

  it("should pass phases declared in strictly ascending afterMinutes order with unique names", () => {
    expect(checkPhaseTimeline({ phases: phases() })).toEqual([]);
  });

  it("should be a no-op when no phases are declared", () => {
    expect(checkPhaseTimeline({})).toEqual([]);
    expect(checkPhaseTimeline({ phases: [] })).toEqual([]);
  });

  it("should reject duplicate phase names", () => {
    const p = phases();
    p[1].name = "degraded";
    const errs = checkPhaseTimeline({ phases: p });
    expect(errs.some((e) => e.includes('name="degraded"') && e.includes("duplicated"))).toBe(true);
  });

  it("should reject phases that are not time-ordered (descending afterMinutes)", () => {
    const p = phases();
    p[0].afterMinutes = 90;
    p[1].afterMinutes = 60;
    const errs = checkPhaseTimeline({ phases: p });
    expect(errs.some((e) => e.includes("ascending") && e.includes("afterMinutes"))).toBe(true);
  });

  it("should reject overlapping phases (equal afterMinutes)", () => {
    const p = phases();
    p[1].afterMinutes = p[0].afterMinutes;
    const errs = checkPhaseTimeline({ phases: p });
    expect(errs.some((e) => e.includes("ascending") && e.includes("afterMinutes"))).toBe(true);
  });
});

describe("checkDisruptionTriggerRefs (#1777)", () => {
  const meta = (phaseName: string) => ({
    phases: [
      { name: "degraded", afterMinutes: 60, effect: {} },
      { name: "legacy", afterMinutes: 90, effect: {} },
    ],
    disruptions: [
      {
        id: "latency-injection",
        name: "Latency",
        eventDetailType: "DisruptionFired",
        triggers: [
          { kind: "after-deploy", afterMinutes: 30 },
          { kind: "phase-entered", phaseName },
        ],
      },
    ],
  });

  it("should pass when a phase-entered trigger references a declared phase", () => {
    expect(checkDisruptionTriggerRefs(meta("degraded"))).toEqual([]);
  });

  it("should be a no-op when disruptions declare no triggers", () => {
    expect(
      checkDisruptionTriggerRefs({
        disruptions: [{ id: "x", name: "X", eventDetailType: "X" }],
      }),
    ).toEqual([]);
    expect(checkDisruptionTriggerRefs({})).toEqual([]);
  });

  it("should reject a phase-entered trigger referencing an unknown phase and name the disruption", () => {
    const errs = checkDisruptionTriggerRefs(meta("ghost-phase"));
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("disruptions[id=latency-injection]");
    expect(errs[0]).toContain('phaseName="ghost-phase"');
  });
});

describe("checkFlagSemantics (#1777)", () => {
  const wellFormed = () => ({
    scoring: {
      kind: "flag",
      flagOutputKey: "AnswerFlag",
      points: 300,
      wrongAnswerPenalty: 15,
      hints: [
        { id: "hint-1", content: "look at the route table", penalty: 20 },
        { id: "hint-2", content: "check the SG", penalty: 50 },
        { id: "hint-3", content: "the answer is in SSM", penalty: 100 },
      ],
    },
  });

  it("should pass a well-formed flag scoring", () => {
    expect(checkFlagSemantics(wellFormed())).toEqual([]);
  });

  it("should be a no-op for non-flag kinds", () => {
    expect(
      checkFlagSemantics({
        scoring: { kind: "uptime-flat", endpoints: [], pointsPerSuccess: 1 },
      }),
    ).toEqual([]);
    expect(checkFlagSemantics({})).toEqual([]);
  });

  it("should reject an empty flagOutputKey (it would degenerately pass the Outputs cross-ref)", () => {
    const meta = wellFormed();
    meta.scoring.flagOutputKey = "";
    const errs = checkFlagSemantics(meta);
    expect(errs.some((e) => e.includes("flagOutputKey") && e.includes("non-empty"))).toBe(true);
  });

  it("should reject non-positive points", () => {
    const meta = wellFormed();
    meta.scoring.points = 0;
    expect(
      checkFlagSemantics(meta).some((e) => e.includes("points") && e.includes("positive")),
    ).toBe(true);
  });

  it("should loudly reject a wrongAnswerPenalty the platform would silently drop", () => {
    // parseFlag (scoring-metadata.ts) は負値 / 非整数 / 非数値を黙って undefined に倒す。
    // 出題時に validator が止めることで silent fallback を踏ませない。
    for (const bad of [-1, 1.5, Number.NaN]) {
      const meta = wellFormed();
      meta.scoring.wrongAnswerPenalty = bad;
      expect(
        checkFlagSemantics(meta).some((e) => e.includes("wrongAnswerPenalty")),
        `wrongAnswerPenalty=${bad} should be rejected`,
      ).toBe(true);
    }
  });

  it("should reject hint penalties whose total reaches the flag points", () => {
    const meta = wellFormed();
    meta.scoring.hints[2].penalty = 230; // 20 + 50 + 230 = 300 = points
    const errs = checkFlagSemantics(meta);
    expect(errs.some((e) => e.includes("hints") && e.includes("points"))).toBe(true);
  });

  it("should accept legacy v1 string hints (penalty 0)", () => {
    const meta = wellFormed() as { scoring: Record<string, unknown> };
    meta.scoring.hints = ["plain text hint", "another one"];
    expect(checkFlagSemantics(meta as Record<string, unknown>)).toEqual([]);
  });
});

describe("checkCrossRefs wiring of semantic rules (#1777)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "semantic-check-"));
    writeFileSync(
      join(dir, "template.yaml"),
      "Resources:\n  Noop:\n    Type: AWS::CloudFormation::WaitConditionHandle\nOutputs:\n  FrontendUrl:\n    Value: x\n  ApiUrl:\n    Value: y\n",
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("should surface semantic errors through checkCrossRefs", () => {
    const meta = {
      id: "fixture-problem",
      cfnTemplate: "template.yaml",
      endpoints: [
        { slot: "frontend", default: { from: "cfn-output", key: "FrontendUrl" } },
        { slot: "api", default: { from: "cfn-output", key: "ApiUrl" } },
      ],
      scoring: {
        kind: "uptime-multi",
        probedSlots: [
          { slot: "frontend", path: "/", expectStatus: [200] },
          { slot: "frontend", path: "/", expectStatus: [200] },
        ],
        pointsAllOk: 100,
      },
    };
    const errs = checkCrossRefs(join(dir, "metadata.json"), meta);
    expect(errs.some((e) => e.includes('slot="frontend"') && e.includes("duplicated"))).toBe(true);
  });
});
