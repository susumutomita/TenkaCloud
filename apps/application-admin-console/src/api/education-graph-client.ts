import type { ApiClient } from "./client";

export type EducationGraphLocale = "ja" | "en";

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

export interface EducationGraphProblem {
  readonly id: string;
  readonly name: string;
  readonly nodeId: string;
}

export interface EducationGraphResponse {
  readonly locale: EducationGraphLocale;
  readonly nodes: readonly EducationGraphNode[];
  readonly relations: readonly EducationGraphRelation[];
  readonly problems: readonly EducationGraphProblem[];
}

export interface VideoScriptProjection {
  readonly title: string;
  readonly segments: readonly { readonly heading: string; readonly narration: string }[];
}

export interface TextLessonProjection {
  readonly title: string;
  readonly sections: readonly { readonly heading: string; readonly body: string }[];
}

export interface QuizProjection {
  readonly title: string;
  readonly questions: readonly {
    readonly id: string;
    readonly prompt: string;
    readonly answer: string;
    readonly explanation: string;
  }[];
}

export interface EducationMaterialsResponse {
  readonly problemId: string;
  readonly locale: EducationGraphLocale;
  readonly materials: {
    readonly videoScript: VideoScriptProjection;
    readonly textLesson: TextLessonProjection;
    readonly quiz: QuizProjection;
  };
}

export function getEducationGraph(
  client: ApiClient,
  locale: EducationGraphLocale,
): Promise<EducationGraphResponse> {
  return client.get<EducationGraphResponse>(`/admin/education-graph?locale=${locale}`);
}

export function getEducationMaterials(
  client: ApiClient,
  problemId: string,
  locale: EducationGraphLocale,
): Promise<EducationMaterialsResponse> {
  return client.get<EducationMaterialsResponse>(
    `/admin/education-graph/problems/${encodeURIComponent(problemId)}/materials?locale=${locale}`,
  );
}
