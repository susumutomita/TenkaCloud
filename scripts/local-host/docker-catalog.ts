import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertComposePolicy } from "./container/compose-policy";
import { type ContainerProblem, loadContainerProblem } from "./container/manifest";
import { type Job, organizerProblemContent, type Problem } from "./model";

export interface DockerDefinition {
  readonly problem: ContainerProblem;
  readonly hashes: Readonly<Record<string, string>>;
  readonly composeText: string;
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
    .filter((group) => group.isDirectory() && !group.name.startsWith("."))
    .flatMap((group) =>
      readdirSync(join(catalog, group.name), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(catalog, group.name, entry.name)),
    );
}

function catalogProblem(directory: string): Problem | undefined {
  const metadataPath = join(directory, "metadata.json");
  if (!existsSync(metadataPath)) return undefined;
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
  if (!eligible(metadata)) return undefined;
  const problem = loadContainerProblem(directory);
  const composeText = readFileSync(problem.composePath, "utf8");
  assertComposePolicy(composeText, { problemDir: directory, composePath: problem.composePath });
  const origins = new Set(
    Object.values(problem.challengeEndpoints).map((url) => new URL(url).origin),
  );
  if (origins.size > 1)
    throw new Error(
      `${problem.problemId} needs multiple isolated gateway origins; it cannot be offered yet.`,
    );
  const definition: DockerDefinition = { problem, composeText, hashes: sourceHashes(directory) };
  return {
    problemId: problem.problemId,
    name: problem.name,
    organizerContent: organizerProblemContent(metadata),
    runtime: "docker",
    definition: JSON.stringify(definition),
  };
}

/** Reuse the same manifest and Compose policy as individual local practice. */
export function loadDockerCatalog(repositoryRoot: string): Problem[] {
  const result: Problem[] = [];
  const ids = new Set<string>();
  for (const directory of problemDirectories(join(repositoryRoot, "problems"))) {
    const problem = catalogProblem(directory);
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
