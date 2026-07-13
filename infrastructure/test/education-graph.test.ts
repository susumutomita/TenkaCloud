import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildEducationGraphResponse,
  discoverProblemsEducationGraph,
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
