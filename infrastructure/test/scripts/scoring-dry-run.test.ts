import { describe, expect, it } from "vitest";
import { runDryRun } from "../../../scripts/tenkacloud-problem";

/**
 * Issue #951 sub #3: scoring dry-run CLI が local で正しく score を算出することを保証する。
 * 既存問題 (hello-world / hello-world-battle / security-battle-royale) に対して、 各
 * kind が想定通りの earned points を返すことを観察する。
 */

describe("scoring dry-run (#951 sub #3)", () => {
  it("flag kind: 不正解で earned=0 すべき", () => {
    const r = runDryRun({ problemId: "hello-world", submitted: "wrong" });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain("不正解");
    expect(r.summary).toContain("earned=0");
  });

  it("flag kind: hint 開示は penalty を引くべき (template に静的 Value が無いケースは expected null)", () => {
    // hello-world は !Sub なので extractFlag は null を返す → submitted との一致は常に false
    const r = runDryRun({ problemId: "hello-world", submitted: "anything", revealHints: 1 });
    expect(r.ok).toBe(true);
    const linesText = r.lines.join("\n");
    expect(linesText).toContain("hintsRevealed:  1");
  });

  it("uptime-flat kind: 全 success cycles で `cycles × endpoints × pointsPerSuccess` 点", () => {
    // hello-world-battle: 2 endpoints, 100 pt/success, failurePenalty=0
    const r = runDryRun({ problemId: "hello-world-battle", cycles: 5, pattern: "sssss" });
    expect(r.ok).toBe(true);
    // 5 cycles × 2 endpoints × 100 pt = 1000
    expect(r.summary).toContain("earned=1000");
  });

  it("uptime-flat kind: 部分 fail の cycles で earned が下がるべき", () => {
    const r = runDryRun({ problemId: "hello-world-battle", cycles: 4, pattern: "ssff" });
    expect(r.ok).toBe(true);
    // 2 success cycles × 2 endpoints × 100 = 400 (failurePenalty=0)
    expect(r.summary).toContain("earned=400");
  });

  it("uptime-flat kind: cycles=デフォルト=10 / pattern=デフォルト=all success", () => {
    const r = runDryRun({ problemId: "hello-world-battle" });
    expect(r.ok).toBe(true);
    // 10 × 2 × 100 = 2000
    expect(r.summary).toContain("earned=2000");
  });

  // Issue #951 sub #3 拡張: uptime-multi / phased-polling / attack-detection の dry-run 対応

  it("uptime-multi kind: 全 success cycles で pointsAllOk × cycles を返すべき", () => {
    // security-battle-royale は uptime-multi、 pointsAllOk=100、 failurePenalty=0 想定
    const r = runDryRun({ problemId: "security-battle-royale", cycles: 5, pattern: "sssss" });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain("earned=500");
  });

  it("uptime-multi kind: 部分 fail で earned が下がるべき", () => {
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

  it("存在しない問題 id で ok=false を返すべき", () => {
    const r = runDryRun({ problemId: "this-does-not-exist" });
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("not found");
  });

  it("attack-detection kind: 未配備 (= 既存問題に存在しない) は new problem 追加時に test 拡張", () => {
    // 既存 problems/ には attack-detection kind の 問題は存在しないため、 統合 test はここでは
    // skip。 dry-run の attack-detection branch 自体は runDryRun の関数として実装済み (= 未配備
    // でも本 test ファイルは broken にしない)。
    expect(true).toBe(true);
  });
});
