import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { afterEach, describe, expect, it } from "vitest";
import { CfnDeployLambda } from "../lib/problem-deploy/cfn-deploy-lambda";

/**
 * Issue #2515: `test/setup.ts` sets `process.env.CDK_CONTEXT_JSON` (aws-cdk-lib's `App`
 * constructor reads this env var — `cxapi.CONTEXT_ENV` — on every construction, regardless of
 * whether `props.context` was passed) so every `new App({ autoSynth: false })` created anywhere in the
 * infrastructure test suite defaults `aws:cdk:bundling-stacks` to `[]` and skips real esbuild
 * bundling. That esbuild step (~6.5-8s per Lambda, ~35MB js + ~90MB sourcemap) is what dominates
 * `test:coverage` wall time; skipping it in every test but one is the fix.
 *
 * The one deliberate exception is test/nodejs-function-bundling-smoke.test.ts, which opts back
 * into real bundling for a single, minimal Lambda so CI still exercises the esbuild path once.
 */
describe("CDK bundling-skip test context (Issue #2515)", () => {
  let outdir: string | undefined;

  afterEach(() => {
    if (outdir) rmSync(outdir, { force: true, recursive: true });
    outdir = undefined;
  });

  it("should default a fresh App's aws:cdk:bundling-stacks context to []", () => {
    const app = new cdk.App({ autoSynth: false });
    expect(app.node.tryGetContext("aws:cdk:bundling-stacks")).toEqual([]);
  });

  it("should synth a NodejsFunction-bearing stack without staging a real esbuild bundle", () => {
    // Isolated outdir (not the shared per-worker CDK_OUTDIR) so this assertion can't be
    // confused by another test file's staged assets landing in the same directory.
    outdir = mkdtempSync(join(tmpdir(), "tenkacloud-bundling-skip-"));
    const app = new cdk.App({ autoSynth: false, outdir });
    const stack = new cdk.Stack(app, "Test", {
      env: { account: "123456789012", region: "ap-northeast-1" },
    });
    new CfnDeployLambda(stack, "CfnDeploy", {
      environmentName: "development",
      sourceBucketName: "serverless-saas-123456789012-ap-northeast-1",
    });
    Template.fromStack(stack);

    const bundledAssets = readdirSync(outdir)
      .filter((name) => name.startsWith("asset."))
      .filter((name) => existsSync(join(outdir as string, name, "index.js")));

    expect(bundledAssets).toEqual([]);
  });
});
