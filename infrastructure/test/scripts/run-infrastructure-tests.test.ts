import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildVitestArgs,
  cleanCdkTestRunOutdir,
  createCdkTestRunOutdir,
  directorySizeBytes,
  findAssetPaths,
  formatBundleSummary,
  formatExistingCdkOutdirMessage,
  formatSlowestTestFiles,
  isTimingReportEnabled,
  printTimingAndBundleReport,
  reportExistingCdkTestOutdir,
  shouldCleanCdkTestRun,
  slowestTestFiles,
  summarizeBundleAssets,
  timingReportPath,
} from "../run-vitest";

const PACKAGE_JSON_PATH = resolve(__dirname, "..", "..", "package.json");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("infrastructure test runner (#1551)", () => {
  it("should route normal and coverage test runs through the cleanup wrapper", () => {
    const scripts = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")).scripts as Record<
      string,
      string
    >;

    expect(scripts.test).toBe("bun run test/run-vitest.ts run");
    expect(scripts["test:coverage"]).toContain("bun run test/run-vitest.ts run --coverage");
  });

  it("should create distinct run outdirs and clean only the requested direct child", () => {
    const root = mkdtempSync(join(tmpdir(), "tenkacloud-cdk-runs-"));
    tempDirs.push(root);
    const firstRun = createCdkTestRunOutdir(root, 101);
    const secondRun = createCdkTestRunOutdir(root, 202);
    writeFileSync(join(firstRun, "first.template.json"), "{}");
    writeFileSync(join(secondRun, "second.template.json"), "{}");

    cleanCdkTestRunOutdir(firstRun, root, 101);

    expect(existsSync(firstRun)).toBe(false);
    expect(() => cleanCdkTestRunOutdir(secondRun, root, 101)).toThrow(/unowned/);
    expect(existsSync(secondRun)).toBe(true);
  });

  it("should reject a symlinked shared CDK outdir root", () => {
    const parent = mkdtempSync(join(tmpdir(), "tenkacloud-cdk-symlink-"));
    tempDirs.push(parent);
    const target = join(parent, "target");
    const root = join(parent, "root-link");
    mkdirSync(target);
    symlinkSync(target, root, "dir");

    expect(() => createCdkTestRunOutdir(root, 101)).toThrow(/symbolic link/);
  });

  it("should cap Vitest workers and test timeout by default", () => {
    expect(buildVitestArgs(["run"], {})).toEqual(["run", "--maxWorkers=2", "--testTimeout=120000"]);
  });

  it("should keep explicit Vitest worker and timeout overrides", () => {
    expect(
      buildVitestArgs(["run", "--maxWorkers=4", "--testTimeout", "300000"], {
        TENKACLOUD_VITEST_MAX_WORKERS: "1",
        TENKACLOUD_VITEST_TEST_TIMEOUT_MS: "180000",
      }),
    ).toEqual(["run", "--maxWorkers=4", "--testTimeout", "300000"]);
  });

  it("should allow environment overrides for the default Vitest safety limits", () => {
    expect(
      buildVitestArgs(["run"], {
        TENKACLOUD_VITEST_MAX_WORKERS: "1",
        TENKACLOUD_VITEST_TEST_TIMEOUT_MS: "180000",
      }),
    ).toEqual(["run", "--maxWorkers=1", "--testTimeout=180000"]);
  });
});

// Issue #2515: existing cdk.out/test-synth visibility. Existing data can belong to a parallel run
// or an interrupted run, so the runner reports it but never assumes that it is safe to delete.
describe("existing cdk.out/test-synth visibility (#2515)", () => {
  it("should compute the recursive size of a directory tree", () => {
    const root = mkdtempSync(join(tmpdir(), "tenkacloud-du-"));
    tempDirs.push(root);
    mkdirSync(join(root, "nested"), { recursive: true });
    writeFileSync(join(root, "a.txt"), "x".repeat(10));
    writeFileSync(join(root, "nested", "b.txt"), "y".repeat(20));

    expect(directorySizeBytes(root)).toBe(30);
  });

  it("should return 0 for a path that does not exist", () => {
    expect(directorySizeBytes(join(tmpdir(), "tenkacloud-does-not-exist-xyz"))).toBe(0);
  });

  it("should format the existing-dir message with a top-level entry count", () => {
    expect(formatExistingCdkOutdirMessage(2)).toBe(
      "found 2 existing cdk.out/test-synth entries — active parallel, interrupted, or direct run",
    );
  });

  it("should log the existing-data message only when the dir contains data", () => {
    const root = mkdtempSync(join(tmpdir(), "tenkacloud-leftover-"));
    tempDirs.push(root);
    writeFileSync(join(root, "asset.zip"), "x".repeat(1024 * 1024));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    reportExistingCdkTestOutdir(root);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("existing cdk.out/test-synth entries"),
    );
    logSpy.mockRestore();
  });

  it("should not log anything when the directory is missing", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    reportExistingCdkTestOutdir(join(tmpdir(), "tenkacloud-no-leftover-xyz"));

    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("should clean only a successful run that was not interrupted", () => {
    expect(shouldCleanCdkTestRun(0, null, false)).toBe(true);
    expect(shouldCleanCdkTestRun(1, null, false)).toBe(false);
    expect(shouldCleanCdkTestRun(null, "SIGTERM", false)).toBe(false);
    expect(shouldCleanCdkTestRun(0, null, true)).toBe(false);
  });
});

// Issue #2515: opt-in CI report — top-15 slowest test files + CDK bundle count/size, the
// evidence the issue's acceptance criteria asks for. Only fires under CI or
// TENKACLOUD_VITEST_TIMINGS=1, and must never change the default `bun run test` output.
describe("Vitest timing/bundle report (#2515)", () => {
  it("should be disabled by default (no CI, no TENKACLOUD_VITEST_TIMINGS)", () => {
    expect(isTimingReportEnabled({})).toBe(false);
  });

  it("should enable when CI is truthy", () => {
    expect(isTimingReportEnabled({ CI: "true" })).toBe(true);
  });

  it("should enable when TENKACLOUD_VITEST_TIMINGS=1", () => {
    expect(isTimingReportEnabled({ TENKACLOUD_VITEST_TIMINGS: "1" })).toBe(true);
  });

  it("should add default+json reporter flags to buildVitestArgs when the report is enabled", () => {
    const root = mkdtempSync(join(tmpdir(), "tenkacloud-report-run-"));
    tempDirs.push(root);

    expect(buildVitestArgs(["run"], { TENKACLOUD_VITEST_TIMINGS: "1" }, root)).toEqual([
      "run",
      "--maxWorkers=2",
      "--testTimeout=120000",
      "--reporter=default",
      "--reporter=json",
      `--outputFile.json=${timingReportPath(root)}`,
    ]);
  });

  it("should require a run-scoped outdir when the timing report is enabled", () => {
    expect(() => buildVitestArgs(["run"], { TENKACLOUD_VITEST_TIMINGS: "1" })).toThrow(
      /report outdir is required/,
    );
  });

  it("should not add reporter flags when the caller already passed --reporter", () => {
    expect(
      buildVitestArgs(["run", "--reporter=verbose"], { TENKACLOUD_VITEST_TIMINGS: "1" }),
    ).toEqual(["run", "--reporter=verbose", "--maxWorkers=2", "--testTimeout=120000"]);
  });

  it("should sort test results by duration descending and cap at the given limit", () => {
    const report = {
      testResults: [
        { name: "a.test.ts", startTime: 0, endTime: 100 },
        { name: "b.test.ts", startTime: 0, endTime: 5000 },
        { name: "c.test.ts", startTime: 0, endTime: 2000 },
      ],
    };

    expect(slowestTestFiles(report, 2)).toEqual([
      { file: "b.test.ts", durationMs: 5000 },
      { file: "c.test.ts", durationMs: 2000 },
    ]);
  });

  it("should format slowest-test-file entries as one line per file", () => {
    expect(
      formatSlowestTestFiles([
        { file: "slow.test.ts", durationMs: 12345 },
        { file: "fast.test.ts", durationMs: 500 },
      ]),
    ).toEqual(["12.35s  slow.test.ts", "0.50s  fast.test.ts"]);
  });

  it("should find staged asset.* dirs/files without recursing into a matched asset dir", () => {
    const root = mkdtempSync(join(tmpdir(), "tenkacloud-assets-"));
    tempDirs.push(root);
    mkdirSync(join(root, "worker-0", "asset.abc123"), { recursive: true });
    writeFileSync(join(root, "worker-0", "asset.abc123", "index.js"), "x".repeat(10));
    writeFileSync(join(root, "worker-0", "asset.abc123", "index.js.map"), "y".repeat(20));
    writeFileSync(join(root, "worker-0", "Test.template.json"), "{}");

    expect(findAssetPaths(root)).toEqual([join(root, "worker-0", "asset.abc123")]);
  });

  it("should summarize bundle asset count and total size", () => {
    const root = mkdtempSync(join(tmpdir(), "tenkacloud-assets-"));
    tempDirs.push(root);
    mkdirSync(join(root, "asset.one"), { recursive: true });
    writeFileSync(join(root, "asset.one", "index.js"), "x".repeat(1024 * 1024));

    expect(summarizeBundleAssets(root)).toEqual({ count: 1, totalBytes: 1024 * 1024 });
  });

  it("should format the bundle summary with count and MB total", () => {
    expect(formatBundleSummary({ count: 3, totalBytes: 5 * 1024 * 1024 })).toBe(
      "CDK asset bundles produced: 3 (5.0 MB total)",
    );
  });

  it("should warn instead of throwing when the report file is missing or invalid", () => {
    const root = mkdtempSync(join(tmpdir(), "tenkacloud-report-missing-"));
    tempDirs.push(root);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(() => printTimingAndBundleReport(root)).not.toThrow();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Skipping test-timing"));
    warnSpy.mockRestore();
  });

  it("should print the slowest files and bundle summary when the report is valid", () => {
    const root = mkdtempSync(join(tmpdir(), "tenkacloud-report-valid-"));
    tempDirs.push(root);
    writeFileSync(
      timingReportPath(root),
      JSON.stringify({
        testResults: [{ name: "slow.test.ts", startTime: 0, endTime: 42 }],
      }),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    printTimingAndBundleReport(root);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Slowest test files"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("slow.test.ts"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("CDK asset bundles produced"));
    logSpy.mockRestore();
  });
});
