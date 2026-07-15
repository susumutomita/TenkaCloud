import { describe, expect, it } from "vitest";
import { inspectRuntimeBundle } from "./runtime-bundle-inspection";

const MAX_RUNTIME_BUNDLE_BYTES = 2_000_000;

describe("DeployStatusWriter runtime bundle (#2654)", () => {
  it("should exclude aws-cdk-lib and stay below the runtime-only size ceiling", async () => {
    const bundle = await inspectRuntimeBundle(
      "../../lib/problem-deploy/handlers/deploy-status-writer-handler/index.ts",
    );

    expect(bundle.inputs.some((input) => input.includes("node_modules/aws-cdk-lib/"))).toBe(false);
    expect(bundle.bytes).toBeGreaterThan(0);
    expect(bundle.bytes).toBeLessThan(MAX_RUNTIME_BUNDLE_BYTES);
  });
});
