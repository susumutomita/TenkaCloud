import * as path from "node:path";
import { App, Stack } from "aws-cdk-lib";
import { describe, expect, it } from "vitest";
import { resolveCdkTestRunId, resolveVitestWorkerId } from "./cdk-test-outdir-contract";

/**
 * Issue #1295: CDK tests must not leak `cdk.outXXXXXX` directories into
 * `$TMPDIR`. The test setup pins `process.env.CDK_OUTDIR` to a repo-local,
 * gitignored path (`infrastructure/cdk.out/test-synth/<runId>/<workerId>/`) —
 * under `cdk.out/` so the build's `tsc` never type-checks a leftover run dir.
 * The outer test/run-vitest.ts wrapper owns and purges only its run directory.
 */
describe("CDK test outdir pinning (issue #1295)", () => {
  it("should pin process.env.CDK_OUTDIR to a repo-local cdk.out/test-synth path", () => {
    const cdkOutdir = process.env.CDK_OUTDIR;
    expect(cdkOutdir).toBeDefined();
    const repoInternal = path.resolve(__dirname, "..", "cdk.out", "test-synth");
    expect(cdkOutdir?.startsWith(repoInternal)).toBe(true);
    const relativeParts = path.relative(repoInternal, cdkOutdir ?? "").split(path.sep);
    expect(relativeParts).toHaveLength(2);
    expect(relativeParts[0]).toBe(resolveCdkTestRunId());
    expect(relativeParts[1]).toBe(resolveVitestWorkerId());
  });

  it("should land synth output inside the pinned outdir (not $TMPDIR)", () => {
    const app = new App({ autoSynth: false });
    new Stack(app, "OutdirSmokeStack");
    const assembly = app.synth();
    const repoInternal = path.resolve(__dirname, "..", "cdk.out", "test-synth");
    expect(assembly.directory.startsWith(repoInternal)).toBe(true);
  });

  it("should reject path traversal in the run and worker IDs", () => {
    expect(() => resolveCdkTestRunId({ TENKACLOUD_CDK_TEST_RUN_ID: "../escape" })).toThrow(
      /invalid TENKACLOUD_CDK_TEST_RUN_ID/,
    );
    expect(() => resolveVitestWorkerId({ VITEST_WORKER_ID: "../escape" })).toThrow(
      /invalid VITEST_WORKER_ID/,
    );
  });
});
