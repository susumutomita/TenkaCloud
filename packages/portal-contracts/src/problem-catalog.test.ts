import { describe, expect, it } from "vitest";
import { metadataToEntry } from "./problem-catalog.js";

/**
 * Issue #2925, #2926: 競技者向け投影 (`metadataToEntry`) は participant-portal から
 * ここへ移した。 消費者が 2 つになったため — build 時に bundle へ焼く portal と、 実行時に
 * `/portal/problem-catalog` で配る local-play control plane。 投影が壊れたときに落ちるべき
 * test は、 投影と同じ場所に居るべきである。
 *
 * カタログ実体 (glob / lookup / hydration) の test は portal 側に残している。
 */

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

describe("metadataToEntry competitor-safe projection", () => {
  it("should keep only publicHint:true phases/disruptions and drop the description", () => {
    const entry = metadataToEntry(FAIRNESS_FIXTURE);

    // Competitor-facing bundles must not carry the authoring `description`.
    expect((entry as unknown as { description?: string }).description).toBeUndefined();

    // Only the publicHint:true phase/disruption survive (secret ones are filtered out).
    expect(entry.phases.map((p) => p.name)).toEqual(["public phase"]);
    expect(entry.disruptions.map((d) => d.id)).toEqual(["d1"]);

    // Endpoints are projected through.
    expect(entry.endpoints).toHaveLength(1);
    expect(entry.endpoints[0]?.slot).toBe("main");
  });

  it("should default the runtime to aws/cloudformation when none is declared", () => {
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

  it("should project a declared native-CPU compatibility requirement (#3008)", () => {
    // The shape TenkaCloudChallenge#434 declares. Projected to the participant because it
    // describes the machine, never the answer — the portal needs it to say "not startable
    // here, and why" on the card rather than only when a start is refused.
    const withCompatibility = {
      ...FAIRNESS_FIXTURE,
      runtime: {
        provider: "docker",
        engine: "compose",
        entry: "local/docker-compose.yml",
        compatibility: {
          nativeArchitectures: ["amd64"],
          cpuFlags: ["rdtscp", "constant_tsc", "nonstop_tsc"],
        },
      },
    } as Parameters<typeof metadataToEntry>[0];
    expect(metadataToEntry(withCompatibility).runtime).toEqual({
      provider: "docker",
      engine: "compose",
      compatibility: {
        nativeArchitectures: ["amd64"],
        cpuFlags: ["rdtscp", "constant_tsc", "nonstop_tsc"],
      },
    });
  });

  it("should omit compatibility when it constrains nothing (#3008)", () => {
    // An empty declaration must not make the portal render an "unsupported host" state for
    // a problem that in fact runs anywhere.
    const empty = {
      ...FAIRNESS_FIXTURE,
      runtime: {
        provider: "docker",
        engine: "compose",
        compatibility: { nativeArchitectures: [], cpuFlags: [] },
      },
    } as Parameters<typeof metadataToEntry>[0];
    expect(metadataToEntry(empty).runtime).toEqual({ provider: "docker", engine: "compose" });
  });

  it("should leave the runtime shape of a problem declaring no compatibility unchanged (#3008)", () => {
    expect(metadataToEntry(FAIRNESS_FIXTURE).runtime).not.toHaveProperty("compatibility");
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

  it("should carry player-facing instructions into the entry and its en override (#1929)", () => {
    const withInstr = {
      ...FAIRNESS_FIXTURE,
      instructions: "▶ first move: read the briefing",
      i18n: { en: { instructions: "▶ first move (EN)" } },
    } as Parameters<typeof metadataToEntry>[0];
    const entry = metadataToEntry(withInstr);
    expect(entry.instructions).toBe("▶ first move: read the briefing");
    // The locale fallback chain that consumes this override lives with the portal's
    // `resolveLocalizedNarrative`, and is exercised there.
    expect(entry.i18n?.en?.instructions).toBe("▶ first move (EN)");
  });
});

/**
 * Issue #2786: curriculum 位置と講座対応の投影。
 *
 * `assessment_criteria` は「何が採点されるか」を
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

  it("should not project removed knowledge-graph fields from legacy metadata", () => {
    const out = metadataToEntry({
      ...COURSE_FIXTURE,
      nodes: { concepts: [{ id: "concept.legacy", description: "legacy" }] },
      relations: [{ type: "requires", source: "problem.ac26-demo", target: "problem.other" }],
    } as never);
    expect(out).not.toHaveProperty("graphNodes");
    expect(out).not.toHaveProperty("graphRelations");
  });
});

/**
 * [#2925 / #2926] Branches that used to be covered only indirectly, by projecting the real
 * `problems/` metadata through the portal's build-time catalog. Now that the projection has
 * two consumers, they are pinned against explicit fixtures here — a problem shape that
 * appears only in the catalog repository must not be the thing keeping this contract honest.
 */
describe("metadataToEntry (optional-field branches)", () => {
  const BARE = {
    id: "bare",
    name: "Bare",
    category: "Challenge",
    status: "ready",
    difficulty: 1,
    estimatedDuration: "10 min",
    shortDescription: "short",
    description: "SECRET",
    tags: [],
    learningGoals: [],
  } as Parameters<typeof metadataToEntry>[0];

  it("should emit empty collections for a problem declaring no endpoints/phases/disruptions", () => {
    const entry = metadataToEntry(BARE);
    expect(entry.endpoints).toEqual([]);
    expect(entry.phases).toEqual([]);
    expect(entry.disruptions).toEqual([]);
    expect(entry.dashboardSlots).toBeUndefined();
    expect(entry.interTeamCoordination).toBeUndefined();
  });

  it("should keep an endpoint's appendPath, label and description, and drop the absent ones", () => {
    const entry = metadataToEntry({
      ...BARE,
      endpoints: [
        {
          slot: "orders",
          default: { from: "cfn-output", key: "BaseUrl", appendPath: "/orders" },
          overridable: true,
          label: "Orders",
          description: "order service",
        },
        { slot: "bare", default: { from: "cfn-output", key: "BaseUrl" } },
      ],
    } as Parameters<typeof metadataToEntry>[0]);
    expect(entry.endpoints[0]).toEqual({
      slot: "orders",
      default: { from: "cfn-output", key: "BaseUrl", appendPath: "/orders" },
      overridable: true,
      label: "Orders",
      description: "order service",
    });
    // An endpoint that declares neither `overridable` nor labels must not invent them.
    expect(entry.endpoints[1]).toEqual({
      slot: "bare",
      default: { from: "cfn-output", key: "BaseUrl" },
      overridable: false,
    });
  });

  it("should expose dashboard slots only when at least one is declared", () => {
    expect(
      metadataToEntry({ ...BARE, dashboard: { slots: { Main: "portal/Main.tsx" } } } as Parameters<
        typeof metadataToEntry
      >[0]).dashboardSlots,
    ).toEqual({ Main: "portal/Main.tsx" });
    expect(
      metadataToEntry({ ...BARE, dashboard: { slots: {} } } as Parameters<
        typeof metadataToEntry
      >[0]).dashboardSlots,
    ).toBeUndefined();
  });

  it("should narrow inter-team coordination to its public half, and only when opted in", () => {
    const opted = metadataToEntry({
      ...BARE,
      interTeamCoordination: {
        plugin: "internal/dispatcher.ts",
        name: "Trade",
        description: "swap resources",
        publicHint: true,
      },
    } as Parameters<typeof metadataToEntry>[0]);
    // The plugin path is platform-internal and must not reach a competitor.
    expect(opted.interTeamCoordination).toEqual({ name: "Trade", description: "swap resources" });

    const notOpted = metadataToEntry({
      ...BARE,
      interTeamCoordination: { plugin: "internal/dispatcher.ts", name: "Trade" },
    } as Parameters<typeof metadataToEntry>[0]);
    expect(notOpted.interTeamCoordination).toBeUndefined();
  });

  it("should keep a phase/disruption description and omit it when undeclared", () => {
    const entry = metadataToEntry({
      ...BARE,
      phases: [{ name: "p", afterMinutes: 1, publicHint: true }],
      disruptions: [{ id: "d", name: "d name", publicHint: true }],
    } as Parameters<typeof metadataToEntry>[0]);
    expect(entry.phases[0]).toEqual({ name: "p", afterMinutes: 1, publicHint: true });
    expect(entry.disruptions[0]).toEqual({ id: "d", name: "d name", publicHint: true });
  });
});
