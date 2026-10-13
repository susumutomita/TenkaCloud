#!/usr/bin/env bun
/**
 * Runs only the tests affected by uncommitted changes (#3367). The pre-commit hook calls this
 * through `make before-commit`; the required CI check `ci` still runs every test.
 *
 * A changed path first routes to the unit that owns it (`PATH_ROUTES`): every test, no test, a
 * root suite, or a workspace. Workspace changes reach the workspaces that declare them as
 * `workspace:*` dependencies. Root-suite files are followed through their imports, so a change
 * to `scripts/quality/host-imports.ts` also runs the host suite whose test imports it, and a
 * package change runs the root suites that import the package.
 *
 * Root-suite imports of `apps/*` and `infrastructure` are not followed: the host imports a few
 * application modules, and following them would run the host suite for every application change.
 * CI covers those paths.
 *
 * Usage: bun run scripts/workspace/test-changed.ts
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { discoverWorkspaces, planTask } from "./run-workspaces";

export const ROOT_SUITES = {
  scripts: "test:scripts",
  authoring: "test:authoring",
  host: "test:host",
} as const;
export type RootSuite = keyof typeof ROOT_SUITES;

type Route =
  | { readonly kind: "all" }
  | { readonly kind: "none" }
  | { readonly kind: "suite"; readonly suite: RootSuite };

/**
 * Ordered; the first match wins. Workspace directories are matched before this table, and a path
 * that matches nothing runs every test.
 */
const PATH_ROUTES: readonly (readonly [RegExp, Route])[] = [
  [
    /^(?:package\.json|bun\.lock|mise\.toml|\.nvmrc|\.npmrc|\.gitmodules|Makefile|problems|tsconfig[^/]*\.json)$/u,
    { kind: "all" },
  ],
  [/^(?:\.husky|scripts\/workspace)\//u, { kind: "all" }],
  [/^\.claude\//u, { kind: "none" }],
  [/^(?:scripts\/(?:local-host|lib)|integrations)\//u, { kind: "suite", suite: "host" }],
  [/^(?:scripts\/(?:problem-pack|onboarding)|packs)\//u, { kind: "suite", suite: "authoring" }],
  [/^(?:scripts|docs|landing|release|\.github|\.vscode)\//u, { kind: "suite", suite: "scripts" }],
  [
    /^(?:[^/]+\.md|biome\.json|eslint\.config\.mjs|eslint-suppressions\.json|knip\.json|\.markdownlint-cli2\.jsonc|\.textlintrc|\.textlintignore|textlint-[a-z-]+\.json|\.jscpd\.json|codecov\.yml)$/u,
    { kind: "suite", suite: "scripts" },
  ],
];

/** Root-suite source trees whose imports are followed. */
const ROOT_SOURCE_DIRS = ["scripts", "integrations", "docs"] as const;
const SOURCE_FILE = /\.[cm]?[jt]sx?$/u;
const IMPORT_SPECIFIER = /\b(?:from|import|require)\b[\s(]*["']([^"'\n]+)["']/gu;

export interface WorkspaceNode {
  readonly dir: string;
  readonly name: string;
  readonly hasTest: boolean;
  /** Names of `workspace:*` dependencies. */
  readonly workspaceDeps: readonly string[];
}

/** Import target key (extensionless repo path or `workspace:<dir>`) to the files importing it. */
export type ImportIndex = ReadonlyMap<string, ReadonlySet<string>>;

export type TestPlan =
  | { readonly kind: "all"; readonly reason: string }
  | {
      readonly kind: "selected";
      readonly suites: readonly RootSuite[];
      readonly workspaces: readonly string[];
      readonly reasons: readonly string[];
    };

function withoutExtension(path: string): string {
  return path.replace(SOURCE_FILE, "");
}

function workspaceOf(
  path: string,
  workspaces: readonly WorkspaceNode[],
): WorkspaceNode | undefined {
  return workspaces.find(
    (workspace) => path === workspace.dir || path.startsWith(`${workspace.dir}/`),
  );
}

function routeOf(path: string): Route {
  return PATH_ROUTES.find(([pattern]) => pattern.test(path))?.[1] ?? { kind: "all" };
}

function suiteOf(path: string): RootSuite | undefined {
  const route = routeOf(path);
  return route.kind === "suite" ? route.suite : undefined;
}

/** Keys under which other files may import `path`. */
function importKeys(path: string): string[] {
  const base = withoutExtension(path);
  return base.endsWith("/index") ? [base, dirname(base)] : [base];
}

function importTarget(
  file: string,
  specifier: string,
  workspaces: readonly WorkspaceNode[],
): string | undefined {
  if (specifier.startsWith(".")) {
    const target = normalize(join(dirname(file), specifier));
    const workspace = workspaceOf(target, workspaces);
    return workspace ? `workspace:${workspace.dir}` : withoutExtension(target);
  }
  const name = specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
  const workspace = workspaces.find((candidate) => candidate.name === name);
  return workspace ? `workspace:${workspace.dir}` : undefined;
}

/** Builds the import index from root-suite sources given as `[repo path, contents]`. */
export function indexImports(
  sources: Iterable<readonly [string, string]>,
  workspaces: readonly WorkspaceNode[],
): ImportIndex {
  const index = new Map<string, Set<string>>();
  for (const [file, text] of sources) {
    for (const match of text.matchAll(IMPORT_SPECIFIER)) {
      const target = importTarget(file, match[1], workspaces);
      if (!target) continue;
      const importers = index.get(target) ?? new Set<string>();
      importers.add(file);
      index.set(target, importers);
    }
  }
  return index;
}

/** Changed workspaces plus every workspace that depends on one, each with why it was reached. */
function dependentClosure(
  changed: ReadonlyMap<string, string>,
  workspaces: readonly WorkspaceNode[],
): Map<string, string> {
  const reached = new Map(changed);
  const queue = [...reached.keys()];
  for (let dir = queue.shift(); dir !== undefined; dir = queue.shift()) {
    const name = workspaces.find((workspace) => workspace.dir === dir)?.name;
    for (const workspace of workspaces) {
      if (name && workspace.workspaceDeps.includes(name) && !reached.has(workspace.dir)) {
        reached.set(workspace.dir, `depends on ${dir}`);
        queue.push(workspace.dir);
      }
    }
  }
  return reached;
}

/** Root suites that import any of `keys`, directly or through other root-suite files. */
function importingSuites(keys: Iterable<string>, imports: ImportIndex): Map<RootSuite, string> {
  const suites = new Map<RootSuite, string>();
  const seen = new Set<string>();
  const queue = [...keys];
  for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
    for (const file of imports.get(key) ?? []) {
      if (seen.has(file)) continue;
      seen.add(file);
      const suite = suiteOf(file);
      if (suite && !suites.has(suite)) suites.set(suite, file);
      queue.push(...importKeys(file));
    }
  }
  return suites;
}

interface Owners {
  /** The first path that needs every test. */
  all?: string;
  readonly suites: Map<RootSuite, string>;
  readonly workspaces: Map<string, string>;
  readonly sources: string[];
}

/** The unit that owns each path. */
function ownersOf(paths: readonly string[], workspaces: readonly WorkspaceNode[]): Owners {
  const owners: Owners = { suites: new Map(), workspaces: new Map(), sources: [] };
  for (const path of paths) {
    const workspace = workspaceOf(path, workspaces);
    if (workspace) {
      if (!owners.workspaces.has(workspace.dir)) owners.workspaces.set(workspace.dir, path);
      continue;
    }
    const route = routeOf(path);
    if (route.kind === "all") return { ...owners, all: path };
    if (route.kind === "suite") {
      if (!owners.suites.has(route.suite)) owners.suites.set(route.suite, path);
      owners.sources.push(path);
    }
  }
  return owners;
}

/** Pure planning step: which suites and workspaces cover `paths`. */
export function planChangedTests(
  paths: readonly string[],
  workspaces: readonly WorkspaceNode[],
  imports: ImportIndex,
): TestPlan {
  const owners = ownersOf(paths, workspaces);
  if (owners.all !== undefined) return { kind: "all", reason: owners.all };
  const { suites, sources: changedSources } = owners;

  const reasons: string[] = [];
  const selectedWorkspaces = dependentClosure(owners.workspaces, workspaces);
  const packageKeys = [...selectedWorkspaces.keys()]
    .filter((dir) => dir.startsWith("packages/"))
    .map((dir) => `workspace:${dir}`);
  for (const [suite, file] of importingSuites(
    [...changedSources.flatMap(importKeys), ...packageKeys],
    imports,
  )) {
    if (!suites.has(suite)) suites.set(suite, `imported by ${file}`);
  }

  const orderedSuites = (Object.keys(ROOT_SUITES) as RootSuite[]).filter((suite) =>
    suites.has(suite),
  );
  for (const suite of orderedSuites) reasons.push(`${ROOT_SUITES[suite]} <- ${suites.get(suite)}`);
  const orderedWorkspaces = workspaces
    .filter((workspace) => workspace.hasTest && selectedWorkspaces.has(workspace.dir))
    .map((workspace) => workspace.dir);
  for (const dir of orderedWorkspaces) reasons.push(`${dir} <- ${selectedWorkspaces.get(dir)}`);
  return { kind: "selected", suites: orderedSuites, workspaces: orderedWorkspaces, reasons };
}

/** Workspaces in `run-workspaces` test order, with their `workspace:*` dependency names. */
export function readWorkspaceNodes(rootDir: string): WorkspaceNode[] {
  const discovered = discoverWorkspaces(rootDir);
  const { included } = planTask("test", discovered);
  const testable = new Set(included.map((workspace) => workspace.dir));
  const ordered = [...included, ...discovered.filter((workspace) => !testable.has(workspace.dir))];
  return ordered.map((workspace) => {
    const pkg = JSON.parse(readFileSync(join(rootDir, workspace.dir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return {
      dir: workspace.dir,
      name: workspace.name,
      hasTest: testable.has(workspace.dir),
      workspaceDeps: Object.keys(deps).filter((name) => deps[name].startsWith("workspace:")),
    };
  });
}

function* rootSources(rootDir: string, dir: string): Generator<readonly [string, string]> {
  const absolute = join(rootDir, dir);
  if (!existsSync(absolute)) return;
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) yield* rootSources(rootDir, path);
    else if (SOURCE_FILE.test(entry.name)) yield [path, readFileSync(join(rootDir, path), "utf8")];
  }
}

export function readImportIndex(
  rootDir: string,
  workspaces: readonly WorkspaceNode[],
): ImportIndex {
  return indexImports(
    ROOT_SOURCE_DIRS.flatMap((dir) => [...rootSources(rootDir, dir)]),
    workspaces,
  );
}

function git(rootDir: string, args: readonly string[]): string[] {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- developer and CI shells own PATH
  const result = spawnSync("git", args, { cwd: rootDir, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.split("\0").filter(Boolean);
}

/** Staged, unstaged and untracked paths; `undefined` before the first commit. */
function changedPaths(rootDir: string): string[] | undefined {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- developer and CI shells own PATH
  if (spawnSync("git", ["rev-parse", "--verify", "-q", "HEAD"], { cwd: rootDir }).status !== 0) {
    return undefined;
  }
  const diff = ["diff", "-z", "--name-only", "--no-renames", "--ignore-submodules=dirty"];
  return [
    ...new Set([
      ...git(rootDir, [...diff, "HEAD"]),
      ...git(rootDir, [...diff, "--cached"]),
      ...git(rootDir, ["ls-files", "-z", "--others", "--exclude-standard"]),
    ]),
  ];
}

function run(label: string, cwd: string, script: string): void {
  console.log(`[test-changed] ${label} — bun run ${script}`);
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- re-entrant bun call
  const result = spawnSync("bun", ["run", script], { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`[test-changed] ${label} — ${script} failed`);
    process.exit(result.status ?? 1);
  }
}

function main(): void {
  const rootDir = resolve(import.meta.dir, "../..");
  const paths = changedPaths(rootDir);
  const workspaces = readWorkspaceNodes(rootDir);
  const plan: TestPlan =
    paths === undefined
      ? { kind: "all", reason: "no commit yet" }
      : planChangedTests(paths, workspaces, readImportIndex(rootDir, workspaces));

  if (plan.kind === "all") {
    console.log(`[test-changed] every test — ${plan.reason}`);
    run("all", rootDir, "test");
    return;
  }
  if (plan.reasons.length === 0) {
    console.log("[test-changed] no tests cover the changed files. `make test` runs every test.");
    return;
  }
  for (const reason of plan.reasons) console.log(`[test-changed] ${reason}`);
  for (const suite of plan.suites) run(suite, rootDir, ROOT_SUITES[suite]);
  for (const dir of plan.workspaces) run(dir, join(rootDir, dir), "test");
}

if (import.meta.main) {
  main();
}
