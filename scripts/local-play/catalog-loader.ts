import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  metadataToEntry,
  type ProblemCatalogEntry,
  type ProblemMetadata,
} from "@tenkacloud/portal-contracts";
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
 * platform repo. This keeps problem content owned by one pinned catalog.
 *
 * [#2906] `TENKACLOUD_PROBLEMS_HOST_PATH`, set only by the
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

/** Injection seam for {@link loadProblemCatalogEntries} (tests supply a fake tree). */
export interface CatalogFs {
  readonly existsSync: (path: string) => boolean;
  readonly readFileSync: (path: string) => string;
  readonly readDirNames: (path: string) => readonly string[];
}

const CATALOG_FS: CatalogFs = {
  existsSync,
  readFileSync: (path) => readFileSync(path, "utf8"),
  readDirNames: (path) =>
    existsSync(path) ? readdirSync(path, { withFileTypes: true }).map((entry) => entry.name) : [],
};

/** One problem directory that has a metadata.json but could not be projected. */
export interface SkippedCatalogEntry {
  readonly problemId: string;
  readonly reason: string;
}

export interface ProblemCatalogSource {
  readonly entries: readonly ProblemCatalogEntry[];
  /**
   * Directories that hold a metadata.json but produced no entry. Surfaced rather than
   * dropped: a silently missing problem looks identical to a problem that was never
   * authored, and the participant would just see a shorter course track.
   */
  readonly skipped: readonly SkippedCatalogEntry[];
}

/**
 * [#2925 / #2926] Project every problem under `roots` into the participant-facing catalog
 * the portal renders from.
 *
 * This is the runtime twin of the portal's build-time `import.meta.glob`, and it exists
 * because the Docker image cannot carry `problems/`: `.dockerignore` excludes it on purpose
 * so the container serves the participant's OWN clone (bind-mounted read-only at run time),
 * which means a participant who adds a problem sees it without rebuilding the image. The
 * glob is therefore empty in the image, and every catalog-derived surface — instructions,
 * learning goals, endpoint overrides, course tracks, plugin slots — went blank with it.
 *
 * Deliberately NOT `listLocalPlayProblems`: that answers "what can I launch right now"
 * (container problems only). The course track is a curriculum view and must include problems
 * the participant has not deployed, and AWS-only ones, or the learning path loses everything
 * ahead of where the learner currently stands (#2926).
 *
 * Validation is intentionally thin — only a usable `id` is required. Rejecting more here
 * would make a problem visible in AWS mode and invisible in local mode, which is the very
 * class of divergence this shared projection removes; schema conformance is the catalog
 * repository's own validator's job.
 */
export function loadProblemCatalogEntries(
  roots: readonly string[],
  fs: CatalogFs = CATALOG_FS,
): ProblemCatalogSource {
  const entries: ProblemCatalogEntry[] = [];
  const skipped: SkippedCatalogEntry[] = [];
  for (const root of roots) {
    for (const problemId of fs.readDirNames(root)) {
      const problemDir = join(root, problemId);
      const metadataPath = join(problemDir, "metadata.json");
      if (!fs.existsSync(metadataPath)) continue;
      const projected = projectCatalogEntry(metadataPath, fs);
      if (projected.ok) {
        // [Challenge #402] `local/` を持たない問題は `make local` では起動できない。
        // カタログからは消さない (#2926 が学習パスの先を見せるために意図的に含めている) ので、
        // 起動できるかどうかを entry に載せてポータル側が明示できるようにする。
        // runtime フィールドの有無では判定しない — `hello-multicloud` は runtime を持つが
        // `kind: "composite"` (4 クラウドの実 deploy 定義のみ) で `local/` を持たない。
        entries.push({
          ...projected.entry,
          localPlayable: fs.existsSync(join(problemDir, "local")),
        });
      } else skipped.push({ problemId, reason: projected.reason });
    }
  }
  return {
    entries: [...entries].sort((a, b) => a.id.localeCompare(b.id)),
    skipped,
  };
}

type ProjectedCatalogEntry =
  | { readonly ok: true; readonly entry: ProblemCatalogEntry }
  | { readonly ok: false; readonly reason: string };

/** One metadata.json → its catalog entry, or why it could not be projected. */
function projectCatalogEntry(metadataPath: string, fs: CatalogFs): ProjectedCatalogEntry {
  try {
    const metadata = JSON.parse(fs.readFileSync(metadataPath)) as ProblemMetadata;
    if (typeof metadata.id !== "string" || metadata.id.length === 0) {
      return { ok: false, reason: "metadata.json has no usable id" };
    }
    return { ok: true, entry: metadataToEntry(metadata) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
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
