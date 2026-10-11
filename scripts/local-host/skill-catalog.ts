import { createHash } from "node:crypto";
import {
  type SkillCatalogSnapshot,
  skillDeclarations,
} from "../../packages/portal-contracts/src/skill-evidence";

/** Exact metadata + runtime definition snapshot identity, retained on the event, not a guessed Git SHA. */
export function skillCatalog(
  metadata: { readonly skillEvidence?: unknown; readonly scoring?: unknown },
  definition: string,
): SkillCatalogSnapshot | undefined {
  const declarations = skillDeclarations(metadata.skillEvidence);
  if (!declarations) return undefined;
  const scoring = metadata.scoring as { kind?: unknown } | undefined;
  return {
    revision: `sha256:${createHash("sha256").update(JSON.stringify(metadata)).update("\n").update(definition).digest("hex")}`,
    scoringKind: typeof scoring?.kind === "string" ? scoring.kind : "unknown",
    declarations,
  };
}
