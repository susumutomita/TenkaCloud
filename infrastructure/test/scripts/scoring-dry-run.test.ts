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

  it("uptime-multi kind: 未対応として ok=true で「未対応」を含むべき", () => {
    const r = runDryRun({ problemId: "security-battle-royale" });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain("unsupported");
  });

  it("存在しない問題 id で ok=false を返すべき", () => {
    const r = runDryRun({ problemId: "this-does-not-exist" });
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("not found");
  });
});
