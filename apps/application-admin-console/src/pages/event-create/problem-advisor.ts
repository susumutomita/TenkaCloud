import { localizeProblemText } from "../../data/problem-locale";
import { type ProblemSummary, runtimeProviders } from "../../data/problems";
import type { HostCatalog } from "./LocalHostEventCreate";

// Explicit allowlist: never serialize content/i18n wholesale (operator descriptions,
// instructions, hints, answers and writeups are not inputs to this model).
export function advisorCatalog(
  problems: readonly ProblemSummary[],
  catalog: HostCatalog,
  locale: string,
) {
  return problems
    .filter((p) => catalog.supported.has(p.id))
    .map((p) => {
      const content = catalog.content?.get(p.id);
      const goals = content ? localizeProblemText(content, locale).learningGoals : [];
      return {
        id: p.id,
        name: p.name,
        summary: p.shortDescription,
        goals: goals ?? [],
        difficulty: p.difficulty,
        tags: p.tags,
        runtime: runtimeProviders(p.runtime),
        duration: p.estimatedDuration,
      };
    });
}
