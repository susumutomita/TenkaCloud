import { describe, expect, it } from "vitest";
import { findProblemMetadata, resolveLocalizedNarrative } from "./problems";

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

  // ADR-012 Phase 4: phases / disruptions を portal が予告 panel に出すための data shape pin。
  it("microservice-migration-battle で phases / disruptions が露出されるべき (ADR-012 Phase 4)", () => {
    const m = findProblemMetadata("microservice-migration-battle");
    expect(m).toBeDefined();
    expect(m?.phases.length).toBeGreaterThanOrEqual(2);
    expect(m?.phases.map((p) => p.name)).toEqual(expect.arrayContaining(["degraded", "legacy"]));
    expect(m?.disruptions.length).toBeGreaterThanOrEqual(1);
    expect(m?.disruptions[0]?.id).toBe("ec2-latency-injection");
    expect(m?.disruptions[0]?.defaultAfterMinutes).toBe(60);
  });

  it("phases / disruptions に operator 内部 field (effect / parameters / eventDetailType) を露出しないべき", () => {
    const m = findProblemMetadata("microservice-migration-battle");
    const json = JSON.stringify(m);
    // 採点 internals / Phase 2 用 trigger 情報は競技者には不要 (= 答えの hint や noise 防止)
    expect(json).not.toContain("eventDetailType");
    expect(json).not.toContain("operatorEditable");
    expect(json).not.toContain("switchPlatformToDegraded");
    expect(json).not.toContain("scorePathOverride");
  });

  it("phases / disruptions が無い問題は空配列を返すべき", () => {
    const m = findProblemMetadata("hello-world");
    expect(m?.phases).toEqual([]);
    expect(m?.disruptions).toEqual([]);
  });

  // ADR-012 Phase 5: endpoints[] を portal plugin が build-time catalog から直接読めることを pin。
  it("microservice-migration-battle で endpoints[] が露出されるべき (ADR-012 Phase 5)", () => {
    const m = findProblemMetadata("microservice-migration-battle");
    expect(m?.endpoints).toHaveLength(3);
    expect(m?.endpoints.map((e) => e.slot)).toEqual(
      expect.arrayContaining(["users", "orders", "catalog"]),
    );
    const users = m?.endpoints.find((e) => e.slot === "users");
    expect(users?.default.key).toBe("BaseUrl");
    expect(users?.default.appendPath).toBe("/users");
    expect(users?.overridable).toBe(true);
  });

  it("endpoints[] が無い問題は空配列を返すべき", () => {
    expect(findProblemMetadata("hello-world")?.endpoints).toEqual([]);
  });

  // Issue #583 Phase 5: i18n override の locale fallback chain。
  describe("resolveLocalizedNarrative (Phase 5)", () => {
    it("locale='ja' なら top-level の値をそのまま返すべき", () => {
      const m = findProblemMetadata("hello-world");
      const r = resolveLocalizedNarrative(m!, "ja");
      expect(r.name).toBe("Hello World (Sample)");
      expect(r.description).toContain("Challenge / flag 提出形式");
    });

    it("locale='en' の override が宣言されていれば英語を返すべき (hello-world)", () => {
      const m = findProblemMetadata("hello-world");
      const r = resolveLocalizedNarrative(m!, "en");
      expect(r.shortDescription).toMatch(/Minimal Challenge/);
      expect(r.description).toMatch(/Deploying creates a single SSM Parameter/);
      expect(r.learningGoals.length).toBeGreaterThanOrEqual(2);
    });

    it("locale='zh' の override が宣言されていれば中文を返すべき (hello-world)", () => {
      const m = findProblemMetadata("hello-world");
      const r = resolveLocalizedNarrative(m!, "zh");
      expect(r.name).toContain("示例");
    });

    it("全 4 既存問題が en / es / zh の翻訳を持つべき (Phase 5.A + 5.C 完了)", () => {
      for (const id of [
        "hello-world",
        "hello-world-battle",
        "security-battle-royale",
        "microservice-migration-battle",
      ]) {
        const m = findProblemMetadata(id);
        expect(m?.i18n?.en?.name).toBeTruthy();
        expect(m?.i18n?.es?.name).toBeTruthy();
        expect(m?.i18n?.zh?.name).toBeTruthy();
        expect(m?.i18n?.en?.learningGoals?.length ?? 0).toBeGreaterThan(0);
      }
    });

    it("security-battle-royale の locale='en' で英語翻訳を返すべき", () => {
      const m = findProblemMetadata("security-battle-royale");
      const r = resolveLocalizedNarrative(m!, "en");
      expect(r.shortDescription).toMatch(/Attack\/defend/);
    });

    it("locale='es' で security-battle-royale もスペイン語翻訳を返すべき", () => {
      const m = findProblemMetadata("security-battle-royale");
      const r = resolveLocalizedNarrative(m!, "es");
      expect(r.shortDescription).toMatch(/Ataca\/defiende/);
    });
  });
});
