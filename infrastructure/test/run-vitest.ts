import { spawn } from "node:child_process";
import {
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CDK_TEST_OUTDIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "cdk.out.test",
);

export function cleanCdkTestOutdir(outdir = CDK_TEST_OUTDIR): void {
  rmSync(outdir, { force: true, recursive: true });
}

// Issue #2515: recursive `du`-style size, used both to report a leftover cdk.out.test dir found
// on the pre-run clean and to size up the CDK asset bundles a run produced (see
// `summarizeBundleAssets`). Pure / unit-testable: takes a path, returns bytes.
export function directorySizeBytes(path: string): number {
  const stats = statSync(path, { throwIfNoEntry: false });
  if (!stats) return 0;
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

export function formatLeftoverCdkOutdirMessage(sizeBytes: number): string {
  const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(1);
  return `removed leftover cdk.out.test (${sizeMb} MB) — likely from an interrupted run`;
}

// Logs (does not remove) — call before `cleanCdkTestOutdir()` so an interrupted prior run is
// visible instead of silently vanishing.
export function reportLeftoverCdkTestOutdir(outdir = CDK_TEST_OUTDIR): void {
  if (!existsSync(outdir)) return;
  console.log(formatLeftoverCdkOutdirMessage(directorySizeBytes(outdir)));
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

export function timingReportPath(outdir = CDK_TEST_OUTDIR): string {
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
    defaults.push(
      "--reporter=default",
      "--reporter=json",
      `--outputFile.json=${timingReportPath()}`,
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

// Runs after the vitest child exits (before the `finally` cleanup wipes cdk.out.test) so both
// the JSON report and the staged assets it reports on still exist on disk. Never allowed to fail
// the run — a parse error here is a diagnostics-only concern.
export function printTimingAndBundleReport(outdir = CDK_TEST_OUTDIR): void {
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
  reportLeftoverCdkTestOutdir();
  cleanCdkTestOutdir();

  const vitestArgs = buildVitestArgs(args);
  const reportEnabled = isTimingReportEnabled();
  if (reportEnabled) {
    // The `json` reporter needs its output directory to exist; synth itself creates the
    // per-worker subdirs lazily, so the top-level dir isn't guaranteed to exist yet.
    mkdirSync(CDK_TEST_OUTDIR, { recursive: true });
  }

  const child = spawn("vitest", vitestArgs, { stdio: "inherit" });
  const forwardSignal = (signal: NodeJS.Signals) => child.kill(signal);
  const signals: NodeJS.Signals[] = ["SIGHUP", "SIGINT", "SIGTERM"];

  for (const signal of signals) {
    process.once(signal, forwardSignal);
  }

  try {
    const exitCode = await new Promise<number>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolveExit(code ?? 1));
    });
    if (reportEnabled) {
      printTimingAndBundleReport();
    }
    return exitCode;
  } finally {
    for (const signal of signals) {
      process.off(signal, forwardSignal);
    }
    cleanCdkTestOutdir();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runVitest();
}
