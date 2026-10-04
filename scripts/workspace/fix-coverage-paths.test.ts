import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { prefixCoveragePaths } from "./fix-coverage-paths.ts";
import { COVERAGE_WORKSPACES } from "./run-coverage.ts";

const repoRoot = resolve(import.meta.dir, "../..");

describe("workspace LCOV paths", () => {
  it("maps an SDK report to a real repository source file", () => {
    const sdk = COVERAGE_WORKSPACES.find((workspace) => workspace.dir === "packages/problem-sdk");
    expect(sdk).toBeDefined();
    if (!sdk) throw new Error("problem-sdk is absent from the coverage workspace registry");
    const report = prefixCoveragePaths(
      "SF:src/disruption-request.ts\nDA:1,1\nend_of_record\n",
      sdk.dir,
    );
    expect(report).toContain("SF:packages/problem-sdk/src/disruption-request.ts\n");
    const source = report.match(/^SF:(.+)$/m)?.[1];
    expect(source).toBeDefined();
    if (!source) throw new Error("normalized report has no source file");
    expect(existsSync(resolve(repoRoot, source))).toBe(true);
  });

  it("does not prefix a report twice", () => {
    const report =
      "SF:src/disruption-triggers.ts\nSF:packages/problem-sdk/src/score-projection.ts\n";
    const once = prefixCoveragePaths(report, "packages/problem-sdk");
    expect(once).toBe(
      "SF:packages/problem-sdk/src/disruption-triggers.ts\nSF:packages/problem-sdk/src/score-projection.ts\n",
    );
    expect(prefixCoveragePaths(once, "packages/problem-sdk")).toBe(once);
  });
});
