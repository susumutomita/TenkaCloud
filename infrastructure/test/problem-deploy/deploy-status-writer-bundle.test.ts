import { resolve } from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const MAX_RUNTIME_BUNDLE_BYTES = 2_000_000;

describe("DeployStatusWriter runtime bundle (#2654)", () => {
  it("should exclude aws-cdk-lib and stay below the runtime-only size ceiling", async () => {
    const result = await build({
      entryPoints: [
        resolve(
          import.meta.dirname,
          "../../lib/problem-deploy/handlers/deploy-status-writer-handler/index.ts",
        ),
      ],
      bundle: true,
      metafile: true,
      minify: true,
      platform: "node",
      target: "node22",
      write: false,
      outfile: "index.js",
    });

    const bundledInputs = Object.keys(result.metafile?.inputs ?? {});
    expect(bundledInputs.some((input) => input.includes("node_modules/aws-cdk-lib/"))).toBe(false);

    const output = result.outputFiles?.find((file) => file.path.endsWith("index.js"));
    expect(output?.contents.byteLength).toBeGreaterThan(0);
    expect(output?.contents.byteLength).toBeLessThan(MAX_RUNTIME_BUNDLE_BYTES);
  });
});
