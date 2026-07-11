import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CommandSucceeds } from "./docker-adapter";
import { listLocalPlayProblems, loadContainerProblem, resolveProblemDir } from "./manifest";

/**
 * [#2527 Slice 6] Local-play catalog loading, extracted verbatim from
 * `scripts/tenkacloud-local.ts`: the catalog search roots, the problems/-submodule
 * self-heal, and the full-catalog load `up` serves.
 */

/**
 * The catalog groups, searched in order. Problems live only in the
 * TenkaCloudChallenge catalog (the `problems/` submodule) — never in the
 * platform repo (ADR-008 / ADR-012).
 */
export function problemSearchRoots(repoRoot: string): string[] {
  return [join(repoRoot, "problems", "challenges"), join(repoRoot, "problems", "battles")];
}

/**
 * A plain clone (and a fresh Codespace) leaves the problems/ submodule empty,
 * and local play used to bail with a manual "run git submodule update --init"
 * step — the one command players kept tripping on. Submodule checkout installs
 * no software (the onboarder already classifies it "safe-auto" in
 * scripts/onboard/plan.ts), so run it automatically when the catalog is empty
 * and the submodule is registered. Returns true when the init succeeded —
 * callers re-scan the catalog then.
 */
export function autoInitProblemsSubmodule(
  repoRoot: string,
  run: CommandSucceeds = (command, args) =>
    spawnSync(command, [...args], { cwd: repoRoot, stdio: "inherit" }).status === 0,
  fileExists: (path: string) => boolean = existsSync,
): boolean {
  if (!fileExists(join(repoRoot, ".gitmodules"))) return false;
  console.log("problems/ catalog is empty — fetching it: git submodule update --init problems");
  return run("git", ["submodule", "update", "--init", "problems"]);
}

/** Load the full local-play catalog, self-healing an uninitialized problems/ submodule first. */
export function loadLocalPlayCatalog(repoRoot: string, roots: string[]) {
  const load = () =>
    listLocalPlayProblems(roots).map((summary) =>
      loadContainerProblem(resolveProblemDir(roots, summary.problemId)),
    );
  let catalog = load();
  if (catalog.length === 0 && autoInitProblemsSubmodule(repoRoot)) {
    catalog = load();
  }
  if (catalog.length === 0) {
    throw new Error(
      "No local-play problems found. Run `git submodule update --init` to fetch the problems/ catalog.",
    );
  }
  return catalog;
}
