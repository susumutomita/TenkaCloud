import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { computeContentDigest } from "../../packages/problem-sdk/src/content-digest.js";
import { resolveInside } from "../../packages/problem-sdk/src/safe-path.js";
import { restoreSourcePermissions } from "./source-permissions.js";

const GitSourceSchema = z
  .object({ url: z.string(), ref: z.string().min(1), subdir: z.string().optional() })
  .strict();
const LocalSourceSchema = z.object({ path: z.string().trim().min(1) }).strict();
export const SourceSchema = z.union([GitSourceSchema, LocalSourceSchema]);
const revisionFields = {
  commit: z.string().regex(/^[a-f0-9]{40}$/u),
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  problemsRoot: z
    .string()
    .transform((value) => value.replace(/^(?:\.\/)+/u, ""))
    .refine(
      (value) =>
        value === "." ||
        value
          .split("/")
          .every(
            (segment) => segment !== "." && segment !== ".." && /^[A-Za-z0-9._-]+$/u.test(segment),
          ),
      "Invalid problems root",
    ),
};
const RevisionSchema = z.union([
  GitSourceSchema.extend(revisionFields).strict(),
  LocalSourceSchema.extend(revisionFields).strict(),
]);
export const SelectionSchema = z
  .object({
    schemaVersion: z.literal(1),
    sources: z.array(SourceSchema).min(1),
    retained: z.array(RevisionSchema).optional(),
  })
  .strict();
export const CatalogLockSchema = z
  .object({
    schemaVersion: z.literal(1),
    sources: z.array(RevisionSchema).min(1),
    retained: z.array(RevisionSchema).optional(),
  })
  .strict();
export type Revision = z.infer<typeof RevisionSchema>;
export const store = (root: string) => join(root, ".tenkacloud/catalog-store");
export const snapshot = (root: string, digest: string) => join(store(root), "snapshots", digest);
export const lockPath = (root: string) => join(store(root), "selected.json");

/** Runtime reads only a completed acquisition; the launcher resolves configured sources first. */
export function readCatalogSelection(root: string): string {
  try {
    return readFileSync(lockPath(root), "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      throw new Error(
        "No downloaded problem catalog is selected. Configure the repository URL and branch " +
          "in catalog-sources.json, then run `make local`. For build-only preparation use " +
          "`make catalog-download CATALOG_SOURCES=my-catalogs.json`.",
        { cause: error },
      );
    throw error;
  }
}
/** Verify every selected revision and return immutable source roots. No core fallback. */
export function selectedCatalogSnapshots(root: string) {
  const selected = CatalogLockSchema.parse(JSON.parse(readCatalogSelection(root)));
  return selected.sources.map((revision) => {
    const directory = snapshot(root, revision.digest);
    if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory())
      throw new Error("Catalog snapshot must be an unlinked directory");
    if (computeContentDigest(directory, true) !== revision.digest)
      throw new Error("Catalog snapshot digest mismatch");
    restoreSourcePermissions(directory);
    const problemRoot = resolveInside(directory, revision.problemsRoot);
    if (!problemRoot || !existsSync(problemRoot)) throw new Error("Invalid problems root");
    return { revision, directory, problemRoot };
  });
}
export function selectedCatalogRoots(root: string): string[] {
  return selectedCatalogSnapshots(root).map((entry) => entry.problemRoot);
}

/** Retained snapshots are available only to explicit builds of old event UI modules. */
export function retainedCatalogSnapshots(root: string) {
  const selected = CatalogLockSchema.parse(JSON.parse(readCatalogSelection(root)));
  const accepted = [...selected.sources, ...(selected.retained ?? [])];
  return [
    ...new Map(
      accepted.map((revision) => [`${revision.commit}:${revision.digest}`, revision]),
    ).values(),
  ].map((revision) => {
    const directory = snapshot(root, revision.digest);
    if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory())
      throw new Error("Catalog snapshot must be an unlinked directory");
    if (computeContentDigest(directory, true) !== revision.digest)
      throw new Error("Retained catalog snapshot digest mismatch");
    restoreSourcePermissions(directory);
    const problemRoot = resolveInside(directory, revision.problemsRoot);
    if (!problemRoot || !existsSync(problemRoot)) throw new Error("Invalid problems root");
    return { revision, directory, problemRoot };
  });
}
export function retainedCatalogRoots(root: string): string[] {
  return [...new Set(retainedCatalogSnapshots(root).map((entry) => entry.problemRoot))];
}

export function withCatalogMutation<T>(root: string, operation: () => T): T {
  mkdirSync(store(root), { recursive: true });
  const lock = join(store(root), "mutation.lock");
  try {
    mkdirSync(lock);
  } catch {
    throw new Error(
      "Another catalog operation is active; check its process before recovering mutation.lock",
    );
  }
  try {
    return operation();
  } finally {
    rmSync(lock, { recursive: true });
  }
}

/** Adapt the SDK's title/category vocabulary at the existing catalog boundary. */
export function catalogMetadata(raw: Record<string, unknown>): Record<string, unknown> {
  if (typeof raw.name === "string") return raw;
  const runtime = raw.runtime as { provider?: string; engine?: string; entry?: string } | undefined;
  return {
    ...raw,
    name: raw.title ?? raw.id,
    category: raw.category === "battles" ? "Battle" : "Challenge",
    status: raw.status ?? "ready",
    difficulty: raw.difficulty ?? 1,
    estimatedDuration: raw.estimatedDuration ?? "",
    shortDescription: raw.shortDescription ?? "",
    learningGoals: raw.learningGoals ?? [],
    tags: raw.tags ?? [],
    ...(runtime?.provider === "aws" && runtime.engine === "cloudformation"
      ? { cfnTemplate: raw.cfnTemplate ?? runtime.entry }
      : {}),
  };
}
