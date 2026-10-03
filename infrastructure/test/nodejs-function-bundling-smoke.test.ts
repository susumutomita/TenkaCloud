import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import type { Asset } from "aws-cdk-lib/aws-s3-assets";
import { afterEach, describe, expect, it } from "vitest";
import { CfnDeployLambda } from "../lib/problem-deploy/cfn-deploy-lambda";
import { CoordinationDispatcherLambda } from "../lib/problem-deploy/coordination-dispatcher-lambda";
import { MAX_DEFINE_VALUE_BYTES } from "../lib/utils/define-nodejs-function";
import { discoverProblemsCoordination } from "../lib/utils/discover-problems-catalog";
import { SYNTH_TIMEOUT_MS } from "./problem-deploy-backend-stack.test-helpers";

/**
 * Issue #2515: test/setup.ts skips real esbuild asset bundling for every other test in this
 * suite (see test/bundling-skip-context.test.ts). This file is the ONE deliberate exception —
 * it opts back into real bundling for the minimal `defineNodejsFunction` construct
 * (`CfnDeployLambda`, chosen because its handler is one of the smallest in the codebase and it
 * needs no DynamoDB tables / CodeBuild project to construct), plus the coordination dispatcher
 * whose catalog score ownership must reach the deployed bundle. Do not add more real-bundling tests elsewhere — if more
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
      // The score-mode producer must reach the deployed dispatcher through its
      // build-time catalog literal, without adding to the Lambda env's 4 KiB limit.
      const catalog = discoverProblemsCoordination(resolve(import.meta.dirname, "../../problems"));
      expect(catalog["ac26-crypto-battle"].scoreMode).toBe("exclusive");
      expect(Buffer.byteLength(JSON.stringify(JSON.stringify(catalog)))).toBeLessThan(
        MAX_DEFINE_VALUE_BYTES,
      );
      const dispatcher = new CoordinationDispatcherLambda(stack, "CoordinationDispatcher", {
        environmentName: "development",
        controlDataBackend: "turso",
        tursoDatabaseUrl: "https://example.turso.io",
        tursoAuthTokenParameterName: "/local/fixture",
        problemsCoordination: catalog,
      });
      const template = Template.fromStack(stack);
      for (const resource of Object.values(template.findResources("AWS::Lambda::Function"))) {
        expect(resource.Properties.Environment.Variables).not.toHaveProperty(
          "PROBLEM_COORDINATION",
        );
      }
      const asset = dispatcher.fn.node.findChild("Code") as Asset;
      const bundle = readFileSync(join(outdir, asset.assetPath, "index.js"), "utf8");
      expect(bundle.replaceAll('\\"', '"')).toContain(JSON.stringify(catalog));

      const bundledAssets = readdirSync(outdir)
        .filter((name) => name.startsWith("asset."))
        .filter((name) => existsSync(join(outdir as string, name, "index.js")));

      expect(bundledAssets.length).toBeGreaterThan(0);
    },
    SYNTH_TIMEOUT_MS,
  );
});
