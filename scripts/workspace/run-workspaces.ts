#!/usr/bin/env bun
/**
 * Zero-dependency workspace-task orchestrator for `build` / `typecheck` / `test`.
 *
 * Those root `package.json` scripts used to be hand-maintained
 * `bun run --filter <pkg> && bun run --filter <pkg2> && ...` chains.
 * Two problems with that:
 *
 * 1. `bun run --filter <pkg>` can resolve the workspace filter before the
 *    workspace graph is fully settled and return "No packages matched the
 *    filter" when it races a not-yet-finished `bun install`. Issue #993
 *    hit a sharper variant of the same flakiness: a flag meant for every
 *    workspace in an `&&` chain only ever reached the *last* element, so
 *    Codecov only ever saw coverage for one workspace.
 * 2. Adding, removing, or excluding a workspace meant remembering to edit
 *    several separate one-liners by hand, with no test catching a forgotten
 *    edit.
 *
 * This script replaces the chains with a small discover → plan → execute
 * pipeline. `discoverWorkspaces` and `planTask` are pure and unit-tested
 * (scripts/workspace/run-workspaces.test.ts) including a repo-parity test that pins
 * the exact workspace set per task — *that* test is the seam a reviewer
 * now diffs when the workspace list changes, instead of an opaque `&&`
 * chain.
 *
 * `test:coverage` is deliberately NOT handled here: coverage is owned by
 * `scripts/workspace/run-coverage.ts` (#2513), which carries its own workspace list
 * (`COVERAGE_WORKSPACES`), the 3-way `--shard` CI matrix, per-workspace
 * timing, and the fix-coverage-paths post-step.
 *
 * Usage: bun run scripts/workspace/run-workspaces.ts <build|typecheck|test> [--jobs <n>]
 *
 * `--jobs <n>` runs up to n workspaces at once. The default stays 1 (serial, fail-fast) because
 * that is what a developer reading interleaved terminal output wants. CI passes `--jobs 4`: the
 * runner has 4 cores and one `tsc --noEmit` saturates a single one, so the serial chain left three
 * cores idle for the whole step (measured: typecheck 51.9s wall for 1m33s of CPU). Parallel output
 * is buffered per workspace and flushed on completion, so lines never interleave.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const TASKS = ["build", "typecheck", "test"] as const;
export type Task = (typeof TASKS)[number];

export function isTask(value: string | undefined): value is Task {
  return typeof value === "string" && (TASKS as readonly string[]).includes(value);
}

export interface WorkspaceInfo {
  /** Workspace directory, relative to the repo root (e.g. "apps/admin-console"). */
  dir: string;
  /** package.json "name" field. */
  name: string;
  /** package.json "scripts" map. */
  scripts: Record<string, string>;
}

interface RootPackageJson {
  workspaces?: string[];
}

interface WorkspacePackageJson {
  name?: string;
  scripts?: Record<string, string>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Expands a trailing "/*" glob (e.g. "apps/*") into its workspace subdirectories. */
function resolveGlobDirs(rootDir: string, glob: string): string[] {
  const base = glob.slice(0, -2);
  const baseAbs = join(rootDir, base);
  if (!existsSync(baseAbs)) {
    throw new Error(`workspaces glob "${glob}" points at a missing directory: "${base}"`);
  }

  const dirs: string[] = [];
  for (const entry of readdirSync(baseAbs, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = `${base}/${entry.name}`;
    if (existsSync(join(rootDir, dir, "package.json"))) {
      dirs.push(dir);
    }
  }
  return dirs;
}

/** Resolves a literal (non-glob) workspaces entry (e.g. "infrastructure"). */
function resolveLiteralDir(rootDir: string, entry: string): string {
  if (!existsSync(join(rootDir, entry, "package.json"))) {
    throw new Error(`workspaces entry "${entry}" has no package.json`);
  }
  return entry;
}

/** Expands the root `package.json` `workspaces` globs into concrete directories. */
function resolveWorkspaceDirs(rootDir: string, globs: string[]): string[] {
  const dirs: string[] = [];
  for (const glob of globs) {
    if (glob.endsWith("/*")) {
      dirs.push(...resolveGlobDirs(rootDir, glob));
    } else if (glob.includes("*")) {
      throw new Error(
        `unsupported workspaces glob (only a literal path or a trailing "/*" is supported): "${glob}"`,
      );
    } else {
      dirs.push(resolveLiteralDir(rootDir, glob));
    }
  }
  return dirs;
}

function readWorkspaceInfo(rootDir: string, dir: string): WorkspaceInfo {
  const pkgPath = join(rootDir, dir, "package.json");
  const pkg = readJson<WorkspacePackageJson>(pkgPath);
  if (!pkg.name) {
    throw new Error(`workspace package.json is missing a "name" field: "${pkgPath}"`);
  }
  return { dir, name: pkg.name, scripts: pkg.scripts ?? {} };
}

/**
 * Parses the root `package.json` `workspaces` globs and reads each matching
 * workspace's `package.json`. Only literal entries ("infrastructure") and a
 * trailing "/*" ("apps/*") are supported — nothing fancier, matching what
 * this repo's root `workspaces` array actually uses.
 */
export function discoverWorkspaces(rootDir: string): WorkspaceInfo[] {
  const rootPkg = readJson<RootPackageJson>(join(rootDir, "package.json"));
  const dirs = resolveWorkspaceDirs(rootDir, rootPkg.workspaces ?? []);
  return dirs.map((dir) => readWorkspaceInfo(rootDir, dir));
}

const GROUP_ORDER = ["infrastructure", "apps", "packages"] as const;
type Group = (typeof GROUP_ORDER)[number];

function groupOf(dir: string): Group {
  if (dir === "infrastructure") return "infrastructure";
  if (dir.startsWith("apps/")) return "apps";
  if (dir.startsWith("packages/")) return "packages";
  throw new Error(
    `cannot classify workspace directory into infrastructure/apps/packages: "${dir}"`,
  );
}

/**
 * `build` intentionally runs only in the infrastructure + apps groups, even
 * though five packages/* workspaces (trust-bridge, saml-utils,
 * problem-runtime, problem-sdk, problem-test-harness) also define a `build`
 * script: those packages are consumed as TS source via workspace deps, not
 * built as a standalone artifact, so the root `build` chain never included
 * them. Every other task runs across every group.
 */
const TASK_GROUPS: Partial<Record<Task, readonly Group[]>> = {
  build: ["infrastructure", "apps"],
};

export interface TaskPlan {
  task: Task;
  included: WorkspaceInfo[];
  /** Workspaces in an eligible group that do not define the requested script. */
  skipped: WorkspaceInfo[];
}

function orderWorkspaces(workspaces: WorkspaceInfo[]): WorkspaceInfo[] {
  return [...workspaces].sort((a, b) => {
    const groupDiff = GROUP_ORDER.indexOf(groupOf(a.dir)) - GROUP_ORDER.indexOf(groupOf(b.dir));
    return groupDiff !== 0 ? groupDiff : a.dir.localeCompare(b.dir);
  });
}

/**
 * Pure planning step: given the discovered workspaces, resolves which ones
 * run `task`, in the order infrastructure -> apps -> packages, alphabetical
 * by directory within each group. Workspaces filtered out by the group rule
 * (e.g. packages/* for `build`) are simply absent from both `included` and
 * `skipped` — that's a structural design choice, not an anomaly. Workspaces
 * lacking the requested script land in `skipped` so the caller can print a
 * loud (non-silent) log line per skip.
 */
export function planTask(task: string, workspaces: WorkspaceInfo[]): TaskPlan {
  if (!isTask(task)) {
    throw new Error(`unknown task "${task}" — expected one of: ${TASKS.join(", ")}`);
  }

  const eligibleGroups = TASK_GROUPS[task] ?? GROUP_ORDER;

  const candidates = orderWorkspaces(workspaces).filter((w) =>
    eligibleGroups.includes(groupOf(w.dir)),
  );

  const included: WorkspaceInfo[] = [];
  const skipped: WorkspaceInfo[] = [];

  for (const workspace of candidates) {
    if (task in workspace.scripts) {
      included.push(workspace);
    } else {
      skipped.push(workspace);
    }
  }

  if (included.length === 0) {
    throw new Error(`task "${task}" resolved to zero workspaces — refusing to run silently`);
  }

  return { task, included, skipped };
}

function printUsage(): void {
  console.error(
    `Usage: bun run scripts/workspace/run-workspaces.ts <${TASKS.join("|")}> [--jobs <n>]`,
  );
}

export class UsageError extends Error {}

/** `--jobs <n>` / `--jobs=<n>`; absent = 1 (the serial, fail-fast default). */
export function parseJobs(argv: readonly string[]): number {
  let jobs = 1;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const inline = arg.startsWith("--jobs=") ? arg.slice("--jobs=".length) : undefined;
    const raw = inline ?? (arg === "--jobs" ? argv[++i] : undefined);
    if (raw === undefined) {
      throw new UsageError(`unknown argument "${arg}"`);
    }
    if (!/^\d+$/.test(raw) || Number(raw) < 1) {
      throw new UsageError(`--jobs expects a positive integer, got "${raw}"`);
    }
    jobs = Number(raw);
  }
  return jobs;
}

interface WorkspaceRun {
  readonly dir: string;
  readonly ok: boolean;
  readonly durationMs: number;
}

/**
 * One workspace, output captured rather than inherited: with several running at once, interleaved
 * `tsc` / `vite` lines cannot be attributed to a workspace, and a failure becomes unreadable.
 */
function runWorkspaceBuffered(rootDir: string, dir: string, task: Task): Promise<WorkspaceRun> {
  return new Promise((resolveRun) => {
    const start = performance.now();
    // Re-entering the same `bun` that is already running this file. mise pins the
    // version, and the process is only ever started by a developer or the CI runner —
    // both own their own PATH.
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- re-entrant bun call
    const child = spawn("bun", ["run", task], {
      cwd: join(rootDir, dir),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: string[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
    child.once("error", (error) => {
      chunks.push(`${error.message}\n`);
      const durationMs = performance.now() - start;
      flush(dir, task, chunks, false, durationMs);
      resolveRun({ dir, ok: false, durationMs });
    });
    child.once("close", (code) => {
      const ok = code === 0;
      const durationMs = performance.now() - start;
      flush(dir, task, chunks, ok, durationMs);
      resolveRun({ dir, ok, durationMs });
    });
  });
}

function flush(
  dir: string,
  task: Task,
  chunks: readonly string[],
  ok: boolean,
  durationMs: number,
): void {
  const output = chunks.join("").trimEnd();
  const seconds = (durationMs / 1000).toFixed(1);
  console.log(`\n[run-workspaces] ${ok ? "✅" : "❌"} ${dir} — ${task} (${seconds}s)`);
  if (output) console.log(output);
}

/**
 * Runs the plan with at most `jobs` workspaces in flight. Unlike the serial path this does NOT
 * stop at the first failure: with several already running there is nothing to gain by hiding the
 * others' results, and a CI run that reports every broken workspace at once saves a round trip.
 */
export async function runPlanParallel(
  rootDir: string,
  plan: TaskPlan,
  jobs: number,
): Promise<readonly WorkspaceRun[]> {
  const queue = [...plan.included];
  const results: WorkspaceRun[] = [];
  const workers = Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      results.push(await runWorkspaceBuffered(rootDir, next.dir, plan.task));
    }
  });
  await Promise.all(workers);
  return results;
}

async function main(): Promise<void> {
  const rawTask = process.argv[2];
  if (!isTask(rawTask)) {
    printUsage();
    process.exit(1);
  }

  let jobs: number;
  try {
    jobs = parseJobs(process.argv.slice(3));
  } catch (error) {
    console.error(`[run-workspaces] ${(error as Error).message}`);
    printUsage();
    process.exit(1);
    throw error; // unreachable: process.exit() already terminated the process
  }

  const rootDir = resolve(import.meta.dir, "../..");
  const workspaces = discoverWorkspaces(rootDir);

  let plan: TaskPlan;
  try {
    plan = planTask(rawTask, workspaces);
  } catch (error) {
    console.error(`[run-workspaces] ${(error as Error).message}`);
    process.exit(1);
    throw error; // unreachable: process.exit() already terminated the process
  }

  for (const workspace of plan.skipped) {
    console.log(`[run-workspaces] skip ${workspace.dir} — no "${plan.task}" script`);
  }

  const total = plan.included.length;

  if (jobs > 1) {
    console.log(`[run-workspaces] ${total} workspace(s), up to ${jobs} at a time — ${plan.task}`);
    const results = await runPlanParallel(rootDir, plan, jobs);
    // The slowest workspace is the floor for the whole step, so print the ranking: it is the only
    // way to tell "add another job slot" from "this one workspace is the critical path".
    console.log(`\n[run-workspaces] ${plan.task} timing (slowest first):`);
    for (const result of [...results].sort((a, b) => b.durationMs - a.durationMs)) {
      console.log(
        `  ${result.ok ? "✅" : "❌"} ${result.dir.padEnd(40)} ${(result.durationMs / 1000).toFixed(1)}s`,
      );
    }
    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
      console.error(
        `[run-workspaces] ${plan.task} failed in: ${failed.map((r) => r.dir).join(", ")}`,
      );
      process.exit(1);
    }
    return;
  }

  plan.included.forEach((workspace, index) => {
    console.log(`[run-workspaces] (${index + 1}/${total}) ${workspace.dir} — ${plan.task}`);
    // Re-entering the same `bun` that is already running this file. mise pins the
    // version, and the process is only ever started by a developer or the CI runner —
    // both own their own PATH.
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- re-entrant bun call
    const result = spawnSync("bun", ["run", plan.task], {
      cwd: join(rootDir, workspace.dir),
      stdio: "inherit",
    });
    if (result.status !== 0) {
      console.error(`[run-workspaces] ${workspace.dir} — ${plan.task} failed`);
      process.exit(result.status ?? 1);
    }
  });
}

if (import.meta.main) {
  await main();
}
