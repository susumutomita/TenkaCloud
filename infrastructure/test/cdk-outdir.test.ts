import * as path from "node:path";
import { App, Stack } from "aws-cdk-lib";
import { describe, expect, it } from "vitest";

/**
 * Issue #1295: CDK tests must not leak `cdk.outXXXXXX` directories into
 * `$TMPDIR`. The test setup pins `process.env.CDK_OUTDIR` to a repo-local,
 * gitignored path (`infrastructure/cdk.out.test/<workerId>/`). The outer
 * test/run-vitest.ts wrapper purges worker directories between test runs.
 */
describe("CDK test outdir pinning (issue #1295)", () => {
  it("should pin process.env.CDK_OUTDIR to a repo-local cdk.out.test path", () => {
    const cdkOutdir = process.env.CDK_OUTDIR;
    expect(cdkOutdir).toBeDefined();
    const repoInternal = path.resolve(__dirname, "..", "cdk.out.test");
    expect(cdkOutdir?.startsWith(repoInternal)).toBe(true);
  });

  it("should land synth output inside the pinned outdir (not $TMPDIR)", () => {
    const app = new App();
    new Stack(app, "OutdirSmokeStack");
    const assembly = app.synth();
    const repoInternal = path.resolve(__dirname, "..", "cdk.out.test");
    expect(assembly.directory.startsWith(repoInternal)).toBe(true);
  });
});
