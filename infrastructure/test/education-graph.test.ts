import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildEducationGraphResponse,
  discoverProblemsEducationGraph,
  type ProblemsEducationGraph,
  parseProblemsEducationGraph,
  projectEducationMaterials,
} from "../lib/utils/education-graph";

const temporaryDirectories: string[] = [];

function catalogRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "education-graph-"));
  temporaryDirectories.push(root);
  return root;
}

function writeProblem(root: string, id: string, relatedProblemId?: string): void {
  const directory = path.join(root, "challenges", id);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "metadata.json"),
    JSON.stringify({
      id,
      name: "管理者のメモ",
      shortDescription: "オブジェクト単位の認可を学ぶ。",
      learningGoals: ["認証と認可を区別する"],
      i18n: {
        en: {
          name: "The Admin's Note",
          shortDescription: "Learn object-level authorization.",
          learningGoals: ["Distinguish authentication from authorization"],
          // These fields must never enter the education projection.
          writeup: "secret solution",
          hints: [{ id: "hint-1", content: "secret hint" }],
        },
      },
      writeup: "秘密の解答",
      scoring: { hints: [{ id: "hint-1", content: "秘密のヒント", penalty: 5 }] },
      nodes: {
        learning_objectives: [
          { id: `lo.${id}.object-authorization`, description: "認可不備を発見できる" },
        ],
        concepts: [{ id: "concept.authorization", description: "認可" }],
        assessment_criteria: [
          {
            id: `assessment.${id}.reject-cross-user-access`,
            description: "他ユーザーへのアクセスを拒否できる",
          },
        ],
        misconceptions: [],
        audiences: [{ id: "audience.software-engineer", description: "ソフトウェア技術者" }],
      },
      relations: [
        {
          type: "teaches",
          source: `problem.${id}`,
          target: `lo.${id}.object-authorization`,
        },
        ...(relatedProblemId
          ? [
              {
                type: "related_to",
                source: `problem.${id}`,
                target: `problem.${relatedProblemId}`,
              },
            ]
          : []),
        { type: "covers", source: `problem.${id}`, target: "concept.authorization" },
        {
          type: "assesses",
          source: `problem.${id}`,
          target: `assessment.${id}.reject-cross-user-access`,
        },
      ],
    }),
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("education graph catalog projection", () => {
  it("should parse only object-shaped synth input and fail closed for malformed JSON", () => {
    expect(parseProblemsEducationGraph(undefined)).toEqual({});
    expect(parseProblemsEducationGraph("")).toEqual({});
    expect(parseProblemsEducationGraph("null")).toEqual({});
    expect(parseProblemsEducationGraph("[]")).toEqual({});
    expect(parseProblemsEducationGraph('"graph"')).toEqual({});
    expect(parseProblemsEducationGraph('{"safe":true}')).toEqual({ safe: true });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(parseProblemsEducationGraph("{broken")).toEqual({});
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("graph API will be empty"));
    warn.mockRestore();
  });

  it("should return an empty catalog when the problems root is absent", () => {
    expect(discoverProblemsEducationGraph(path.join(catalogRoot(), "absent"))).toEqual({});
  });

  it("should return a stable empty graph for a catalog with no graph metadata", () => {
    expect(buildEducationGraphResponse({}, "ja")).toEqual({
      locale: "ja",
      nodes: [],
      relations: [],
      problems: [],
    });
  });

  it("should discover graph metadata and exclude writeups and hints", () => {
    const root = catalogRoot();
    writeProblem(root, "api-idor-demo");

    const graph = discoverProblemsEducationGraph(root);
    const serialized = JSON.stringify(graph);

    expect(graph["api-idor-demo"]?.nodes).toHaveLength(4);
    expect(graph["api-idor-demo"]?.relations).toHaveLength(3);
    expect(serialized).not.toContain("秘密の解答");
    expect(serialized).not.toContain("secret solution");
    expect(serialized).not.toContain("秘密のヒント");
    expect(serialized).not.toContain("secret hint");
  });

  it("should discover schema-valid relation-only metadata with an empty node list", () => {
    const root = catalogRoot();
    const directory = path.join(root, "challenges", "relation-only");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, "metadata.json"),
      JSON.stringify({
        id: "relation-only",
        name: "関連だけを持つ問題",
        shortDescription: "問題間の関連を宣言する。",
        relations: [
          {
            type: "related_to",
            source: "problem.relation-only",
            target: "problem.api-idor-demo",
          },
        ],
      }),
    );

    const graph = discoverProblemsEducationGraph(root);

    expect(graph["relation-only"]?.nodes).toEqual([]);
    expect(graph["relation-only"]?.relations).toEqual([
      {
        type: "related_to",
        source: "problem.relation-only",
        target: "problem.api-idor-demo",
      },
    ]);
  });

  it("should discover node-only metadata with an empty relation list", () => {
    const root = catalogRoot();
    const directory = path.join(root, "challenges", "node-only");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, "metadata.json"),
      JSON.stringify({
        id: "node-only",
        name: "ノードだけを持つ問題",
        nodes: {
          concepts: [{ id: "concept.node-only", description: "単独の概念" }],
        },
      }),
    );

    expect(discoverProblemsEducationGraph(root)["node-only"]).toMatchObject({
      nodes: [
        {
          id: "concept.node-only",
          type: "concept",
          label: "単独の概念",
          problemId: "node-only",
        },
      ],
      relations: [],
    });
  });

  it("should skip filesystem noise and malformed metadata without leaking partial graphs", () => {
    const root = catalogRoot();
    fs.writeFileSync(path.join(root, "README.txt"), "not a category");
    const category = path.join(root, "challenges");
    fs.mkdirSync(category);
    fs.writeFileSync(path.join(category, "README.txt"), "not a problem");
    fs.mkdirSync(path.join(category, "missing-metadata"));

    const invalidJsonDirectory = path.join(category, "invalid-json");
    fs.mkdirSync(invalidJsonDirectory);
    fs.writeFileSync(path.join(invalidJsonDirectory, "metadata.json"), "{broken");

    const missingIdDirectory = path.join(category, "missing-id");
    fs.mkdirSync(missingIdDirectory);
    fs.writeFileSync(path.join(missingIdDirectory, "metadata.json"), JSON.stringify({ nodes: {} }));

    const graphlessDirectory = path.join(category, "graphless");
    fs.mkdirSync(graphlessDirectory);
    fs.writeFileSync(
      path.join(graphlessDirectory, "metadata.json"),
      JSON.stringify({ id: "graphless", name: "グラフなし" }),
    );

    const malformedDirectory = path.join(category, "malformed-fields");
    fs.mkdirSync(malformedDirectory);
    fs.writeFileSync(
      path.join(malformedDirectory, "metadata.json"),
      JSON.stringify({
        id: "malformed-fields",
        name: 123,
        shortDescription: null,
        i18n: { en: "invalid" },
        nodes: {
          learning_objectives: "not-an-array",
          concepts: [
            {},
            { id: 123, description: "wrong id" },
            { id: "concept.wrong-description", description: 123 },
            { id: "concept.valid", description: "有効な概念" },
          ],
        },
        relations: [
          "not-an-object",
          { type: "unknown", source: "problem.malformed-fields", target: "concept.valid" },
          { type: "covers", source: 123, target: "concept.valid" },
          { type: "covers", source: "problem.malformed-fields", target: 123 },
          { type: "covers", source: "problem.malformed-fields", target: "concept.valid" },
        ],
      }),
    );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const graph = discoverProblemsEducationGraph(root);
    warn.mockRestore();

    expect(Object.keys(graph)).toEqual(["malformed-fields"]);
    expect(graph["malformed-fields"]).toMatchObject({
      problemId: "malformed-fields",
      name: { ja: "malformed-fields" },
      shortDescription: { ja: "" },
      nodes: [
        {
          id: "concept.valid",
          type: "concept",
          label: "有効な概念",
          problemId: "malformed-fields",
        },
      ],
      relations: [{ type: "covers", source: "problem.malformed-fields", target: "concept.valid" }],
    });
  });

  it("should normalize a deterministic API graph with implicit problem nodes", () => {
    const root = catalogRoot();
    writeProblem(root, "api-idor-demo");

    const response = buildEducationGraphResponse(discoverProblemsEducationGraph(root), "ja");

    expect(response.locale).toBe("ja");
    expect(response.problems).toEqual([
      { id: "api-idor-demo", name: "管理者のメモ", nodeId: "problem.api-idor-demo" },
    ]);
    expect(response.nodes[0]).toEqual({
      id: "assessment.api-idor-demo.reject-cross-user-access",
      type: "assessment_criterion",
      label: "他ユーザーへのアクセスを拒否できる",
      problemId: "api-idor-demo",
    });
    expect(response.nodes).toContainEqual({
      id: "problem.api-idor-demo",
      type: "problem",
      label: "管理者のメモ",
      problemId: "api-idor-demo",
    });
    const english = buildEducationGraphResponse(discoverProblemsEducationGraph(root), "en");
    expect(
      english.nodes.find((node) => node.id === "lo.api-idor-demo.object-authorization")?.label,
    ).toBe("Object authorization");
  });

  it("should materialize a safe node for a referenced graph-less problem", () => {
    const root = catalogRoot();
    writeProblem(root, "api-idor-demo", "rls-tenant-isolation");
    const graphlessDirectory = path.join(root, "challenges", "rls-tenant-isolation");
    fs.mkdirSync(graphlessDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(graphlessDirectory, "metadata.json"),
      JSON.stringify({
        id: "rls-tenant-isolation",
        name: "RLSで守るテナント境界",
        i18n: { en: { name: "Tenant boundaries with RLS" } },
      }),
    );

    const response = buildEducationGraphResponse(discoverProblemsEducationGraph(root), "en");

    expect(response.nodes).toContainEqual({
      id: "problem.rls-tenant-isolation",
      type: "problem",
      label: "Tenant boundaries with RLS",
      problemId: "rls-tenant-isolation",
    });
    expect(response.problems.map((problem) => problem.id)).toEqual(["api-idor-demo"]);
    for (const relation of response.relations) {
      expect(response.nodes.some((node) => node.id === relation.source)).toBe(true);
      expect(response.nodes.some((node) => node.id === relation.target)).toBe(true);
    }
  });

  it("should deduplicate declarations and infer every implicit endpoint type", () => {
    const catalog: ProblemsEducationGraph = {
      second: {
        problemId: "second",
        name: { ja: "2番目" },
        shortDescription: { ja: "" },
        nodes: [
          { id: "concept.shared", type: "concept", label: "後勝ちしてはいけない" },
          { id: "", type: "concept", label: "空ID" },
        ],
        relations: [
          { type: "related_to", source: "lo.implicit.goal", target: "concept.implicit" },
          {
            type: "related_to",
            source: "assessment.implicit.result",
            target: "misconception.implicit-belief",
          },
          {
            type: "related_to",
            source: "audience.security-engineer",
            target: "unknown.fallback-type",
          },
          { type: "related_to", source: "problem.external", target: "problem.second" },
        ],
        referencedProblems: { "problem.external": { ja: "外部問題" } },
      },
      first: {
        problemId: "first",
        name: { ja: "1番目", en: "First" },
        shortDescription: { ja: "" },
        nodes: [{ id: "concept.shared", type: "concept", label: "先に採用される" }],
        relations: [
          { type: "covers", source: "problem.first", target: "concept.shared" },
          { type: "covers", source: "problem.first", target: "concept.z-target" },
          { type: "covers", source: "problem.second", target: "concept.a-target" },
        ],
      },
    };

    const english = buildEducationGraphResponse(catalog, "en");
    const japanese = buildEducationGraphResponse(catalog, "ja");
    const typesById = new Map(english.nodes.map((node) => [node.id, node.type]));

    expect(english.problems.map((problem) => problem.id)).toEqual(["first", "second"]);
    expect(english.nodes.find((node) => node.id === "concept.shared")).toMatchObject({
      label: "Shared",
    });
    expect(english.nodes.find((node) => node.id === "")).toMatchObject({ label: "" });
    expect(
      [...typesById].filter(([id]) => id.includes("implicit") || id.includes("unknown")),
    ).toEqual([
      ["assessment.implicit.result", "assessment_criterion"],
      ["concept.implicit", "concept"],
      ["lo.implicit.goal", "learning_objective"],
      ["misconception.implicit-belief", "misconception"],
      ["unknown.fallback-type", "concept"],
    ]);
    expect(typesById.get("audience.security-engineer")).toBe("audience");
    expect(typesById.get("problem.external")).toBe("problem");
    expect(english.nodes.find((node) => node.id === "problem.external")?.label).toBe("外部問題");
    expect(japanese.nodes.find((node) => node.id === "unknown.fallback-type")?.label).toBe(
      "unknown.fallback-type",
    );
    expect(english.relations.map(({ source, target }) => `${source}->${target}`)).toEqual([
      "problem.first->concept.shared",
      "problem.first->concept.z-target",
      "problem.second->concept.a-target",
      "assessment.implicit.result->misconception.implicit-belief",
      "audience.security-engineer->unknown.fallback-type",
      "lo.implicit.goal->concept.implicit",
      "problem.external->problem.second",
    ]);
  });

  it("should project deterministic localized video, text, and quiz material", () => {
    const root = catalogRoot();
    writeProblem(root, "api-idor-demo");
    const graph = discoverProblemsEducationGraph(root);

    const first = projectEducationMaterials(graph, "api-idor-demo", "en");
    const second = projectEducationMaterials(graph, "api-idor-demo", "en");

    expect(second).toEqual(first);
    expect(first).toEqual({
      problemId: "api-idor-demo",
      locale: "en",
      materials: {
        videoScript: {
          title: "The Admin's Note - video script",
          segments: [
            { heading: "Overview", narration: "Learn object-level authorization." },
            { heading: "Learning objectives", narration: "Object authorization" },
            { heading: "Key concepts", narration: "Authorization" },
            { heading: "Assessment", narration: "Reject cross user access" },
          ],
        },
        textLesson: {
          title: "The Admin's Note - text lesson",
          sections: [
            { heading: "Overview", body: "Learn object-level authorization." },
            { heading: "Learning objectives", body: "Object authorization" },
            { heading: "Key concepts", body: "Authorization" },
            { heading: "Assessment", body: "Reject cross user access" },
          ],
        },
        quiz: {
          title: "The Admin's Note - quiz",
          questions: [
            {
              id: "quiz.assessment.api-idor-demo.reject-cross-user-access",
              prompt: "What outcome is used as an assessment criterion for The Admin's Note?",
              answer: "Reject cross user access",
              explanation:
                "This check is derived from assessment criterion assessment.api-idor-demo.reject-cross-user-access.",
            },
          ],
        },
      },
    });
    expect(JSON.stringify(first)).not.toContain("secret solution");
    expect(JSON.stringify(first)).not.toContain("secret hint");
  });

  it("should project Japanese material and omit empty material sections", () => {
    const catalog: ProblemsEducationGraph = {
      japanese: {
        problemId: "japanese",
        name: { ja: "日本語問題" },
        shortDescription: { ja: "" },
        nodes: [
          {
            id: "assessment.japanese.verify-safe-outcome",
            type: "assessment_criterion",
            label: "安全な結果を検証する",
          },
        ],
        relations: [],
      },
      empty: {
        problemId: "empty",
        name: { ja: "空の問題" },
        shortDescription: { ja: "" },
        nodes: [],
        relations: [],
      },
    };

    expect(projectEducationMaterials(catalog, "japanese", "ja")).toEqual({
      problemId: "japanese",
      locale: "ja",
      materials: {
        videoScript: {
          title: "日本語問題 - 動画台本",
          segments: [{ heading: "評価基準", narration: "安全な結果を検証する" }],
        },
        textLesson: {
          title: "日本語問題 - テキスト教材",
          sections: [{ heading: "評価基準", body: "安全な結果を検証する" }],
        },
        quiz: {
          title: "日本語問題 - 理解確認クイズ",
          questions: [
            {
              id: "quiz.assessment.japanese.verify-safe-outcome",
              prompt: "日本語問題の評価基準として求められる結果は何ですか。",
              answer: "安全な結果を検証する",
              explanation:
                "評価基準 assessment.japanese.verify-safe-outcome から生成された確認問題です。",
            },
          ],
        },
      },
    });
    expect(projectEducationMaterials(catalog, "empty", "ja")?.materials).toMatchObject({
      videoScript: { segments: [] },
      textLesson: { sections: [] },
      quiz: { questions: [] },
    });
  });

  it("should project the real English sample entirely from graph IDs without Japanese text", () => {
    const problemsRoot = path.resolve(import.meta.dirname, "..", "..", "problems");
    const graph = discoverProblemsEducationGraph(problemsRoot);

    const response = buildEducationGraphResponse(graph, "en");
    const materials = projectEducationMaterials(graph, "api-idor-demo", "en");
    const sampleNodes = response.nodes.filter(
      (node) => node.problemId === "api-idor-demo" && node.type !== "problem",
    );

    expect(sampleNodes).toContainEqual({
      id: "assessment.api-idor-demo.identify-object-authorization-failure",
      type: "assessment_criterion",
      label: "Identify object authorization failure",
      problemId: "api-idor-demo",
    });
    expect(materials?.materials.textLesson.sections).toContainEqual({
      heading: "Key concepts",
      body: "Authentication; Authorization; Broken object level authorization; Least privilege",
    });
    expect(JSON.stringify({ sampleNodes, materials })).not.toMatch(/[\u3040-\u30ff\u3400-\u9fff]/u);
  });

  it("should return undefined for a problem without graph metadata", () => {
    expect(projectEducationMaterials({}, "missing", "ja")).toBeUndefined();
  });
});
