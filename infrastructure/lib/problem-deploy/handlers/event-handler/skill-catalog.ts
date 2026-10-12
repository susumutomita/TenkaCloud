import {
  type SkillCatalogSnapshot,
  skillDeclarations,
  skillScoringKind,
} from "../../../../../packages/portal-contracts/src/skill-evidence.js";
import type { ResolvedExecutionCatalog } from "../shared/execution-catalog.js";

/** Only verified saved catalog identity; never consult today's catalog for an old event. */
export function cloudSkillCatalog(
  catalog: ResolvedExecutionCatalog | undefined,
  problemId: string,
): SkillCatalogSnapshot | undefined {
  const declarations = skillDeclarations(catalog?.skills?.[problemId]);
  const digest = /^catalogs\/([a-f0-9]{64})\.json$/u.exec(catalog?.catalogKey ?? "")?.[1];
  if (!declarations || !digest) return undefined;
  return {
    revision: `sha256:${digest}`,
    scoringKind: skillScoringKind(catalog?.scoring[problemId]),
    declarations,
  };
}
