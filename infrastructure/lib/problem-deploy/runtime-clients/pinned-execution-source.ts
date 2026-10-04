import {
  currentCatalogKey,
  loadSavedCatalog,
  type ResolvedExecutionCatalog,
} from "../handlers/shared/execution-catalog.js";

export interface ExecutionSourceLocation {
  readonly catalogKey?: string;
  readonly problemId?: string;
  readonly problemDir: string;
}

/** A configured cloud reader must resolve the saved identity, never today's mutable source. */
export async function resolvePinnedExecutionSource(
  location: ExecutionSourceLocation,
): Promise<ResolvedExecutionCatalog | undefined> {
  if (!location.catalogKey && !currentCatalogKey()) return undefined;
  const catalog = await loadSavedCatalog(location.catalogKey);
  if (!location.problemId || catalog.catalog[location.problemId] !== location.problemDir) {
    throw new Error("Problem directory does not match the saved execution catalog.");
  }
  return catalog;
}
