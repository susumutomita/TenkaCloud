import { describe, expect, it } from "vitest";
import {
  buildDiagramMap,
  findProblemDiagramUrl,
  findProblemMetadata,
  listProblemCatalog,
  metadataToEntry,
  type ProblemCatalogEntry,
  resolveLocalizedNarrative,
} from "./problems";

const FAIRNESS_FIXTURE = {
  id: "demo",
  name: "Demo",
  category: "Challenge",
  status: "draft",
  difficulty: 2,
  estimatedDuration: "30 min",
  shortDescription: "competitor-safe short description",
  description: "SECRET scoring rules — must never reach the portal bundle",
  tags: ["sample"],
  learningGoals: ["learn"],
  endpoints: [
    { slot: "main", default: { from: "cfn-output", key: "Url" }, overridable: true, label: "App" },
  ],
  phases: [
    { name: "public phase", afterMinutes: 5, description: "shown", publicHint: true },
    { name: "secret phase", afterMinutes: 10, effect: { x: 1 }, publicHint: false },
  ],
  disruptions: [
    { id: "d1", name: "public disruption", defaultAfterMinutes: 3, publicHint: true },
    { id: "d2", name: "secret disruption", parameters: { y: 2 }, publicHint: false },
  ],
} as Parameters<typeof metadataToEntry>[0];

describe("metadataToEntry (fairness projection)", () => {
  it("should keep only publicHint:true phases/disruptions and drop the description", () => {
    const entry = metadataToEntry(FAIRNESS_FIXTURE);

    // Fairness contract: competitor-facing bundle must not carry the authoring `description`.
    expect((entry as unknown as { description?: string }).description).toBeUndefined();

    // Only the publicHint:true phase/disruption survive (secret ones are filtered out).
    expect(entry.phases.map((p) => p.name)).toEqual(["public phase"]);
    expect(entry.disruptions.map((d) => d.id)).toEqual(["d1"]);

    // Endpoints are projected through.
    expect(entry.endpoints).toHaveLength(1);
    expect(entry.endpoints[0]?.slot).toBe("main");
  });

  it("should default the runtime to aws/cloudformation when none is declared (ADR-026/027)", () => {
    expect(metadataToEntry(FAIRNESS_FIXTURE).runtime).toEqual({
      provider: "aws",
      engine: "cloudformation",
    });
  });

  it("should project a declared multi-cloud runtime", () => {
    const withRuntime = {
      ...FAIRNESS_FIXTURE,
      runtime: { provider: "azure", engine: "bicep", entry: "main.bicep" },
    } as Parameters<typeof metadataToEntry>[0];
    expect(metadataToEntry(withRuntime).runtime).toEqual({ provider: "azure", engine: "bicep" });
  });

  it("should project i18n.en (dropping its description) and omit i18n when the override is empty", () => {
    const withI18n = {
      ...FAIRNESS_FIXTURE,
      i18n: {
        en: {
          name: "EN Name",
          shortDescription: "EN short",
          learningGoals: ["g"],
          description: "secret en",
        },
      },
    } as Parameters<typeof metadataToEntry>[0];
    const entry = metadataToEntry(withI18n);
    expect(entry.i18n?.en?.name).toBe("EN Name");
    expect((entry.i18n?.en as unknown as { description?: string })?.description).toBeUndefined();

    // An all-undefined en override collapses to no i18n field at all.
    const emptyI18n = {
      ...FAIRNESS_FIXTURE,
      i18n: { en: {} },
    } as Parameters<typeof metadataToEntry>[0];
    expect(metadataToEntry(emptyI18n).i18n).toBeUndefined();

    // i18n present but with no `en` key at all → also collapses to no i18n.
    const noEn = { ...FAIRNESS_FIXTURE, i18n: {} } as Parameters<typeof metadataToEntry>[0];
    expect(metadataToEntry(noEn).i18n).toBeUndefined();
  });

  it("should carry player-facing instructions through the entry and locale resolution (#1929)", () => {
    const withInstr = {
      ...FAIRNESS_FIXTURE,
      instructions: "▶ first move: read the briefing",
      i18n: { en: { instructions: "▶ first move (EN)" } },
    } as Parameters<typeof metadataToEntry>[0];
    const entry = metadataToEntry(withInstr);
    expect(entry.instructions).toBe("▶ first move: read the briefing");
    expect(resolveLocalizedNarrative(entry, "ja").instructions).toBe(
      "▶ first move: read the briefing",
    );
    expect(resolveLocalizedNarrative(entry, "en").instructions).toBe("▶ first move (EN)");
  });
});

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
  // 明示宣言した phase / disruption だけを予告 panel に出す。 現状の全 problem は
  // publicHint: false (or 未宣言) なので competitor 視点では 0 件露出が期待値。
  // (= 過去 microservice-migration-battle は publicHint: true で showcase されていたが、
  //  catalog 側 metadata の方針変更で false に倒された)。
  it("should drop phases / disruptions without publicHint: true (fairness contract)", () => {
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
      // fairness contract: description は narrative の戻り値型から削除済
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

/**
 * Issue #2786: curriculum 位置と講座対応の投影。
 *
 * ここは fairness contract の一部である。`assessment_criteria` は「何が採点されるか」を
 * 問題を開く前に列挙し、`misconceptions` は「よくある誤り」の形で答えの方向を示すため、
 * どちらも participant bundle に載せない。`spoilerPolicy` は authoring 情報なので出さない。
 */
describe("metadataToEntry (course track projection #2786)", () => {
  const COURSE_FIXTURE = {
    ...FAIRNESS_FIXTURE,
    id: "ac26-demo",
    track: { id: "advanced-cryptography-2026", order: 310, chapter: "Week 3 / 有限体" },
    courseAlignment: {
      courseId: "advanced-cryptography-program",
      edition: "2026",
      week: 3,
      role: "mechanism",
      spoilerPolicy: "independent-reimplementation",
      sources: [
        { repository: "org/course", ref: "a".repeat(40), path: "week3/README.md", kind: "lecture" },
      ],
    },
    nodes: {
      learning_objectives: [{ id: "lo.ac26-demo.invert", description: "逆元を求められる" }],
      concepts: [{ id: "concept.finite-field", description: "有限体" }],
      assessment_criteria: [{ id: "assessment.ac26-demo.x", description: "SPOILER: 採点条件" }],
      misconceptions: [{ id: "misconception.y", description: "SPOILER: よくある誤り" }],
      audiences: [{ id: "audience.z", description: "対象者" }],
    },
    relations: [
      { type: "teaches", source: "problem.ac26-demo", target: "lo.ac26-demo.invert" },
      { type: "covers", source: "problem.ac26-demo", target: "concept.finite-field" },
      { type: "requires", source: "problem.ac26-demo", target: "concept.modular-arithmetic" },
      { type: "assesses", source: "problem.ac26-demo", target: "assessment.ac26-demo.x" },
      { type: "related_to", source: "misconception.y", target: "concept.finite-field" },
    ],
  } as Parameters<typeof metadataToEntry>[0];

  it("should carry the track position through", () => {
    expect(metadataToEntry(COURSE_FIXTURE).track).toEqual({
      id: "advanced-cryptography-2026",
      order: 310,
      chapter: "Week 3 / 有限体",
    });
  });

  it("should omit track entirely for a problem that declares none", () => {
    expect(metadataToEntry(FAIRNESS_FIXTURE).track).toBeUndefined();
  });

  it("should reject a partial track rather than emit one with a missing field", () => {
    // 半端な track を通すと grouping key や順序が欠けた row が UI に並ぶ。
    for (const track of [
      { id: "t", order: 10 },
      { id: "t", chapter: "C" },
      { order: 10, chapter: "C" },
      { id: "t", order: Number.NaN, chapter: "C" },
    ]) {
      expect(metadataToEntry({ ...FAIRNESS_FIXTURE, track } as never).track).toBeUndefined();
    }
  });

  it("should project course alignment without the spoiler policy", () => {
    const alignment = metadataToEntry(COURSE_FIXTURE).courseAlignment;
    expect(alignment).toMatchObject({
      courseId: "advanced-cryptography-program",
      week: 3,
      role: "mechanism",
    });
    expect(JSON.stringify(alignment)).not.toContain("spoilerPolicy");
    expect(JSON.stringify(alignment)).not.toContain("independent-reimplementation");
  });

  it("should drop an embargoed alignment entirely rather than ship a flag", () => {
    // client が flag を無視しても漏れないようにする (= 不在が唯一の安全な表現)。
    const embargoed = metadataToEntry({
      ...COURSE_FIXTURE,
      courseAlignment: { ...COURSE_FIXTURE.courseAlignment, spoilerPolicy: "embargoed" },
    } as never);
    expect(embargoed.courseAlignment).toBeUndefined();
  });

  it("should reject an alignment missing a required field", () => {
    for (const patch of [
      { courseId: undefined },
      { edition: undefined },
      { role: undefined },
      { week: undefined },
    ]) {
      const out = metadataToEntry({
        ...COURSE_FIXTURE,
        courseAlignment: { ...COURSE_FIXTURE.courseAlignment, ...patch },
      } as never);
      expect(out.courseAlignment).toBeUndefined();
    }
  });

  it("should keep pinned sources and skip malformed ones", () => {
    const out = metadataToEntry({
      ...COURSE_FIXTURE,
      courseAlignment: {
        ...COURSE_FIXTURE.courseAlignment,
        sources: [
          { repository: "org/course", ref: "b".repeat(40), path: "week3/x.md", kind: "assignment" },
          { repository: "org/course", path: "no-ref.md", kind: "lecture" },
        ],
      },
    } as never);
    expect(out.courseAlignment?.sources).toEqual([
      { repository: "org/course", ref: "b".repeat(40), path: "week3/x.md", kind: "assignment" },
    ]);
  });

  it("should default sources to an empty list when the alignment declares none", () => {
    const out = metadataToEntry({
      ...COURSE_FIXTURE,
      courseAlignment: { ...COURSE_FIXTURE.courseAlignment, sources: undefined },
    } as never);
    expect(out.courseAlignment?.sources).toEqual([]);
  });

  it("should project only learning objectives and concepts as graph nodes", () => {
    const nodes = metadataToEntry(COURSE_FIXTURE).graphNodes;
    expect(nodes.map((n) => n.id)).toEqual([
      "problem.ac26-demo",
      "lo.ac26-demo.invert",
      "concept.finite-field",
    ]);
  });

  it("should never carry assessment criteria or misconceptions into the bundle", () => {
    const serialized = JSON.stringify(metadataToEntry(COURSE_FIXTURE));
    expect(serialized).not.toContain("assessment.");
    expect(serialized).not.toContain("misconception.");
    expect(serialized).not.toContain("audience.");
    expect(serialized).not.toContain("SPOILER");
  });

  it("should label a node by its id when it has no description", () => {
    const out = metadataToEntry({
      ...COURSE_FIXTURE,
      nodes: { concepts: [{ id: "concept.bare" }] },
    } as never);
    expect(out.graphNodes.find((n) => n.id === "concept.bare")?.label).toBe("concept.bare");
  });

  it("should skip a node with no id", () => {
    const out = metadataToEntry({
      ...COURSE_FIXTURE,
      nodes: { concepts: [{ description: "nameless" }] },
    } as never);
    expect(out.graphNodes.map((n) => n.id)).toEqual(["problem.ac26-demo"]);
  });

  it("should project only teaches, covers and requires relations", () => {
    const relations = metadataToEntry(COURSE_FIXTURE).graphRelations;
    expect(relations.map((r) => r.type).sort()).toEqual(["covers", "requires", "teaches"]);
  });

  it("should drop a relation pointing at a node kind that was withheld", () => {
    // 参照先が無い edge を残すと UI が「未解決の前提」として表示してしまう。
    const out = metadataToEntry({
      ...COURSE_FIXTURE,
      relations: [{ type: "requires", source: "problem.ac26-demo", target: "misconception.y" }],
    } as never);
    expect(out.graphRelations).toEqual([]);
  });

  it("should keep a requires edge that points at another problem", () => {
    const out = metadataToEntry({
      ...COURSE_FIXTURE,
      relations: [{ type: "requires", source: "problem.ac26-demo", target: "problem.other" }],
    } as never);
    expect(out.graphRelations).toEqual([
      { type: "requires", source: "problem.ac26-demo", target: "problem.other" },
    ]);
  });

  it("should drop a relation whose source is not a node of this problem", () => {
    const out = metadataToEntry({
      ...COURSE_FIXTURE,
      relations: [
        { type: "requires", source: "lo.someone-else.x", target: "concept.finite-field" },
      ],
    } as never);
    expect(out.graphRelations).toEqual([]);
  });

  it("should drop a malformed relation instead of throwing", () => {
    const out = metadataToEntry({
      ...COURSE_FIXTURE,
      relations: [{ type: "requires" }, { source: "problem.ac26-demo", target: "concept.x" }],
    } as never);
    expect(out.graphRelations).toEqual([]);
  });

  it("should give an untracked problem an empty graph rather than undefined", () => {
    const out = metadataToEntry(FAIRNESS_FIXTURE);
    expect(out.graphRelations).toEqual([]);
    expect(out.graphNodes).toEqual([{ id: "problem.demo", type: "problem", label: "Demo" }]);
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
