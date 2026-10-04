import { metadataToEntry, type ProblemMetadata } from "../../../packages/portal-contracts/src/problem-catalog";
import type { Plugin } from "vite";

const METADATA_ID = /[/\\]problems[/\\][^/\\]+[/\\][^/\\]+[/\\]metadata\.json\?(portal-catalog|portal-instructions)$/u;

/** Project before JSON becomes JavaScript; runtime mapping cannot tree-shake author fields. */
export function projectProblemCatalog(code: string, id: string): string | null {
  const match = METADATA_ID.exec(id);
  if (!match) return null;
  const metadata = JSON.parse(code) as ProblemMetadata;
  if (match[1] === "portal-instructions") {
    return JSON.stringify({
      instructions: metadata.instructions,
      englishInstructions: metadata.i18n?.en?.instructions,
    });
  }
  const entry = metadataToEntry(metadata);
  return JSON.stringify({
    ...entry,
    instructions: undefined,
    ...(entry.i18n ? { i18n: { en: { ...entry.i18n.en, instructions: undefined } } } : {}),
  });
}

export function problemCatalogPlugin(): Plugin {
  return {
    name: "tenkacloud-project-problem-catalog",
    enforce: "pre",
    transform: projectProblemCatalog,
  };
}
