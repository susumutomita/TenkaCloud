#!/usr/bin/env bun
/**
 * Runs only the tests affected by uncommitted changes (#3367). The pre-commit hook calls this
 * through `make before-commit`; the required CI check `ci` still runs every test.
 *
 * A changed path first routes to the unit that owns it (`PATH_ROUTES`): every test, no test, a
 * root suite, or a workspace. The selection then grows through references: every tracked source
 * file is scanned for imports and for string paths to repository files (`"../release/x.json"`,
 * `resolve(dir, "scripts", "lib", "names.sh")`), and the owner of each file that references a
 * changed file, directly or through other files, runs too. Changed workspaces also reach the
 * workspaces that declare them as `workspace:*` dependencies.
 *
 * The scan is textual. Paths built from template literals or variables are not seen; CI covers
 * them.
 *
 * Usage: bun run scripts/workspace/test-changed.ts
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
  [/^scripts\/(?:problem-pack|onboarding)\//u, { kind: "suite", suite: "authoring" }],
  [/^(?:scripts|docs|landing|release|\.github|\.vscode)\//u, { kind: "suite", suite: "scripts" }],
  [
    /^(?:[^/]+\.md|biome\.json|eslint\.config\.mjs|eslint-suppressions\.json|knip\.json|\.markdownlint-cli2\.jsonc|\.textlintrc|\.textlintignore|textlint-[a-z-]+\.json|\.jscpd\.json|codecov\.yml)$/u,
    { kind: "suite", suite: "scripts" },
  ],
];

const SOURCE_FILE = /\.[cm]?[jt]sx?$/u;
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx", ".mts", ".cts"];
const IMPORT_SPECIFIER = /\b(?:from|import|require)\b[\s(]*["']([^"'\n]+)["']/gu;
/** A quoted string that looks like a relative or repository path to a file. */
const PATH_LITERAL = /["'`]((?:\.{1,2}\/)*[\w@.-]+(?:\/[\w@.[\]-]+)+\.\w{1,6})["'`]/gu;
/** Comma-separated quoted path segments ending in a file name, as passed to `join`/`resolve`. */
const SEGMENT_RUN = /(?:["'][\w@.-]+["']\s*,\s*)+["'][\w@-]+\.\w{1,6}["']/gu;
const QUOTED = /["']([^"']+)["']/gu;
/** Nothing imports a test file, so the files it references do not propagate further. */
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
/** Whole-line comments, so that a path named in documentation is not a reference. */
const LINE_COMMENT = /^[ \t]*(?:\/\/.*|\/\*[\s\S]*?\*\/)/gmu;

/**
 * Workspace files that a root suite reads without naming them: tests scan every manifest by
 * directory, and the landing generator builds docs paths from variables.
 */
const ALSO_READ_BY: readonly (readonly [RegExp, RootSuite])[] = [
  [/^(?:infrastructure|(?:apps|packages)\/[^/]+)\/package\.json$/u, "scripts"],
  [/^apps\/developer-portal\/(?:src\/app\/developers\/docs|public\/docs)\//u, "scripts"],
];

export interface WorkspaceNode {
  readonly dir: string;
  readonly name: string;
  readonly hasTest: boolean;
  /** Names of `workspace:*` dependencies. */
  readonly workspaceDeps: readonly string[];
}

/**
 * Reference target key to the files that reference it. A key is a repository path (source files
 * without their extension) or `workspace:<dir>` for a package imported by name.
 */
export type ReferenceIndex = ReadonlyMap<string, ReadonlySet<string>>;

export type TestPlan =
  | { readonly kind: "all"; readonly reason: string }
  | {
      readonly kind: "selected";
      readonly suites: readonly RootSuite[];
      readonly workspaces: readonly string[];
      readonly reasons: readonly string[];
    };

type Owner = { readonly suite: RootSuite } | { readonly workspace: string };

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

/** The workspace or root suite whose tests cover `path`, if any. */
function ownerOf(path: string, workspaces: readonly WorkspaceNode[]): Owner | undefined {
  const workspace = workspaceOf(path, workspaces);
  if (workspace) return { workspace: workspace.dir };
  const route = routeOf(path);
  return route.kind === "suite" ? { suite: route.suite } : undefined;
}

/** Keys under which other files reference `path`. */
function referenceKeys(path: string): string[] {
  const base = withoutExtension(path);
  return base.endsWith("/index") ? [base, dirname(base)] : [base];
}

/** The reference key of `path` when it names a tracked file, with or without its extension. */
function trackedKey(path: string, tracked: ReadonlySet<string>): string | undefined {
  if (path.startsWith("..") || path.startsWith("/")) return undefined;
  if (tracked.has(path)) return withoutExtension(path);
  const base = withoutExtension(path);
  for (const extension of SOURCE_EXTENSIONS) {
    if (tracked.has(`${base}${extension}`)) return base;
    if (tracked.has(`${base}/index${extension}`)) return base;
  }
  return undefined;
}

/** Resolves a reference from `file`, first beside it and then from the repository root. */
function resolveReference(
  file: string,
  reference: string,
  tracked: ReadonlySet<string>,
): string | undefined {
  return (
    trackedKey(normalize(join(dirname(file), reference)), tracked) ??
    trackedKey(normalize(reference), tracked)
  );
}

function packageKey(specifier: string, workspaces: readonly WorkspaceNode[]): string | undefined {
  const name = specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
  const workspace = workspaces.find((candidate) => candidate.name === name);
  return workspace ? `workspace:${workspace.dir}` : undefined;
}

function* referencesIn(source: string): Generator<string> {
  const text = source.replace(LINE_COMMENT, "");
  for (const match of text.matchAll(IMPORT_SPECIFIER)) yield match[1];
  for (const match of text.matchAll(PATH_LITERAL)) yield match[1];
  for (const match of text.matchAll(SEGMENT_RUN)) {
    yield [...match[0].matchAll(QUOTED)].map((segment) => segment[1]).join("/");
  }
}

/**
 * Builds the reference index from `[repository path, contents]` pairs. `tracked` lists every
 * repository file, so that only references to real files count.
 */
export function indexReferences(
  sources: Iterable<readonly [string, string]>,
  workspaces: readonly WorkspaceNode[],
  tracked: ReadonlySet<string>,
): ReferenceIndex {
  const index = new Map<string, Set<string>>();
  for (const [file, text] of sources) {
    for (const reference of referencesIn(text)) {
      const key = reference.startsWith(".")
        ? resolveReference(file, reference, tracked)
        : (packageKey(reference, workspaces) ?? resolveReference(file, reference, tracked));
      if (!key || referenceKeys(file).includes(key)) continue;
      const referrers = index.get(key) ?? new Set<string>();
      referrers.add(file);
      index.set(key, referrers);
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

interface Selection {
  /** The first path that needs every test. */
  all?: string;
  readonly suites: Map<RootSuite, string>;
  readonly workspaces: Map<string, string>;
}

function select(selection: Selection, owner: Owner, reason: string): void {
  if ("suite" in owner) {
    if (!selection.suites.has(owner.suite)) selection.suites.set(owner.suite, reason);
  } else if (!selection.workspaces.has(owner.workspace)) {
    selection.workspaces.set(owner.workspace, reason);
  }
}

/** Selects the owner of every file that references `keys`, directly or through other files. */
function selectReferrers(
  selection: Selection,
  keys: readonly string[],
  references: ReferenceIndex,
  workspaces: readonly WorkspaceNode[],
): void {
  const seen = new Set<string>();
  const queue = [...keys];
  for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
    for (const file of references.get(key) ?? []) {
      if (seen.has(file)) continue;
      seen.add(file);
      const owner = ownerOf(file, workspaces);
      if (owner) select(selection, owner, `references ${key} (${file})`);
      if (!TEST_FILE.test(file)) queue.push(...referenceKeys(file));
    }
  }
}

/** Pure planning step: which suites and workspaces cover `paths`. */
export function planChangedTests(
  paths: readonly string[],
  workspaces: readonly WorkspaceNode[],
  references: ReferenceIndex,
): TestPlan {
  const selection: Selection = { suites: new Map(), workspaces: new Map() };
  for (const path of paths) {
    const owner = ownerOf(path, workspaces);
    if (owner) select(selection, owner, path);
    else if (routeOf(path).kind === "all") return { kind: "all", reason: path };
    for (const [pattern, suite] of ALSO_READ_BY) {
      if (pattern.test(path)) select(selection, { suite }, `${path} (read by directory)`);
    }
  }
  for (const [dir, reason] of dependentClosure(selection.workspaces, workspaces)) {
    select(selection, { workspace: dir }, reason);
  }
  selectReferrers(
    selection,
    [
      ...paths.flatMap(referenceKeys),
      ...[...selection.workspaces.keys()].map((dir) => `workspace:${dir}`),
    ],
    references,
    workspaces,
  );

  const reasons: string[] = [];
  const suites = (Object.keys(ROOT_SUITES) as RootSuite[]).filter((suite) =>
    selection.suites.has(suite),
  );
  for (const suite of suites)
    reasons.push(`${ROOT_SUITES[suite]} <- ${selection.suites.get(suite)}`);
  const selected = workspaces
    .filter((workspace) => workspace.hasTest && selection.workspaces.has(workspace.dir))
    .map((workspace) => workspace.dir);
  for (const dir of selected) reasons.push(`${dir} <- ${selection.workspaces.get(dir)}`);
  return { kind: "selected", suites, workspaces: selected, reasons };
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

function git(rootDir: string, args: readonly string[]): string[] {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- developer and CI shells own PATH
  const result = spawnSync("git", args, { cwd: rootDir, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.split("\0").filter(Boolean);
}

/** Tracked and untracked (not ignored) files. */
export function repositoryFiles(rootDir: string): string[] {
  return git(rootDir, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
}

/**
 * `changed` joins the known paths so that a staged rename or deletion still resolves the imports
 * of the old path, and the files that imported it are selected.
 */
export function readReferenceIndex(
  rootDir: string,
  workspaces: readonly WorkspaceNode[],
  files: readonly string[],
  changed: readonly string[],
): ReferenceIndex {
  const tracked = new Set([...files, ...changed]);
  const sources = files
    .filter((file) => SOURCE_FILE.test(file) && existsSync(join(rootDir, file)))
    .map((file): [string, string] => [file, readFileSync(join(rootDir, file), "utf8")]);
  return indexReferences(sources, workspaces, tracked);
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
      : planChangedTests(
          paths,
          workspaces,
          readReferenceIndex(rootDir, workspaces, repositoryFiles(rootDir), paths),
        );

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
