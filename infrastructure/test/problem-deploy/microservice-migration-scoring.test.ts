import { describe, expect, it } from "vitest";
import {
  computePhase,
  type MicroserviceMigrationPhase,
  type ProbeResult,
  resolveScorePath,
  scoreFromProbe,
} from "../../lib/problem-deploy/handlers/microservice-migration-poller-handler/scoring";

/**
 * Microservice Migration Battle (Phase 2) のスコア計算ロジックを pin する。
 *
 * 採点表 (issue #572 / #606):
 *   未登録 / 200 以外 / timeout: -100
 *   EC2 (劣化前):                +100
 *   EC2 (劣化後 = degradationMinutes 経過):  +10
 *   Lambda / ECS Fargate / App Runner:        +1000
 *   応答時間 > 1500ms ペナルティ:              -10 (= 採点と独立に減点)
 *
 * 3 slot 全てが non-ec2 になったら +5000 lump-sum bonus は store 側で one-shot 判定。
 */

describe("computePhase", () => {
  // 競技開始 = deploy createdAt
  const DEPLOYED_AT = "2026-05-12T10:00:00.000Z";

  it("0 分時点なら pre-degradation / score 経路", () => {
    expect(computePhase(DEPLOYED_AT, "2026-05-12T10:00:00.000Z", 60, 90)).toEqual({
      degraded: false,
      legacy: false,
    });
  });

  it("degradationMinutes 経過直後は degraded=true / legacy=false", () => {
    // 60 min ちょうど
    expect(computePhase(DEPLOYED_AT, "2026-05-12T11:00:00.000Z", 60, 90)).toEqual({
      degraded: true,
      legacy: false,
    });
  });

  it("legacySwitchMinutes 経過後は degraded=true / legacy=true", () => {
    // 90 min ちょうど
    expect(computePhase(DEPLOYED_AT, "2026-05-12T11:30:00.000Z", 60, 90)).toEqual({
      degraded: true,
      legacy: true,
    });
  });

  it("createdAt が無効な場合は pre-degradation 扱い (= 採点境界の安全側、競技開始直後扱い)", () => {
    expect(computePhase(undefined, "2026-05-12T15:00:00.000Z", 60, 90)).toEqual({
      degraded: false,
      legacy: false,
    });
  });
});

describe("resolveScorePath", () => {
  it("legacy=false なら /score を返すべき", () => {
    expect(resolveScorePath(false)).toBe("/score");
  });
  it("legacy=true なら /score?legacy=true を返すべき", () => {
    expect(resolveScorePath(true)).toBe("/score?legacy=true");
  });
});

describe("scoreFromProbe", () => {
  const phasePre: MicroserviceMigrationPhase = { degraded: false, legacy: false };
  const phasePost: MicroserviceMigrationPhase = { degraded: true, legacy: false };

  it("timeout / network error は -100 を返すべき", () => {
    const probe: ProbeResult = {
      ok: false,
      status: 0,
      responseTimeMs: 0,
      platform: undefined,
      reason: "timeout",
    };
    expect(scoreFromProbe(probe, phasePre)).toBe(-100);
  });

  it("non-200 は -100 を返すべき", () => {
    const probe: ProbeResult = {
      ok: false,
      status: 500,
      responseTimeMs: 100,
      platform: "ec2",
    };
    expect(scoreFromProbe(probe, phasePre)).toBe(-100);
  });

  it("EC2 / 劣化前 / 応答 OK は +100", () => {
    const probe: ProbeResult = { ok: true, status: 200, responseTimeMs: 50, platform: "ec2" };
    expect(scoreFromProbe(probe, phasePre)).toBe(100);
  });

  it("EC2 / 劣化後 / 応答 OK は +10", () => {
    const probe: ProbeResult = { ok: true, status: 200, responseTimeMs: 50, platform: "ec2" };
    expect(scoreFromProbe(probe, phasePost)).toBe(10);
  });

  it("Lambda / 応答 OK は +1000", () => {
    const probe: ProbeResult = {
      ok: true,
      status: 200,
      responseTimeMs: 50,
      platform: "lambda",
    };
    expect(scoreFromProbe(probe, phasePre)).toBe(1000);
  });

  it("ECS / 応答 OK は +1000", () => {
    const probe: ProbeResult = { ok: true, status: 200, responseTimeMs: 50, platform: "ecs" };
    expect(scoreFromProbe(probe, phasePost)).toBe(1000);
  });

  it("App Runner / 応答 OK は +1000", () => {
    const probe: ProbeResult = {
      ok: true,
      status: 200,
      responseTimeMs: 50,
      platform: "apprunner",
    };
    expect(scoreFromProbe(probe, phasePre)).toBe(1000);
  });

  it("応答時間が 1500ms 超なら追加で -10 ペナルティ (= score - 10)", () => {
    const probe: ProbeResult = {
      ok: true,
      status: 200,
      responseTimeMs: 1_600,
      platform: "lambda",
    };
    // +1000 - 10 = 990
    expect(scoreFromProbe(probe, phasePre)).toBe(990);
  });

  it("platform 未知 (= /meta の値が想定外) は EC2 と同じ扱いをすべき (= 移行未完了とみなす)", () => {
    const probe: ProbeResult = {
      ok: true,
      status: 200,
      responseTimeMs: 50,
      platform: "unknown",
    };
    expect(scoreFromProbe(probe, phasePre)).toBe(100);
  });
});
