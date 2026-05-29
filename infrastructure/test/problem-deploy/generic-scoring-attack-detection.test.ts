import { describe, expect, it } from "vitest";
import { runAttackDetectionKind } from "../../lib/problem-deploy/handlers/generic-scoring-handler/kinds/attack-detection";
import type {
  KindHandlerInput,
  PhaseEntry,
} from "../../lib/problem-deploy/handlers/generic-scoring-handler/shared";
import type { AttackDetectionScoringMetadata } from "../../lib/utils/scoring-metadata";

/**
 * `attack-detection` kind (= CFn Output 内 counter 値の増分で加点)。
 * 初回 tick は baseline 記録のみ、 2 回目以降 (= prev に attackCount あり) で差分加算する。
 */

const NOW_ISO = "2026-05-12T10:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);

function buildInput(
  attackCounter: string | undefined,
  prevAttackCount: number | undefined,
  overrides: Partial<KindHandlerInput<AttackDetectionScoringMetadata>> = {},
): KindHandlerInput<AttackDetectionScoringMetadata> {
  return {
    deployment: {
      PK: "DEPLOYMENT#JOB1",
      jobId: "JOB1",
      problemId: "security-battle-royale",
      tenantId: "tenant-acme",
      teamId: "team-1",
      eventId: "event-1",
      stackOutputs:
        attackCounter !== undefined
          ? JSON.stringify({ AttackCounter: attackCounter })
          : JSON.stringify({}),
      expiresAt: 9_999_999_999,
    },
    scoring: {
      kind: "attack-detection",
      statsOutputKey: "AttackCounter",
      pointsPerAttack: 50,
    },
    slots: [],
    overrides: [],
    phases: [] as readonly PhaseEntry[],
    nowMs: NOW_MS,
    nowIso: NOW_ISO,
    prevState: prevAttackCount !== undefined ? { attackCount: prevAttackCount } : {},
    ...overrides,
  };
}

describe("attack-detection kind", () => {
  it("first tick (prev unset) should only record baseline without awarding", () => {
    const result = runAttackDetectionKind(buildInput("5", undefined));
    expect(result.scoreDelta).toBe(0);
    expect(result.scoreEvents).toEqual([]);
    expect(result.newState).toEqual({ attackCount: 5 });
  });

  it("should award delta × pointsPerAttack when the counter increases", () => {
    // prev=5, current=8 → delta=3、 3 × 50 = 150 加点
    const result = runAttackDetectionKind(buildInput("8", 5));
    expect(result.scoreDelta).toBe(150);
    expect(result.scoreEvents).toEqual([{ source: "uptime", points: 150, occurredAt: NOW_ISO }]);
    expect(result.newState).toEqual({ attackCount: 8 });
  });

  it("should award 0 and keep the baseline when the counter is unchanged (attack stopped)", () => {
    const result = runAttackDetectionKind(buildInput("5", 5));
    expect(result.scoreDelta).toBe(0);
    expect(result.scoreEvents).toEqual([]);
    expect(result.newState).toEqual({ attackCount: 5 });
  });

  it("should award 0 and follow the new baseline when the counter rewinds", () => {
    // prev=10, current=3 (reset?) → 加点なし、 baseline=3
    const result = runAttackDetectionKind(buildInput("3", 10));
    expect(result.scoreDelta).toBe(0);
    expect(result.newState).toEqual({ attackCount: 3 });
  });

  it("should noop when statsOutputKey is missing from stackOutputs (deploy not yet complete / output absent)", () => {
    const result = runAttackDetectionKind(buildInput(undefined, undefined));
    expect(result.scoreDelta).toBe(0);
    expect(result.scoreEvents).toEqual([]);
    expect(result.newState).toBeUndefined();
  });

  it("should noop when counter is non-numeric (invalid-data guard)", () => {
    const result = runAttackDetectionKind(buildInput("not-a-number", 5));
    expect(result.scoreDelta).toBe(0);
  });

  it("should noop when counter is negative (invalid-data guard)", () => {
    const result = runAttackDetectionKind(buildInput("-1", 0));
    expect(result.scoreDelta).toBe(0);
  });

  it("should noop when counter is empty (Number('') = 0 baseline pollution guard)", () => {
    const result = runAttackDetectionKind(buildInput("", 5));
    expect(result.scoreDelta).toBe(0);
    expect(result.newState).toBeUndefined();
  });

  it("should noop when counter is a decimal (invalid-data guard)", () => {
    const result = runAttackDetectionKind(buildInput("1.5", 1));
    expect(result.scoreDelta).toBe(0);
  });

  it("#1389: should clamp the per-tick award when the counter jumps by a huge delta (self-award guard)", () => {
    // 競技者が CFn Output に 1e9 を仕込んでも 1 tick の加点は 100 × pointsPerAttack に制限される。
    const result = runAttackDetectionKind(buildInput("1000000000", 0));
    expect(result.scoreDelta).toBe(100 * 50); // MAX_ATTACK_DELTA_PER_TICK × pointsPerAttack
    expect(result.scoreEvents).toEqual([{ source: "uptime", points: 5000, occurredAt: NOW_ISO }]);
    // baseline は実値に追従するので次 tick は delta=0 (= 巨大ジャンプを再加算しない)
    expect(result.newState).toEqual({ attackCount: 1000000000 });
  });

  it("#1389: should award the exact delta when it is at or below the per-tick cap", () => {
    // delta=100 (= cap ちょうど) は満額、 clamp の境界を確認
    const result = runAttackDetectionKind(buildInput("100", 0));
    expect(result.scoreDelta).toBe(100 * 50);
    expect(result.newState).toEqual({ attackCount: 100 });
  });
});
