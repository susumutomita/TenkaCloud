import { describe, expect, it } from "vitest";
import { runAttackDetectionDryRun } from "../../../scripts/problem-cli/dry-run/attack-detection";
import { runDryRun } from "../../../scripts/tenkacloud-problem";

/**
 * Issue #951 sub #3: scoring dry-run CLI が local で正しく score を算出することを保証する。
 * 既存問題 (hello-world / hello-world-battle / security-battle-royale) に対して、 各
 * kind が想定通りの earned points を返すことを観察する。
 */

describe("scoring dry-run (#951 sub #3)", () => {
  it("flag kind: should set earned=0 on wrong answer", () => {
    const r = runDryRun({ problemId: "hello-world", submitted: "wrong" });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain("不正解");
    expect(r.summary).toContain("earned=0");
  });

  it("flag kind: should deduct penalty on hint reveal (expected null when template has no static Value)", () => {
    // hello-world は !Sub なので extractFlag は null を返す → submitted との一致は常に false
    const r = runDryRun({ problemId: "hello-world", submitted: "anything", revealHints: 1 });
    expect(r.ok).toBe(true);
    const linesText = r.lines.join("\n");
    expect(linesText).toContain("hintsRevealed:  1");
  });

  it("uptime-flat kind: 全 success cycles で `cycles × endpoints × pointsPerSuccess` 点", () => {
    // hello-world-battle: 2 endpoints, 100 pt/success (failurePenalty=-100 だが全 success なので無関係)
    const r = runDryRun({ problemId: "hello-world-battle", cycles: 5, pattern: "sssss" });
    expect(r.ok).toBe(true);
    // 5 cycles × 2 endpoints × 100 pt = 1000
    expect(r.summary).toContain("earned=1000");
  });

  it("uptime-flat kind: earned should drop on cycles with partial fail (failurePenalty deducts)", () => {
    const r = runDryRun({ problemId: "hello-world-battle", cycles: 4, pattern: "ssff" });
    expect(r.ok).toBe(true);
    // hello-world-battle は failurePenalty=-100 (2 endpoints)。
    // 2 success × 2 × +100 = +400、 2 fail × 2 × -100 = -400 → 0。
    expect(r.summary).toContain("earned=0");
  });

  it("uptime-flat kind: cycles=デフォルト=10 / pattern=デフォルト=all success", () => {
    const r = runDryRun({ problemId: "hello-world-battle" });
    expect(r.ok).toBe(true);
    // 10 × 2 × 100 = 2000
    expect(r.summary).toContain("earned=2000");
  });

  // Issue #951 sub #3 拡張: uptime-multi / phased-polling / attack-detection の dry-run 対応

  it("uptime-multi kind: should return pointsAllOk × cycles for all-success cycles", () => {
    // security-battle-royale は uptime-multi、 pointsAllOk=100、 failurePenalty=0 想定
    const r = runDryRun({ problemId: "security-battle-royale", cycles: 5, pattern: "sssss" });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain("earned=500");
  });

  it("uptime-multi kind: earned should drop on partial fail", () => {
    const r = runDryRun({ problemId: "security-battle-royale", cycles: 4, pattern: "ssff" });
    expect(r.ok).toBe(true);
    // 2 allOk × 100 = 200 (failurePenalty=0)
    expect(r.summary).toContain("earned=200");
  });

  it("microservice-migration-battle (phased-polling): default pattern で earned が正の値", () => {
    // phased-polling は default で 全 cycle EC2 想定。 ec2.points が乗る (= 結果は正)
    const r = runDryRun({
      problemId: "microservice-migration-battle",
      cycles: 5,
      pattern: "eeeee",
    });
    expect(r.ok).toBe(true);
    // points > 0 を含むこと
    const m = r.summary.match(/earned=(-?\d+)/);
    expect(m?.[1]).toBeDefined();
    if (m?.[1]) {
      expect(Number.parseInt(m[1], 10)).toBeGreaterThan(0);
    }
  });

  it("phased-polling: cycle 数を超える phase 切替も pattern で simulate できる", () => {
    // 10 cycles 後に degraded phase に入る (= afterMinutes>=60 想定だが intervalMinutes=1)
    const r = runDryRun({
      problemId: "microservice-migration-battle",
      cycles: 65,
      pattern: "e".repeat(65),
    });
    expect(r.ok).toBe(true);
    // 後半は degradedPoints になるはず (= 累計 earned は 60 cycle full + 5 cycle degraded)
    expect(r.summary).toMatch(/phased-polling dry-run/);
  });

  it("should return ok=false for non-existent problem id", () => {
    const r = runDryRun({ problemId: "this-does-not-exist" });
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("not found");
  });

  describe("attack-detection kind (= synthetic fixture; #1248)", () => {
    // 既存 problems/ には attack-detection kind の 問題が存在しないため、 runDryRun (= dir 解決
    // 経由) ではなく runAttackDetectionDryRun を直接 invoke して branch を exercise する。
    const baseInput = (
      overrides: Partial<{
        pointsPerAttack: number;
        cycles: number;
        pattern: string;
      }>,
    ) => ({
      args: {
        problemId: "synthetic-attack-detection",
        cycles: overrides.cycles ?? undefined,
        pattern: overrides.pattern ?? undefined,
      },
      dir: "/tmp/synthetic",
      meta: {},
      scoring: { kind: "attack-detection", pointsPerAttack: overrides.pointsPerAttack ?? 50 },
      lines: [] as string[],
      kind: "attack-detection",
    });

    it("should compute earned = sum(deltas) × pointsPerAttack for digit pattern", () => {
      const r = runAttackDetectionDryRun(baseInput({ cycles: 5, pattern: "12345" }));
      // (1+2+3+4+5) × 50 = 750
      expect(r.ok).toBe(true);
      expect(r.summary).toContain("total 15 detections");
      expect(r.summary).toContain("earned=750");
    });

    it("should default pattern to all-1s when omitted", () => {
      const r = runAttackDetectionDryRun(baseInput({ cycles: 4, pointsPerAttack: 25 }));
      // 1 attack/cycle × 4 cycles × 25 = 100
      expect(r.summary).toContain("earned=100");
    });

    it("should skip invalid pattern chars (non-digit) without crashing", () => {
      const r = runAttackDetectionDryRun(baseInput({ cycles: 3, pattern: "2x3" }));
      // 2 + (skip) + 3 = 5 detections × 50 = 250
      expect(r.summary).toContain("earned=250");
      expect(r.lines.some((l) => l.includes('invalid char "x"'))).toBe(true);
    });

    it("should produce a length-mismatch note when pattern shorter than cycles", () => {
      const r = runAttackDetectionDryRun(baseInput({ cycles: 5, pattern: "11" }));
      expect(r.lines.some((l) => l.includes("pattern length (2) !== cycles (5)"))).toBe(true);
    });

    it("should emit zero earned when pointsPerAttack is 0", () => {
      const r = runAttackDetectionDryRun(
        baseInput({ cycles: 3, pattern: "999", pointsPerAttack: 0 }),
      );
      expect(r.summary).toContain("earned=0");
    });
  });
});
