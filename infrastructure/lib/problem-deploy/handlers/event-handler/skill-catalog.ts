import {
  type SkillCatalogSnapshot,
  skillDeclarations,
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
  const scoring = catalog?.scoring[problemId] as { kind?: unknown } | undefined;
  return {
    revision: `sha256:${digest}`,
    scoringKind: typeof scoring?.kind === "string" ? scoring.kind : "unknown",
    declarations,
  };
}
