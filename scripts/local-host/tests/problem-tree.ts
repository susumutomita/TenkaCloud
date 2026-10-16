import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface ProblemMetadata {
  runtime?: { provider?: string; terminal?: unknown };
}

/** Reads problems/ directly so catalog-size assertions do not depend on the loaders under test. */
function dockerProblems(root: string): { path: string; metadata: ProblemMetadata }[] {
  const found: { path: string; metadata: ProblemMetadata }[] = [];
  for (const category of ["challenges", "battles"]) {
    const directory = join(root, "problems", category);
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name, "metadata.json");
      if (!entry.isDirectory() || !existsSync(file)) continue;
      const metadata = JSON.parse(readFileSync(file, "utf8")) as ProblemMetadata;
      if (metadata.runtime?.provider === "docker")
        found.push({ path: `${category}/${entry.name}`, metadata });
    }
  }
  return found.sort((left, right) => left.path.localeCompare(right.path));
}

export function dockerProblemPaths(root: string): string[] {
  return dockerProblems(root).map(({ path }) => path);
}

export function terminalProblemIds(root: string): string[] {
  return dockerProblems(root)
    .filter(({ metadata }) => metadata.runtime?.terminal !== undefined)
    .map(({ path }) => path.split("/").at(-1) as string);
}

export function dockerProblemIds(root: string): string[] {
  return dockerProblemPaths(root).map((path) => path.split("/").at(-1) as string);
}
