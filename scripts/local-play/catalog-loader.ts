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
 *
 * [#2906 / ADR-055] `TENKACLOUD_PROBLEMS_HOST_PATH`, set only by the
 * containerized entrypoint, overrides `<repoRoot>/problems` with the REAL
 * host-absolute path `problems/` is bind-mounted at. Every per-problem
 * compose file's relative bind mounts get resolved by `docker compose`
 * running inside the control-plane container, but the socket it talks to is
 * the HOST daemon — the daemon resolves whatever absolute path string it
 * receives against its OWN (host) filesystem, not the container's. Search
 * roots derived from the container-local `/app/problems` would therefore
 * name a path that does not exist on the host, and Compose silently creates
 * an empty directory there instead of erroring — breaking every problem
 * with a relative bind (confirmed for 13 catalog problems including
 * wp-exposed-backup's `wpinit` init script). The host launcher
 * (`scripts/local/docker-launcher.sh`) mounts `problems/` at this identical
 * absolute path specifically so paths built from it stay daemon-resolvable.
 */
export function problemSearchRoots(repoRoot: string): string[] {
  const problemsRoot = process.env.TENKACLOUD_PROBLEMS_HOST_PATH || join(repoRoot, "problems");
  return [join(problemsRoot, "challenges"), join(problemsRoot, "battles")];
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

/**
 * [#2696 PR5] The platform's one fixed intro drill for local play. It must be a
 * real container problem because the local catalog excludes AWS-only problems.
 * `sqli-demo` is the documented reference container problem and works with the
 * default Docker runtime. A single named constant keeps the pin decision in one
 * place instead of being re-decided per caller / component.
 */
export const LOCAL_INTRO_DRILL_PROBLEM_ID = "sqli-demo";

/**
 * Move the intro drill to the front of `items`, keeping every other entry in
 * its existing relative order. A no-op when the drill is absent from `items`
 * (e.g. a stripped-down fixture) or is already first — so the learner's
 * catalog always opens on one obvious first click. Used by both the portal
 * catalog ({@link loadLocalPlayCatalog}) and `tenkacloud local list`, so
 * ordering never has to be re-decided in a frontend component.
 */
export function pinIntroDrillFirst<T extends { readonly problemId: string }>(
  items: readonly T[],
): T[] {
  const introIndex = items.findIndex((item) => item.problemId === LOCAL_INTRO_DRILL_PROBLEM_ID);
  if (introIndex <= 0) return [...items];
  const intro = items[introIndex] as T;
  return [intro, ...items.slice(0, introIndex), ...items.slice(introIndex + 1)];
}

/** Load the full local-play catalog, self-healing an uninitialized problems/ submodule first. */
export function loadLocalPlayCatalog(repoRoot: string, roots: string[]) {
  const load = () =>
    pinIntroDrillFirst(
      listLocalPlayProblems(roots).map((summary) =>
        loadContainerProblem(resolveProblemDir(roots, summary.problemId)),
      ),
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
