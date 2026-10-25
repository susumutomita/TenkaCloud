import { CatalogMutationActive } from "./catalog-read.js";
import { type CatalogImport, CatalogSourceFailure } from "./downloaded-catalog.js";

/** Log only validated source identity, never transport errors, credentials or URL queries. */
function sourceIdentity(source: CatalogSourceFailure["source"]) {
  if ("path" in source) return { kind: "local", path: source.path };
  let url: URL;
  try {
    url = new URL(source.url);
    if (url.protocol !== "https:") return { kind: "git", url: "[invalid HTTPS URL]" };
  } catch {
    return { kind: "git", url: "[invalid HTTPS URL]" };
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return { kind: "git", url: url.href };
}

/** Acquisition returns only after every source validates and the selection is committed. */
export function logCatalogImport(
  acquire: () => CatalogImport,
  log: (message: string) => void = console.log,
): void {
  log("Catalog import started.");
  let imported: CatalogImport;
  try {
    imported = acquire();
  } catch (error) {
    const failure =
      error instanceof Error &&
      (error.cause instanceof CatalogSourceFailure || error.cause instanceof CatalogMutationActive)
        ? error.cause
        : error;
    let context = " Check catalog source configuration, access and validation.";
    if (failure instanceof CatalogMutationActive) context = ` ${failure.message}`;
    else if (failure instanceof CatalogSourceFailure) {
      context = ` Source ${failure.sourceNumber} (selected catalog): ${JSON.stringify(sourceIdentity(failure.source))}.${context}`;
    }
    // Child-process and validation errors can contain URLs with tokens or file contents.
    // The launcher prints this message; do not attach the unsafe original as a cause.
    throw new Error(`Catalog import failed; startup/build stopped.${context}`);
  }
  for (const { revision, problemCount } of imported)
    log(
      `Catalog imported: ${JSON.stringify({ ...sourceIdentity(revision), ...("url" in revision ? { ref: revision.ref, commit: revision.commit, subdir: revision.subdir } : {}), digest: revision.digest, problems: problemCount })}`,
    );
  const total = imported.reduce((count, source) => count + source.problemCount, 0);
  log(
    `Catalog import complete: sources=${imported.length} problems=${total}. Existing events retain their pinned snapshots.`,
  );
}
