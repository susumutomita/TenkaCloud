import type { ProblemAuthor } from "@tenkacloud/portal-contracts";
import type { AppConfig } from "../config";

type Credits = { readonly authors?: readonly ProblemAuthor[] } | undefined;

/** A pinned uncredited runtime must not inherit a later bundle's author names. */
export function resolveProblemAuthors(runtime: Credits, catalog: Credits, config: AppConfig) {
  if (config.problemAuthorsSource === "runtime" || config.cloudMode === "local")
    return runtime?.authors;
  return runtime?.authors ?? catalog?.authors;
}
