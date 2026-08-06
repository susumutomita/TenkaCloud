import type { ParticipantProblemView } from "../api/portal-client";
import { categoryOf } from "../lib/category";

export type QuestCategoryFilter = "all" | "battle" | "challenge";
export type QuestDifficultyFilter = "all" | 1 | 2 | 3 | 4 | 5;
export type QuestAnswerStatusFilter = "all" | "unsolved" | "in-progress" | "cleared";

export interface QuestFilterState {
  readonly category: QuestCategoryFilter;
  readonly query: string;
  readonly difficulty: QuestDifficultyFilter;
  readonly answerStatus: QuestAnswerStatusFilter;
}

/** Participant-safe catalog fields only; author-only descriptions never enter this search index. */
export interface QuestSearchMetadata {
  readonly name?: string;
  readonly shortDescription?: string;
  readonly tags?: readonly string[];
  readonly difficulty?: 1 | 2 | 3 | 4 | 5;
  readonly i18n?: {
    readonly en?: {
      readonly name?: string;
      readonly shortDescription?: string;
    };
  };
}

export function isQuestCleared(problem: ParticipantProblemView): boolean {
  const scoring = problem.scoring;
  if (scoring?.kind === "flag") return scoring.flagSubmitted === true;
  if (scoring?.kind === "multi-flag") {
    const flags = scoring.flags ?? [];
    return flags.length > 0 && flags.every((flag) => flag.solved);
  }
  return false;
}

function answerStatusOf(problem: ParticipantProblemView): Exclude<QuestAnswerStatusFilter, "all"> {
  if (isQuestCleared(problem)) return "cleared";
  if (problem.scoring?.kind === "flag") return "unsolved";
  if (problem.scoring?.kind === "multi-flag") {
    return problem.scoring.flags?.some((flag) => flag.solved) ? "in-progress" : "unsolved";
  }
  return "in-progress";
}

function searchableText(problem: ParticipantProblemView, metadata?: QuestSearchMetadata): string {
  return [
    problem.problemId,
    metadata?.name,
    metadata?.shortDescription,
    ...(metadata?.tags ?? []),
    metadata?.i18n?.en?.name,
    metadata?.i18n?.en?.shortDescription,
  ]
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .toLocaleLowerCase();
}

/**
 * Issue #2899: every filter is an AND condition. Keeping this independent from React makes the
 * complete filter matrix testable without coupling behavior to Cloudscape component internals.
 */
export function filterQuestProblems(
  problems: readonly ParticipantProblemView[],
  filters: QuestFilterState,
  metadataByProblemId: ReadonlyMap<string, QuestSearchMetadata>,
): ParticipantProblemView[] {
  const normalizedQuery = filters.query.trim().toLocaleLowerCase();
  return problems.filter((problem) => {
    const metadata = metadataByProblemId.get(problem.problemId);
    if (filters.category !== "all" && categoryOf(problem.scoring) !== filters.category) {
      return false;
    }
    if (filters.difficulty !== "all" && metadata?.difficulty !== filters.difficulty) {
      return false;
    }
    if (filters.answerStatus !== "all" && answerStatusOf(problem) !== filters.answerStatus) {
      return false;
    }
    return (
      normalizedQuery.length === 0 || searchableText(problem, metadata).includes(normalizedQuery)
    );
  });
}
