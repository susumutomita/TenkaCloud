import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { computeContentDigest } from "../../packages/problem-sdk/src/content-digest";
import { catalogMetadata, selectedCatalogSnapshots } from "../problem-pack/catalog-read";
import { restoreSourcePermissions } from "../problem-pack/source-permissions.js";
import { publicCatalogEntry } from "./catalog-projection";
import { assertComposePolicy } from "./container/compose-policy";
import { type ContainerProblem, loadContainerProblem } from "./container/manifest";
import { type Job, organizerProblemContent, type Problem } from "./model";
import { skillCatalog } from "./skill-catalog";

export interface DockerDefinition {
  readonly problem: ContainerProblem;
  readonly hashes: Readonly<Record<string, string>>;
  readonly composeText: string;
  readonly catalogSnapshot?: {
    readonly root: string;
    readonly digest: string;
    readonly source?: unknown;
  };
}

const excludedDirectories = new Set([".git", "node_modules", ".tenkacloud", "coverage"]);
const fingerprint = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

function sourceHashes(directory: string, relative = ""): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of readdirSync(join(directory, relative), { withFileTypes: true }).sort(
    (left, right) => left.name.localeCompare(right.name),
  )) {
    if (excludedDirectories.has(entry.name) || /^\.env(?:\.|$)/u.test(entry.name)) continue;
    const path = join(relative, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Problem source must not contain a symbolic link: ${path}`);
    if (entry.isDirectory()) Object.assign(result, sourceHashes(directory, path));
    else if (entry.isFile()) result[path] = fingerprint(join(directory, path));
    else throw new Error(`Unsupported problem source file: ${path}`);
  }
  return result;
}

function eligible(metadata: Record<string, unknown>): boolean {
  const runtime = metadata.runtime as Record<string, unknown> | undefined;
  const scoring = metadata.scoring as Record<string, unknown> | undefined;
  return (
    runtime?.provider === "docker" &&
    runtime.engine === "compose" &&
    (scoring?.kind === "verify" || scoring?.kind === "multi-verify")
  );
}

function problemDirectories(catalog: string): string[] {
  return readdirSync(catalog, { withFileTypes: true })
    .filter((group) => group.isDirectory() && ["challenges", "battles"].includes(group.name))
    .flatMap((group) =>
      readdirSync(join(catalog, group.name), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(catalog, group.name, entry.name)),
    );
}

function catalogProblem(
  directory: string,
  catalogSnapshot?: DockerDefinition["catalogSnapshot"],
): Problem | undefined {
  const metadataPath = join(directory, "metadata.json");
  if (!existsSync(metadataPath)) return undefined;
  const metadata = catalogMetadata(JSON.parse(readFileSync(metadataPath, "utf8")));
  if (!eligible(metadata)) return undefined;
  const problem = loadContainerProblem(directory, {
    existsSync,
    realpathSync,
    readFileSync: (path) =>
      path === metadataPath ? JSON.stringify(metadata) : readFileSync(path, "utf8"),
  });
  const composeText = readFileSync(problem.composePath, "utf8");
  assertComposePolicy(composeText, { problemDir: directory, composePath: problem.composePath });
  const origins = new Set(
    Object.values(problem.challengeEndpoints).map((url) => new URL(url).origin),
  );
  if (origins.size > 1)
    throw new Error(
      `${problem.problemId} needs multiple isolated gateway origins; it cannot be offered yet.`,
    );
  const definition: DockerDefinition = {
    problem,
    composeText,
    hashes: sourceHashes(directory),
    ...(catalogSnapshot ? { catalogSnapshot } : {}),
  };
  return {
    problemId: problem.problemId,
    name: problem.name,
    publicCatalog: publicCatalogEntry(metadata, directory),
    organizerContent: organizerProblemContent(metadata),
    runtime: "docker",
    definition: JSON.stringify(definition),
    skillCatalog: skillCatalog(metadata, JSON.stringify(definition)),
  };
}

/** Reuse the same manifest and Compose policy as individual local practice. */
export function loadDockerCatalog(
  repositoryRoot: string,
  catalogRoots?: readonly string[],
): Problem[] {
  const result: Problem[] = [];
  const ids = new Set<string>();
  const entries = catalogRoots
    ? catalogRoots.flatMap((catalog) =>
        problemDirectories(catalog).map((directory) => ({ directory, catalogSnapshot: undefined })),
      )
    : selectedCatalogSnapshots(repositoryRoot).flatMap(
        ({ problemRoot, directory: root, revision }) =>
          problemDirectories(problemRoot).map((directory) => ({
            directory,
            catalogSnapshot: { root, digest: revision.digest, source: revision },
          })),
      );
  for (const { directory, catalogSnapshot } of entries) {
    const problem = catalogProblem(directory, catalogSnapshot);
    if (!problem) continue;
    if (ids.has(problem.problemId))
      throw new Error(`Duplicate local problem ID: ${problem.problemId}`);
    ids.add(problem.problemId);
    result.push(problem);
  }
  return result.sort((left, right) => {
    if (left.problemId === "sqli-demo") return -1;
    if (right.problemId === "sqli-demo") return 1;
    return left.problemId.localeCompare(right.problemId);
  });
}

export function dockerDefinitionOf(job: Job, verifySources: boolean): DockerDefinition {
  const definition = JSON.parse(job.definition) as DockerDefinition;
  if (verifySources) {
    if (
      definition.catalogSnapshot &&
      computeContentDigest(definition.catalogSnapshot.root, true) !==
        definition.catalogSnapshot.digest
    )
      throw new Error("The event’s pinned catalog snapshot changed.");
    if (definition.catalogSnapshot) restoreSourcePermissions(definition.catalogSnapshot.root);
    const actual = sourceHashes(definition.problem.problemDir);
    const changed =
      Object.keys(actual).length !== Object.keys(definition.hashes).length ||
      Object.entries(definition.hashes).some(([path, expected]) => actual[path] !== expected);
    if (changed)
      throw new Error(
        "The event's pinned problem files changed. Restore the original catalog before continuing.",
      );
  }
  return definition;
}
