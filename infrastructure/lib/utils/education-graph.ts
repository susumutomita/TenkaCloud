import * as fs from "node:fs";
import * as path from "node:path";

export type EducationLocale = "ja" | "en";

export type EducationNodeType =
  | "problem"
  | "learning_objective"
  | "concept"
  | "assessment_criterion"
  | "misconception"
  | "audience";

export type EducationRelationType = "teaches" | "covers" | "requires" | "assesses" | "related_to";

export interface EducationGraphNode {
  readonly id: string;
  readonly type: EducationNodeType;
  readonly label: string;
  readonly problemId?: string;
}

export interface EducationGraphRelation {
  readonly type: EducationRelationType;
  readonly source: string;
  readonly target: string;
}

interface LocalizedText {
  readonly ja: string;
  readonly en?: string;
}

export type ProblemEducationGraphNode = EducationGraphNode;

export interface ProblemEducationGraph {
  readonly problemId: string;
  readonly name: LocalizedText;
  readonly shortDescription: LocalizedText;
  readonly nodes: readonly ProblemEducationGraphNode[];
  readonly relations: readonly EducationGraphRelation[];
  /** Safe labels for implicit `problem.*` nodes referenced outside this graph. */
  readonly referencedProblems?: Readonly<Record<string, LocalizedText>>;
}

export type ProblemsEducationGraph = Readonly<Record<string, ProblemEducationGraph>>;

/** Decode the synth-baked graph catalog. Malformed input disables only this read-only feature. */
export function parseProblemsEducationGraph(raw: string | undefined): ProblemsEducationGraph {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as ProblemsEducationGraph)
      : {};
  } catch (error) {
    console.warn(
      `[parseProblemsEducationGraph] parse failed (${(error as Error).message}); graph API will be empty.`,
    );
    return {};
  }
}

export interface EducationGraphResponse {
  readonly locale: EducationLocale;
  readonly nodes: readonly EducationGraphNode[];
  readonly relations: readonly EducationGraphRelation[];
  readonly problems: readonly {
    readonly id: string;
    readonly name: string;
    readonly nodeId: string;
  }[];
}

export interface EducationMaterialsResponse {
  readonly problemId: string;
  readonly locale: EducationLocale;
  readonly materials: {
    readonly videoScript: {
      readonly title: string;
      readonly segments: readonly { readonly heading: string; readonly narration: string }[];
    };
    readonly textLesson: {
      readonly title: string;
      readonly sections: readonly { readonly heading: string; readonly body: string }[];
    };
    readonly quiz: {
      readonly title: string;
      readonly questions: readonly {
        readonly id: string;
        readonly prompt: string;
        readonly answer: string;
        readonly explanation: string;
      }[];
    };
  };
}

interface RawEducationNode {
  readonly id?: unknown;
  readonly description?: unknown;
}

const NODE_GROUPS = [
  ["learning_objectives", "learning_objective"],
  ["concepts", "concept"],
  ["assessment_criteria", "assessment_criterion"],
  ["misconceptions", "misconception"],
  ["audiences", "audience"],
] as const;

/**
 * Scan the catalog at synth time and retain only the education-safe fields.
 * `writeup`, scoring hints, instructions, runtime and deployment details are never
 * copied into this projection, so they cannot appear in the admin API bundle by accident.
 */
export function discoverProblemsEducationGraph(problemsRoot: string): ProblemsEducationGraph {
  if (!fs.existsSync(problemsRoot)) return {};
  const result: Record<string, ProblemEducationGraph> = {};
  const metadataFiles = findEducationMetadataFiles(problemsRoot);
  const problemLabels = collectProblemLabels(metadataFiles);
  for (const metadataPath of metadataFiles) {
    const projected = readEducationGraph(metadataPath);
    if (projected)
      result[projected.problemId] = {
        ...projected,
        referencedProblems: pickReferencedProblems(projected, problemLabels),
      };
  }
  return result;
}

function pickReferencedProblems(
  graph: ProblemEducationGraph,
  labels: Readonly<Record<string, LocalizedText>>,
): Record<string, LocalizedText> {
  const referenced: Record<string, LocalizedText> = {};
  for (const relation of graph.relations) {
    for (const endpoint of [relation.source, relation.target]) {
      if (endpoint === `problem.${graph.problemId}` || !endpoint.startsWith("problem.")) continue;
      const label = labels[endpoint];
      if (label) referenced[endpoint] = label;
    }
  }
  return referenced;
}

function findEducationMetadataFiles(problemsRoot: string): string[] {
  const metadataFiles: string[] = [];
  for (const category of fs.readdirSync(problemsRoot, { withFileTypes: true })) {
    if (!category.isDirectory()) continue;
    const categoryDirectory = path.join(problemsRoot, category.name);
    for (const problem of fs.readdirSync(categoryDirectory, { withFileTypes: true })) {
      if (!problem.isDirectory()) continue;
      const metadataPath = path.join(categoryDirectory, problem.name, "metadata.json");
      if (!fs.existsSync(metadataPath)) continue;
      metadataFiles.push(metadataPath);
    }
  }
  return metadataFiles;
}

function collectProblemLabels(metadataFiles: readonly string[]): Record<string, LocalizedText> {
  const labels: Record<string, LocalizedText> = {};
  for (const metadataPath of metadataFiles) {
    const identity = readProblemIdentity(metadataPath);
    if (identity) labels[`problem.${identity.problemId}`] = identity.name;
  }
  return labels;
}

function readProblemIdentity(
  metadataPath: string,
): { readonly problemId: string; readonly name: LocalizedText } | undefined {
  try {
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
    if (typeof metadata.id !== "string") return undefined;
    const i18nEn = isRecord(metadata.i18n) && isRecord(metadata.i18n.en) ? metadata.i18n.en : {};
    return {
      problemId: metadata.id,
      name: localizedText(metadata.name, i18nEn.name, metadata.id),
    };
  } catch {
    return undefined;
  }
}

function readEducationGraph(metadataPath: string): ProblemEducationGraph | undefined {
  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    console.warn(
      `[discoverProblemsEducationGraph] ${metadataPath}: parse failed (${(error as Error).message})`,
    );
    return undefined;
  }
  if (
    typeof metadata.id !== "string" ||
    (!isRecord(metadata.nodes) && !Array.isArray(metadata.relations))
  ) {
    return undefined;
  }

  const i18nEn = isRecord(metadata.i18n) && isRecord(metadata.i18n.en) ? metadata.i18n.en : {};
  const nodes = projectNodes(metadata.id, isRecord(metadata.nodes) ? metadata.nodes : {});
  const relations = Array.isArray(metadata.relations)
    ? metadata.relations.flatMap(projectRelation)
    : [];
  return {
    problemId: metadata.id,
    name: localizedText(metadata.name, i18nEn.name, metadata.id),
    shortDescription: localizedText(metadata.shortDescription, i18nEn.shortDescription, ""),
    nodes,
    relations,
  };
}

function projectNodes(
  problemId: string,
  groups: Record<string, unknown>,
): ProblemEducationGraphNode[] {
  const projected: ProblemEducationGraphNode[] = [];
  for (const [group, type] of NODE_GROUPS) {
    const rawNodes = Array.isArray(groups[group]) ? groups[group] : [];
    rawNodes.forEach((raw) => {
      const node = raw as RawEducationNode;
      if (typeof node.id !== "string" || typeof node.description !== "string") return;
      projected.push({
        id: node.id,
        type,
        label: node.description,
        problemId,
      });
    });
  }
  return projected.sort((a, b) => a.id.localeCompare(b.id));
}

function projectRelation(raw: unknown): EducationGraphRelation[] {
  if (!isRecord(raw)) return [];
  if (
    !isRelationType(raw.type) ||
    typeof raw.source !== "string" ||
    typeof raw.target !== "string"
  ) {
    return [];
  }
  return [{ type: raw.type, source: raw.source, target: raw.target }];
}

function isRelationType(value: unknown): value is EducationRelationType {
  return ["teaches", "covers", "requires", "assesses", "related_to"].includes(String(value));
}

export function buildEducationGraphResponse(
  catalog: ProblemsEducationGraph,
  locale: EducationLocale = "ja",
): EducationGraphResponse {
  const { nodes, problems, referencedProblems } = collectDeclaredNodes(catalog, locale);
  const relations = collectRelations(catalog);
  ensureRelationEndpoints(nodes, relations.values(), referencedProblems, locale);
  return {
    locale,
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    relations: [...relations.values()].sort(compareRelations),
    problems,
  };
}

function collectDeclaredNodes(catalog: ProblemsEducationGraph, locale: EducationLocale) {
  const nodes = new Map<string, EducationGraphNode>();
  const referencedProblems: Record<string, LocalizedText> = {};
  const problems: Array<{ id: string; name: string; nodeId: string }> = [];
  for (const graph of Object.values(catalog).sort((a, b) =>
    a.problemId.localeCompare(b.problemId),
  )) {
    const nodeId = `problem.${graph.problemId}`;
    const name = localized(graph.name, locale);
    problems.push({ id: graph.problemId, name, nodeId });
    nodes.set(nodeId, { id: nodeId, type: "problem", label: name, problemId: graph.problemId });
    for (const node of graph.nodes) {
      if (!nodes.has(node.id)) {
        nodes.set(node.id, {
          id: node.id,
          type: node.type,
          label: nodeLabel(node, locale),
          ...(node.problemId ? { problemId: node.problemId } : {}),
        });
      }
    }
    Object.assign(referencedProblems, graph.referencedProblems);
  }
  return { nodes, problems, referencedProblems };
}

function collectRelations(catalog: ProblemsEducationGraph): Map<string, EducationGraphRelation> {
  const relations = new Map<string, EducationGraphRelation>();
  for (const graph of Object.values(catalog)) {
    for (const relation of graph.relations) {
      relations.set(`${relation.type}\u0000${relation.source}\u0000${relation.target}`, relation);
    }
  }
  return relations;
}

function ensureRelationEndpoints(
  nodes: Map<string, EducationGraphNode>,
  relations: Iterable<EducationGraphRelation>,
  referencedProblems: Readonly<Record<string, LocalizedText>>,
  locale: EducationLocale,
): void {
  for (const relation of relations) {
    for (const endpoint of [relation.source, relation.target]) {
      if (nodes.has(endpoint)) continue;
      const type = nodeTypeFromId(endpoint);
      const problemId = type === "problem" ? endpoint.slice("problem.".length) : undefined;
      nodes.set(endpoint, {
        id: endpoint,
        type,
        label: relationEndpointLabel(endpoint, referencedProblems, locale),
        ...(problemId ? { problemId } : {}),
      });
    }
  }
}

function relationEndpointLabel(
  endpoint: string,
  referencedProblems: Readonly<Record<string, LocalizedText>>,
  locale: EducationLocale,
): string {
  const problemLabel = referencedProblems[endpoint];
  if (problemLabel) return localized(problemLabel, locale);
  return locale === "en" ? humanizeNodeId(endpoint) : endpoint;
}

export function projectEducationMaterials(
  catalog: ProblemsEducationGraph,
  problemId: string,
  locale: EducationLocale,
): EducationMaterialsResponse | undefined {
  if (!Object.hasOwn(catalog, problemId)) return undefined;
  const graph = catalog[problemId];
  const name = localized(graph.name, locale);
  const summary = localized(graph.shortDescription, locale);
  const objectives = labelsOf(graph, "learning_objective", locale);
  const concepts = labelsOf(graph, "concept", locale);
  const assessments = labelsOf(graph, "assessment_criterion", locale);
  const videoParts = materialParts(locale, summary, objectives, concepts, assessments);
  const quizSources = graph.nodes.filter((node) => node.type === "assessment_criterion");
  return {
    problemId,
    locale,
    materials: {
      videoScript: {
        title: locale === "ja" ? `${name} - 動画台本` : `${name} - video script`,
        segments: videoParts.map(({ heading, body }) => ({ heading, narration: body })),
      },
      textLesson: {
        title: locale === "ja" ? `${name} - テキスト教材` : `${name} - text lesson`,
        sections: videoParts,
      },
      quiz: {
        title: locale === "ja" ? `${name} - 理解確認クイズ` : `${name} - quiz`,
        questions: quizSources.map((node) => {
          const answer = nodeLabel(node, locale);
          return {
            id: `quiz.${node.id}`,
            prompt:
              locale === "ja"
                ? `${name}の評価基準として求められる結果は何ですか。`
                : `What outcome is used as an assessment criterion for ${name}?`,
            answer,
            explanation:
              locale === "ja"
                ? `評価基準 ${node.id} から生成された確認問題です。`
                : `This check is derived from assessment criterion ${node.id}.`,
          };
        }),
      },
    },
  };
}

function materialParts(
  locale: EducationLocale,
  summary: string,
  objectives: readonly string[],
  concepts: readonly string[],
  assessments: readonly string[],
): Array<{ heading: string; body: string }> {
  const join = (values: readonly string[]) => values.join(locale === "ja" ? "、" : "; ");
  const candidates = [
    { heading: locale === "ja" ? "概要" : "Overview", body: summary },
    {
      heading: locale === "ja" ? "学習目標" : "Learning objectives",
      body: join(objectives),
    },
    { heading: locale === "ja" ? "主要概念" : "Key concepts", body: join(concepts) },
    { heading: locale === "ja" ? "評価基準" : "Assessment", body: join(assessments) },
  ];
  return candidates.filter((part) => part.body.length > 0);
}

function labelsOf(
  graph: ProblemEducationGraph,
  type: EducationNodeType,
  locale: EducationLocale,
): string[] {
  return graph.nodes.filter((node) => node.type === type).map((node) => nodeLabel(node, locale));
}

function nodeLabel(node: ProblemEducationGraphNode, locale: EducationLocale): string {
  return locale === "en" ? humanizeNodeId(node.id) : node.label;
}

function humanizeNodeId(id: string): string {
  const slug = id.split(".").at(-1) ?? id;
  const words = slug.replace(/-+/g, " ");
  return words.length > 0 ? `${words[0].toUpperCase()}${words.slice(1)}` : id;
}

function compareRelations(a: EducationGraphRelation, b: EducationGraphRelation): number {
  return (
    a.type.localeCompare(b.type) ||
    a.source.localeCompare(b.source) ||
    a.target.localeCompare(b.target)
  );
}

function nodeTypeFromId(id: string): EducationNodeType {
  if (id.startsWith("problem.")) return "problem";
  if (id.startsWith("lo.")) return "learning_objective";
  if (id.startsWith("concept.")) return "concept";
  if (id.startsWith("assessment.")) return "assessment_criterion";
  if (id.startsWith("misconception.")) return "misconception";
  if (id.startsWith("audience.")) return "audience";
  return "concept";
}

function localized(value: LocalizedText, locale: EducationLocale): string {
  return locale === "en" ? (value.en ?? value.ja) : value.ja;
}

function localizedText(ja: unknown, en: unknown, fallback: string): LocalizedText {
  return {
    ja: typeof ja === "string" && ja.length > 0 ? ja : fallback,
    ...(typeof en === "string" && en.length > 0 ? { en } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
