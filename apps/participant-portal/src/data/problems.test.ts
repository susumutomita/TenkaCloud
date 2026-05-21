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
  it("should look up hello-world (Challenge sample) and include narrative fields", () => {
    const m = findProblemMetadata("hello-world");
    expect(m).toBeDefined();
    expect(m?.category).toBe("Challenge");
    expect(m?.name).toBe("Hello World (Sample)");
    // narrative field が空でない (= competitor 向け表示が実質中身ありで動く)
    expect(m?.description.length).toBeGreaterThan(0);
    expect(m?.learningGoals.length).toBeGreaterThan(0);
    expect(m?.shortDescription.length).toBeGreaterThan(0);
  });

  it("should look up hello-world-battle (Battle uptime sample) and have category=Battle", () => {
    const m = findProblemMetadata("hello-world-battle");
    expect(m).toBeDefined();
    expect(m?.category).toBe("Battle");
  });

  it("should return undefined for a non-existent id", () => {
    expect(findProblemMetadata("does-not-exist")).toBeUndefined();
  });

  it("should not expose deploy-internal info (cfnTemplate etc.) from Portal (#550 design decision)", () => {
    const m = findProblemMetadata("hello-world");
    expect(m).toBeDefined();
    // 答えの hint になりうる deploy 内部情報は Portal の型に含めない
    // (= JSON.stringify でも漏らさない)
    const json = JSON.stringify(m);
    expect(json).not.toContain("cfnTemplate");
    expect(json).not.toContain("cfnParameters");
  });

  // ADR-012 Phase 4: phases / disruptions を portal が予告 panel に出すための data shape pin。
  it("should expose phases / disruptions on microservice-migration-battle (ADR-012 Phase 4)", () => {
    const m = findProblemMetadata("microservice-migration-battle");
    expect(m).toBeDefined();
    expect(m?.phases.length).toBeGreaterThanOrEqual(2);
    expect(m?.phases.map((p) => p.name)).toEqual(expect.arrayContaining(["degraded", "legacy"]));
    expect(m?.disruptions.length).toBeGreaterThanOrEqual(1);
    expect(m?.disruptions[0]?.id).toBe("ec2-latency-injection");
    expect(m?.disruptions[0]?.defaultAfterMinutes).toBe(60);
  });

  it("should not expose operator-internal fields (effect / parameters / eventDetailType) on phases / disruptions", () => {
    const m = findProblemMetadata("microservice-migration-battle");
    const json = JSON.stringify(m);
    // 採点 internals / Phase 2 用 trigger 情報は競技者には不要 (= 答えの hint や noise 防止)
    expect(json).not.toContain("eventDetailType");
    expect(json).not.toContain("operatorEditable");
    expect(json).not.toContain("switchPlatformToDegraded");
    expect(json).not.toContain("scorePathOverride");
  });

  it("should return empty arrays for problems without phases / disruptions", () => {
    const m = findProblemMetadata("hello-world");
    expect(m?.phases).toEqual([]);
    expect(m?.disruptions).toEqual([]);
  });

  // ADR-012 Phase 5: endpoints[] を portal plugin が build-time catalog から直接読めることを pin。
  it("should expose endpoints[] on microservice-migration-battle (ADR-012 Phase 5)", () => {
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

  it("should return empty array for problems without endpoints[]", () => {
    expect(findProblemMetadata("hello-world")?.endpoints).toEqual([]);
  });

  // ADR-008 / Issue #574 Phase 1: visibility field を catalog に露出する。
  it("should expose all 4 existing problems with visibility='public'", () => {
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
    it("should return top-level values as-is for locale='ja'", () => {
      const m = requireProblemMetadata("hello-world");
      const r = resolveLocalizedNarrative(m, "ja");
      expect(r.name).toBe("Hello World (Sample)");
      // Issue #816: narrative re-write で description が変わったので tone-of-voice の
      // 代表的な substring (= 加藤さん) で検証する。
      expect(r.description).toContain("加藤さん");
    });

    it("should return English when locale='en' override is declared (hello-world)", () => {
      const m = requireProblemMetadata("hello-world");
      const r = resolveLocalizedNarrative(m, "en");
      expect(r.shortDescription).toMatch(/Minimal Challenge/);
      expect(r.description).toMatch(/Deploying creates a single SSM Parameter/);
      expect(r.learningGoals.length).toBeGreaterThanOrEqual(2);
    });

    it("should have en translations for all 4 existing problems (#1108 only ja+en supported)", () => {
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

    it("should return English translation for security-battle-royale at locale='en'", () => {
      const m = requireProblemMetadata("security-battle-royale");
      const r = resolveLocalizedNarrative(m, "en");
      expect(r.shortDescription).toMatch(/Attack\/defend/);
    });
  });
});
