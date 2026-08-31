import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { afterEach, describe, expect, it } from "vitest";
import { CfnDeployLambda } from "../lib/problem-deploy/cfn-deploy-lambda";
import { SYNTH_TIMEOUT_MS } from "./problem-deploy-backend-stack.test-helpers";

/**
 * Issue #2515: test/setup.ts skips real esbuild asset bundling for every other test in this
 * suite (see test/bundling-skip-context.test.ts). This file is the ONE deliberate exception —
 * it opts back into real bundling for a single, minimal `defineNodejsFunction` construct
 * (`CfnDeployLambda`, chosen because its handler is one of the smallest in the codebase and it
 * needs no DynamoDB tables / CodeBuild project to construct) so CI keeps exercising the esbuild
 * bundling path at least once per run. Do not add more real-bundling tests elsewhere — if more
 * esbuild coverage is needed, extend this file instead.
 */
describe("NodejsFunction real-bundling smoke test (Issue #2515)", () => {
  let outdir: string | undefined;

  afterEach(() => {
    if (outdir) rmSync(outdir, { force: true, recursive: true });
    outdir = undefined;
  });

  it(
    "should really esbuild-bundle a NodejsFunction when the skip context is removed",
    () => {
      outdir = mkdtempSync(join(tmpdir(), "tenkacloud-bundling-smoke-"));

      // test/setup.ts sets CDK_CONTEXT_JSON globally to skip bundling. Context is read inside
      // the `App` constructor, so temporarily clearing just the bundling-stacks key (preserving
      // any other keys already present) and restoring it right after is enough to make this one
      // `new App({ autoSynth: false })` call opt back into real bundling.
      const savedContextJson = process.env.CDK_CONTEXT_JSON;
      let app: cdk.App;
      try {
        const context: Record<string, unknown> = savedContextJson
          ? JSON.parse(savedContextJson)
          : {};
        delete context["aws:cdk:bundling-stacks"];
        process.env.CDK_CONTEXT_JSON = JSON.stringify(context);
        app = new cdk.App({ autoSynth: false, outdir });
      } finally {
        if (savedContextJson === undefined) {
          delete process.env.CDK_CONTEXT_JSON;
        } else {
          process.env.CDK_CONTEXT_JSON = savedContextJson;
        }
      }

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

      expect(bundledAssets.length).toBeGreaterThan(0);
    },
    SYNTH_TIMEOUT_MS,
  );
});
