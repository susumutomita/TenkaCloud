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
  it("初回 tick (= prev 未設定) は baseline 記録のみで加点しないべき", () => {
    const result = runAttackDetectionKind(buildInput("5", undefined));
    expect(result.scoreDelta).toBe(0);
    expect(result.scoreEvents).toEqual([]);
    expect(result.newState).toEqual({ attackCount: 5 });
  });

  it("counter が増えていれば差分 × pointsPerAttack を加点すべき", () => {
    // prev=5, current=8 → delta=3、 3 × 50 = 150 加点
    const result = runAttackDetectionKind(buildInput("8", 5));
    expect(result.scoreDelta).toBe(150);
    expect(result.scoreEvents).toEqual([{ source: "uptime", points: 150, occurredAt: NOW_ISO }]);
    expect(result.newState).toEqual({ attackCount: 8 });
  });

  it("counter が変化なし (= 攻撃が止まっている) なら加点 0、 baseline は維持すべき", () => {
    const result = runAttackDetectionKind(buildInput("5", 5));
    expect(result.scoreDelta).toBe(0);
    expect(result.scoreEvents).toEqual([]);
    expect(result.newState).toEqual({ attackCount: 5 });
  });

  it("counter が巻き戻った場合は加点 0、 baseline を新値に追従すべき", () => {
    // prev=10, current=3 (reset?) → 加点なし、 baseline=3
    const result = runAttackDetectionKind(buildInput("3", 10));
    expect(result.scoreDelta).toBe(0);
    expect(result.newState).toEqual({ attackCount: 3 });
  });

  it("statsOutputKey が stackOutputs に無いと noop (= deploy 未完了 / output 不在)", () => {
    const result = runAttackDetectionKind(buildInput(undefined, undefined));
    expect(result.scoreDelta).toBe(0);
    expect(result.scoreEvents).toEqual([]);
    expect(result.newState).toBeUndefined();
  });

  it("counter が数値以外なら noop (= 不正データ防御)", () => {
    const result = runAttackDetectionKind(buildInput("not-a-number", 5));
    expect(result.scoreDelta).toBe(0);
  });

  it("counter が負値なら noop (= 不正データ防御)", () => {
    const result = runAttackDetectionKind(buildInput("-1", 0));
    expect(result.scoreDelta).toBe(0);
  });
});
