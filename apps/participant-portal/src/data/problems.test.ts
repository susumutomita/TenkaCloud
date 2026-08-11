import { describe, expect, it } from "vitest";
import {
  buildDiagramMap,
  findProblemDiagramUrl,
  findProblemMetadata,
  listProblemCatalog,
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
    // description は採点ルール等のネタバレを含むため portal に embed しない
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

  it("should not expose deploy internals or spoiler descriptions", () => {
    const m = findProblemMetadata("hello-world");
    expect(m).toBeDefined();
    // 答えの hint になりうる deploy 内部情報 + ネタバレ長文は Portal bundle に出さない
    // (= JSON.stringify でも漏らさない)
    const json = JSON.stringify(m);
    expect(json).not.toContain("cfnTemplate");
    expect(json).not.toContain("cfnParameters");
    expect(json).not.toContain('"description"');
  });

  // portal は author が `publicHint: true` で
  // 明示宣言した phase / disruption だけを予告 panel に出す。 現状の全 problem は
  // publicHint: false (or 未宣言) なので competitor 視点では 0 件露出が期待値。
  // (= 過去 microservice-migration-battle は publicHint: true で showcase されていたが、
  //  catalog 側 metadata の方針変更で false に倒された)。
  it("should drop phases and disruptions unless publicHint is true", () => {
    for (const id of ["stackstack", "microservice-migration-battle"]) {
      const m = findProblemMetadata(id);
      expect(m, `${id} should be in catalog`).toBeDefined();
      expect(m?.phases, `${id} phases should be hidden when publicHint != true`).toEqual([]);
      expect(m?.disruptions, `${id} disruptions should be hidden when publicHint != true`).toEqual(
        [],
      );
    }
  });

  it("phases / disruptions に operator 内部 field (effect / parameters / eventDetailType) を露出しないべき", () => {
    const m = findProblemMetadata("microservice-migration-battle");
    const json = JSON.stringify(m);
    // 採点 internals と trigger 情報は競技者には不要 (= 答えの hint や noise 防止)
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

  // plugin が endpoints[] を build-time catalog から直接読めることを pin。
  it("microservice-migration-battle で endpoints[] が露出されるべき", () => {
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

  // Issue #574: visibility field を catalog に露出する。
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

    it("should fall back to base fields when i18n exists but lacks the requested locale", () => {
      const base = requireProblemMetadata("hello-world");
      // i18n is present but has no "en" entry → the no-override fallback branch.
      const entry = {
        ...base,
        i18n: { ja: { name: "ja-name", shortDescription: "ja-desc", learningGoals: ["g"] } },
      } as ProblemCatalogEntry;
      const r = resolveLocalizedNarrative(entry, "en");
      expect(r.name).toBe(base.name);
      expect(r.shortDescription).toBe(base.shortDescription);
      expect(r.learningGoals).toEqual(base.learningGoals);
    });

    it("should fall back per-field when the en override is partial", () => {
      const base = requireProblemMetadata("hello-world");
      // Only `name` is overridden → the other fields fall back to the base entry.
      const entry = { ...base, i18n: { en: { name: "EN Only" } } } as ProblemCatalogEntry;
      const r = resolveLocalizedNarrative(entry, "en");
      expect(r.name).toBe("EN Only");
      expect(r.shortDescription).toBe(base.shortDescription);
      expect(r.learningGoals).toEqual(base.learningGoals);
    });

    it("should use a full en override including learningGoals when present", () => {
      const base = requireProblemMetadata("hello-world");
      const entry = {
        ...base,
        i18n: {
          en: {
            name: "EN",
            shortDescription: "EN short",
            learningGoals: ["en-goal-1", "en-goal-2"],
          },
        },
      } as ProblemCatalogEntry;
      const r = resolveLocalizedNarrative(entry, "en");
      expect(r.learningGoals).toEqual(["en-goal-1", "en-goal-2"]);
    });

    it("should return en override fields when locale='en' (hello-world)", () => {
      const m = requireProblemMetadata("hello-world");
      const ja = resolveLocalizedNarrative(m, "ja");
      const en = resolveLocalizedNarrative(m, "en");
      // i18n override が適用されていれば ja と en の shortDescription は別物。
      // 問題本文は時期によって書き換わる (= 特定 sentinel 文字列に pin しない)。
      expect(en.shortDescription).not.toBe(ja.shortDescription);
      // en は CJK 文字 (ひらがな / カタカナ / 漢字) を含まないはず。
      expect(en.shortDescription).not.toMatch(
        /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,
      );
      expect(en.learningGoals.length).toBeGreaterThanOrEqual(2);
      // description は narrative の戻り値型から削除済
      expect((en as unknown as { description?: string }).description).toBeUndefined();
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
      expect(r.shortDescription).not.toBe(m.shortDescription);
      expect(r.shortDescription).not.toMatch(
        /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,
      );
    });
  });
});

describe("problem architecture diagram (#1929 Phase 1c)", () => {
  it("should key the diagram map by the problem directory name", () => {
    const m = buildDiagramMap({
      "../../../../problems/challenges/foo/diagram.svg": "/assets/foo.svg",
      "../../../../problems/battles/bar/diagram.svg": "/assets/bar.svg",
      // pathological key with no "/" exercises the empty-segment fallback branch.
      "diagram.svg": "/assets/edge.svg",
    });
    expect(m.get("foo")).toBe("/assets/foo.svg");
    expect(m.get("bar")).toBe("/assets/bar.svg");
    expect(m.get("")).toBe("/assets/edge.svg");
  });

  it("should return undefined for a problem without a bundled diagram", () => {
    expect(findProblemDiagramUrl("does-not-exist")).toBeUndefined();
  });
});

describe("listProblemCatalog (#2786)", () => {
  it("should return the whole build-time catalog, sorted and consistent with lookup by id", () => {
    // course track view は「deploy された問題」ではなく「curriculum に載っている問題」を
    // 並べるので、 team view ではなく catalog 全件を起点にする。
    const catalog = listProblemCatalog();
    expect(catalog.length).toBeGreaterThan(0);
    expect(catalog.map((p) => p.id)).toEqual([...catalog.map((p) => p.id)].sort());
    for (const entry of catalog) expect(findProblemMetadata(entry.id)).toBe(entry);
  });
});
