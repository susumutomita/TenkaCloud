import type { ProblemTranslation } from "./problem-types";

/** Apply each available English field independently; retain authored Japanese fallbacks. */
export function localizeProblemText<
  T extends ProblemTranslation & { readonly i18n?: { readonly en?: ProblemTranslation } },
>(problem: T, locale: string): T {
  if (locale !== "en" || !problem.i18n?.en) return problem;
  const english = problem.i18n.en;
  return {
    ...problem,
    ...(english.name?.trim() ? { name: english.name } : {}),
    ...(english.shortDescription?.trim() ? { shortDescription: english.shortDescription } : {}),
    ...(english.description?.trim() ? { description: english.description } : {}),
    ...(english.estimatedDuration?.trim() ? { estimatedDuration: english.estimatedDuration } : {}),
    ...(english.learningGoals ? { learningGoals: english.learningGoals } : {}),
  };
}

export function localizeOptionalProblem<
  T extends ProblemTranslation & { readonly i18n?: { readonly en?: ProblemTranslation } },
>(problem: T | undefined, locale: string): T | undefined {
  return problem ? localizeProblemText(problem, locale) : undefined;
}
