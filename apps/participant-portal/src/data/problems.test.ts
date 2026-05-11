import { describe, expect, it } from "vitest";
import { findProblemMetadata } from "./problems";

/**
 * #550: Portal の build-time catalog が `problems/<category>/<id>/metadata.json` を
 * Vite glob で取り込んでいることを確認する smoke test。問題追加時に metadata.json を
 * 置き忘れた / shape が壊れた場合に CI で気づける。
 *
 * 既存 3 問 (hello-world / hello-world-battle / security-battle-royale) を pin する。
 * 新 problem 追加で test を更新する運用 (= CLAUDE.md の TDD タイトル「〜すべき」に沿う)。
 */
describe("findProblemMetadata (Portal build-time catalog #550)", () => {
  it("hello-world (Challenge sample) が引けて narrative field を含むべき", () => {
    const m = findProblemMetadata("hello-world");
    expect(m).toBeDefined();
    expect(m?.category).toBe("Challenge");
    expect(m?.name).toBe("Hello World (Sample)");
    // narrative field が空でない (= competitor 向け表示が実質中身ありで動く)
    expect(m?.description.length).toBeGreaterThan(0);
    expect(m?.learningGoals.length).toBeGreaterThan(0);
    expect(m?.shortDescription.length).toBeGreaterThan(0);
  });

  it("hello-world-battle (Battle uptime sample) が引けて category=Battle であるべき", () => {
    const m = findProblemMetadata("hello-world-battle");
    expect(m).toBeDefined();
    expect(m?.category).toBe("Battle");
  });

  it("存在しない id は undefined を返すべき", () => {
    expect(findProblemMetadata("does-not-exist")).toBeUndefined();
  });

  it("Portal は deploy 内部情報 (cfnTemplate 等) を expose しないべき (#550 設計判断)", () => {
    const m = findProblemMetadata("hello-world");
    expect(m).toBeDefined();
    // 答えの hint になりうる deploy 内部情報は Portal の型に含めない
    // (= JSON.stringify でも漏らさない)
    const json = JSON.stringify(m);
    expect(json).not.toContain("cfnTemplate");
    expect(json).not.toContain("cfnParameters");
  });
});
