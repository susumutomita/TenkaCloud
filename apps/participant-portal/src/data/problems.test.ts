import { describe, expect, it } from "vitest";
import {
  findProblemMetadata,
  type ProblemCatalogEntry,
  resolveLocalizedNarrative,
} from "./problems";

/**
 * #550: Portal の build-time catalog が `problems/<category>/<id>/metadata.json` を
 * Vite glob で取り込んでいることを確認する smoke test。問題追加時に metadata.json を
 * 置き忘れた / shape が壊れた場合に CI で気づける。
 *
 * 既存 3 問 (hello-world / hello-world-battle / security-battle-royale) を pin する。
 * 新 problem 追加で test を更新する運用 (= CLAUDE.md の TDD タイトル「〜すべき」に沿う)。
 */

function requireProblemMetadata(problemId: string): ProblemCatalogEntry {
  const metadata = findProblemMetadata(problemId);
  expect(metadata).toBeDefined();
  if (!metadata) throw new Error(`problem metadata not found: ${problemId}`);
  return metadata;
}

describe("findProblemMetadata (Portal build-time catalog #550)", () => {
  it("should expose competitor-safe narrative fields (no description) for hello-world", () => {
    const m = findProblemMetadata("hello-world");
    expect(m).toBeDefined();
    expect(m?.category).toBe("Challenge");
    expect(m?.name).toBe("Hello World (Sample)");
    // narrative field が空でない (= competitor 向け表示が実質中身ありで動く)
    expect(m?.shortDescription.length).toBeGreaterThan(0);
    expect(m?.learningGoals.length).toBeGreaterThan(0);
    // fairness contract: description (= 採点ルール等のネタバレを含む長文) は portal に embed しない
    expect((m as unknown as { description?: string })?.description).toBeUndefined();
  });

  it("hello-world-battle (Battle uptime sample) が引けて category=Battle であるべき", () => {
    const m = findProblemMetadata("hello-world-battle");
    expect(m).toBeDefined();
    expect(m?.category).toBe("Battle");
  });

  it("存在しない id は undefined を返すべき", () => {
    expect(findProblemMetadata("does-not-exist")).toBeUndefined();
  });

  it("should not expose deploy internals or spoiler description (#550 + fairness contract)", () => {
    const m = findProblemMetadata("hello-world");
    expect(m).toBeDefined();
    // 答えの hint になりうる deploy 内部情報 + ネタバレ長文は Portal bundle に出さない
    // (= JSON.stringify でも漏らさない)
    const json = JSON.stringify(m);
    expect(json).not.toContain("cfnTemplate");
    expect(json).not.toContain("cfnParameters");
    expect(json).not.toContain('"description"');
  });

  // ADR-012 Phase 4 + fairness contract: portal は author が `publicHint: true` で
  // 明示宣言した phase / disruption だけを予告 panel に出す。 microservice-migration-battle は
  // 全 phase / disruption に publicHint: true を立てているので全部見える。
  it("should expose phases / disruptions for microservice-migration-battle (all publicHint: true)", () => {
    const m = findProblemMetadata("microservice-migration-battle");
    expect(m).toBeDefined();
    expect(m?.phases.length).toBeGreaterThanOrEqual(2);
    expect(m?.phases.map((p) => p.name)).toEqual(expect.arrayContaining(["degraded", "legacy"]));
    expect(m?.disruptions.length).toBeGreaterThanOrEqual(1);
    expect(m?.disruptions[0]?.id).toBe("ec2-latency-injection");
    expect(m?.disruptions[0]?.defaultAfterMinutes).toBe(60);
  });

  // fairness contract: publicHint: true が無い phase / disruption は portal bundle に embed されない。
  // stackstack の phases / disruptions は publicHint が無いので 0 件露出が期待値。
  it("should drop phases / disruptions without publicHint: true (fairness contract)", () => {
    const m = findProblemMetadata("stackstack");
    expect(m).toBeDefined();
    expect(m?.phases).toEqual([]);
    expect(m?.disruptions).toEqual([]);
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

  // ADR-008 / Issue #574 Phase 1: visibility field を catalog に露出する。
  it("既存 4 問題はすべて visibility='public' で露出されるべき", () => {
    for (const id of [
      "hello-world",
      "hello-world-battle",
      "security-battle-royale",
      "microservice-migration-battle",
    ]) {
      const m = findProblemMetadata(id);
      expect(m?.visibility).toBe("public");
    }
  });

  // Issue #583 Phase 5: i18n override の locale fallback chain。
  describe("resolveLocalizedNarrative (Phase 5)", () => {
    it("should return top-level values for locale='ja'", () => {
      const m = requireProblemMetadata("hello-world");
      const r = resolveLocalizedNarrative(m, "ja");
      expect(r.name).toBe("Hello World (Sample)");
      expect(r.shortDescription.length).toBeGreaterThan(0);
      expect(r.learningGoals.length).toBeGreaterThanOrEqual(2);
    });

    it("should return en override fields when locale='en' (hello-world)", () => {
      const m = requireProblemMetadata("hello-world");
      const r = resolveLocalizedNarrative(m, "en");
      expect(r.shortDescription).toMatch(/Minimal Challenge/);
      expect(r.learningGoals.length).toBeGreaterThanOrEqual(2);
      // fairness contract: description は narrative の戻り値型から削除済
      expect((r as unknown as { description?: string }).description).toBeUndefined();
    });

    it("全 4 既存問題が en の翻訳を持つべき (#1108 で ja+en のみサポート)", () => {
      for (const id of [
        "hello-world",
        "hello-world-battle",
        "security-battle-royale",
        "microservice-migration-battle",
      ]) {
        const m = findProblemMetadata(id);
        expect(m?.i18n?.en?.name).toBeTruthy();
        expect(m?.i18n?.en?.learningGoals?.length ?? 0).toBeGreaterThan(0);
      }
    });

    it("security-battle-royale の locale='en' で英語翻訳を返すべき", () => {
      const m = requireProblemMetadata("security-battle-royale");
      const r = resolveLocalizedNarrative(m, "en");
      expect(r.shortDescription).toMatch(/Attack\/defend/);
    });
  });
});
