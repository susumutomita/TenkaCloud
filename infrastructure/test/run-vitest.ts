import { spawn } from "node:child_process";
import {
  type Dirent,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CDK_TEST_RUN_ID_ENV, CDK_TEST_RUN_ID_PATTERN } from "./cdk-test-outdir-contract";

// Under `cdk.out/` (see test/setup.ts) so a leftover run dir is covered by the
// existing `cdk.out` excludes in tsconfig.json / vitest.config.ts and never
// type-checked by the build. The purge below only ever removes `run-<pid>-*`
// children of this root, so nesting under `cdk.out` cannot touch deploy synth.
export const CDK_TEST_OUTDIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "cdk.out",
  "test-synth",
);

function validateCdkTestOutdirRoot(root: string, create: boolean): boolean {
  let stats = lstatSync(root, { throwIfNoEntry: false });
  if (!stats && create) {
    mkdirSync(root, { recursive: true });
    stats = lstatSync(root, { throwIfNoEntry: false });
  }
  if (!stats) return false;
  if (stats.isSymbolicLink()) {
    throw new Error(`CDK test outdir root must not be a symbolic link: ${root}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`CDK test outdir root must be a directory: ${root}`);
  }
  return true;
}

export function createCdkTestRunOutdir(root = CDK_TEST_OUTDIR, ownerPid = process.pid): string {
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) {
    throw new Error(`invalid CDK test run owner PID: ${ownerPid}`);
  }
  validateCdkTestOutdirRoot(root, true);
  return mkdtempSync(join(root, `run-${ownerPid}-`));
}

// Only a direct run-* child created by this runner is a valid automatic cleanup target. The
// shared root and interrupted siblings are intentionally left for explicit maintenance.
export function cleanCdkTestRunOutdir(
  outdir: string,
  root = CDK_TEST_OUTDIR,
  ownerPid = process.pid,
): void {
  const resolvedRoot = resolve(root);
  const resolvedOutdir = resolve(outdir);
  const childName = relative(resolvedRoot, resolvedOutdir);
  if (!CDK_TEST_RUN_ID_PATTERN.test(childName) || !childName.startsWith(`run-${ownerPid}-`)) {
    throw new Error(`refusing to clean an unowned CDK test outdir: ${outdir}`);
  }
  if (!validateCdkTestOutdirRoot(resolvedRoot, false)) return;
  const stats = lstatSync(resolvedOutdir, { throwIfNoEntry: false });
  if (!stats) return;
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`refusing to clean an unsafe CDK test run outdir: ${outdir}`);
  }
  rmSync(resolvedOutdir, { force: true, recursive: true });
}

// Issue #2515: recursive `du`-style size for the CDK asset bundles a run produced (see
// `summarizeBundleAssets`). Symlinks are skipped so diagnostics cannot escape the owned tree or
// recurse through a link cycle.
export function directorySizeBytes(path: string): number {
  const stats = lstatSync(path, { throwIfNoEntry: false });
  if (!stats) return 0;
  if (stats.isSymbolicLink()) return 0;
  if (stats.isFile()) return stats.size;
  if (!stats.isDirectory()) return 0;

  let entries: Dirent[];
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return 0;
  }

  let total = 0;
  for (const entry of entries) {
    total += directorySizeBytes(join(path, entry.name));
  }
  return total;
}

export function formatExistingCdkOutdirMessage(entryCount: number): string {
  return `found ${entryCount} existing cdk.out/test-synth entries — active parallel, interrupted, or direct run`;
}

// Visibility only: existing data may belong to an active parallel run, so never delete it here.
export function reportExistingCdkTestOutdir(outdir = CDK_TEST_OUTDIR): void {
  let entryCount: number;
  try {
    const stats = lstatSync(outdir, { throwIfNoEntry: false });
    if (!stats?.isDirectory() || stats.isSymbolicLink()) return;
    entryCount = readdirSync(outdir).length;
  } catch {
    return;
  }
  if (entryCount === 0) return;
  console.log(formatExistingCdkOutdirMessage(entryCount));
}

const DEFAULT_MAX_WORKERS = "2";
const DEFAULT_TEST_TIMEOUT_MS = "120000";

function hasCliOption(args: string[], option: string): boolean {
  return args.some((arg) => arg === option || arg.startsWith(`${option}=`));
}

// Issue #2515: the CI timing/bundle report (see `printTimingAndBundleReport`) is opt-in — it
// only fires in CI (where the wall-time cost we're trying to reduce is measured) or when a
// developer explicitly asks for it, so a plain local `bun run test` stays quiet.
export function isTimingReportEnabled(
  env: Pick<NodeJS.ProcessEnv, "CI" | "TENKACLOUD_VITEST_TIMINGS"> = process.env,
): boolean {
  return Boolean(env.CI) || env.TENKACLOUD_VITEST_TIMINGS === "1";
}

export function timingReportPath(outdir: string): string {
  return join(outdir, "vitest-report.json");
}

export function buildVitestArgs(
  args = process.argv.slice(2),
  env: Pick<
    NodeJS.ProcessEnv,
    | "TENKACLOUD_VITEST_MAX_WORKERS"
    | "TENKACLOUD_VITEST_TEST_TIMEOUT_MS"
    | "CI"
    | "TENKACLOUD_VITEST_TIMINGS"
  > = process.env,
  reportOutdir?: string,
): string[] {
  const defaults: string[] = [];

  if (!hasCliOption(args, "--maxWorkers")) {
    defaults.push(`--maxWorkers=${env.TENKACLOUD_VITEST_MAX_WORKERS ?? DEFAULT_MAX_WORKERS}`);
  }

  if (!hasCliOption(args, "--testTimeout")) {
    defaults.push(
      `--testTimeout=${env.TENKACLOUD_VITEST_TEST_TIMEOUT_MS ?? DEFAULT_TEST_TIMEOUT_MS}`,
    );
  }

  // Keep the default console reporter (`default`) alongside `json` — this only adds a machine
  // readable report file, it does not change what a developer sees on the terminal. Coexists
  // with the `--coverage*` flags `test:coverage` passes (verified: coverage config and reporter
  // config are independent CLI surfaces in Vitest).
  if (
    isTimingReportEnabled(env) &&
    !hasCliOption(args, "--reporter") &&
    !hasCliOption(args, "--outputFile.json")
  ) {
    if (!reportOutdir) {
      throw new Error("a run-scoped report outdir is required when Vitest timings are enabled");
    }
    defaults.push(
      "--reporter=default",
      "--reporter=json",
      `--outputFile.json=${timingReportPath(reportOutdir)}`,
    );
  }

  return [...args, ...defaults];
}

interface VitestJsonTestResult {
  readonly name: string;
  readonly startTime: number;
  readonly endTime: number;
}

interface VitestJsonReport {
  readonly testResults: readonly VitestJsonTestResult[];
}

export function shouldCleanCdkTestRun(
  exitCode: number | null,
  exitSignal: NodeJS.Signals | null,
  forwardedSignal: boolean,
): boolean {
  return exitCode === 0 && exitSignal === null && !forwardedSignal;
}

export function slowestTestFiles(
  report: VitestJsonReport,
  limit = 15,
): Array<{ file: string; durationMs: number }> {
  return [...report.testResults]
    .map((result) => ({ file: result.name, durationMs: result.endTime - result.startTime }))
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, limit);
}

export function formatSlowestTestFiles(
  entries: ReadonlyArray<{ file: string; durationMs: number }>,
): string[] {
  return entries.map((entry) => `${(entry.durationMs / 1000).toFixed(2)}s  ${entry.file}`);
}

// Recursively find every staged-asset dir/file under `root` (name matches `asset.*` — the CDK
// asset-staging naming for both bundled Lambda code and other file assets). Does not recurse
// *into* a matched asset dir: its size is taken as a whole via `directorySizeBytes`.
export function findAssetPaths(root: string): string[] {
  const found: string[] = [];

  function walk(dir: string): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.name.startsWith("asset.")) {
        found.push(full);
        continue;
      }
      if (entry.isDirectory()) walk(full);
    }
  }

  walk(root);
  return found;
}

export function summarizeBundleAssets(root = CDK_TEST_OUTDIR): {
  count: number;
  totalBytes: number;
} {
  const paths = findAssetPaths(root);
  const totalBytes = paths.reduce((sum, path) => sum + directorySizeBytes(path), 0);
  return { count: paths.length, totalBytes };
}

export function formatBundleSummary(summary: { count: number; totalBytes: number }): string {
  const totalMb = (summary.totalBytes / (1024 * 1024)).toFixed(1);
  return `CDK asset bundles produced: ${summary.count} (${totalMb} MB total)`;
}

// Runs after the vitest child exits (before the current run cleanup) so both the JSON report and
// the staged assets it reports on still exist on disk. Never allowed to fail the run — a parse
// error here is a diagnostics-only concern.
export function printTimingAndBundleReport(outdir: string): void {
  try {
    const report = JSON.parse(readFileSync(timingReportPath(outdir), "utf8")) as VitestJsonReport;
    console.log("\nSlowest test files:");
    for (const line of formatSlowestTestFiles(slowestTestFiles(report))) {
      console.log(`  ${line}`);
    }
    console.log(formatBundleSummary(summarizeBundleAssets(outdir)));
  } catch (error) {
    console.warn(
      `Skipping test-timing/bundle report: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function runVitest(args = process.argv.slice(2)): Promise<number> {
  reportExistingCdkTestOutdir();
  const runOutdir = createCdkTestRunOutdir();

  const vitestArgs = buildVitestArgs(args, process.env, runOutdir);
  const reportEnabled = isTimingReportEnabled();
  const child = spawn("vitest", vitestArgs, {
    stdio: "inherit",
    env: {
      ...process.env,
      [CDK_TEST_RUN_ID_ENV]: basename(runOutdir),
    },
  });
  let forwardedSignal = false;
  let cleanRunOutdir = false;
  const forwardSignal = (signal: NodeJS.Signals) => {
    forwardedSignal = true;
    child.kill(signal);
  };
  const signals: NodeJS.Signals[] = ["SIGHUP", "SIGINT", "SIGTERM"];

  for (const signal of signals) {
    process.once(signal, forwardSignal);
  }

  try {
    const result = await new Promise<{
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    }>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, signal) => resolveExit({ exitCode, signal }));
    });
    if (reportEnabled) {
      printTimingAndBundleReport(runOutdir);
    }
    cleanRunOutdir = shouldCleanCdkTestRun(result.exitCode, result.signal, forwardedSignal);
    return result.exitCode ?? 1;
  } finally {
    for (const signal of signals) {
      process.off(signal, forwardSignal);
    }
    if (cleanRunOutdir) {
      cleanCdkTestRunOutdir(runOutdir);
    } else {
      console.warn(`preserving CDK test output after failed or interrupted run: ${runOutdir}`);
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runVitest();
}
