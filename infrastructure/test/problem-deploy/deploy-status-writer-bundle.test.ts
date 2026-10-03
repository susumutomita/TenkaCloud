import { describe, expect, it } from "vitest";
import { inspectRuntimeBundle } from "./runtime-bundle-inspection";

// Issue #2655: bundle 肥大による本番 Runtime.OutOfMemory 履歴に基づく安全弁。 #2864 で
// `@aws-sdk/*` を external 化して実測 283,647 bytes まで縮んだが、 上限は OOM 由来の値のまま
// 据え置く (= 依存更新や設計変更のついでに緩めない)。
const MAX_RUNTIME_BUNDLE_BYTES = 2_000_000;

describe("DeployStatusWriter runtime bundle (#2654, #2864)", () => {
  it("should exclude aws-cdk-lib and @aws-sdk and stay below the runtime-only size ceiling", async () => {
    const bundle = await inspectRuntimeBundle(
      "../../lib/problem-deploy/handlers/deploy-status-writer-handler/index.ts",
    );

    expect(bundle.inputs.some((input) => input.includes("node_modules/aws-cdk-lib/"))).toBe(false);
    // Issue #2864: `@aws-sdk/*` は runtime 同梱 SDK を使う設計のため、 1 file でも bundle に
    // 混入したら設計違反 (SDK patch 更新で再肥大する経路の復活) として落とす。
    expect(bundle.inputs.some((input) => input.includes("node_modules/@aws-sdk/"))).toBe(false);
    expect(bundle.bytes).toBeGreaterThan(0);
    expect(bundle.bytes).toBeLessThan(MAX_RUNTIME_BUNDLE_BYTES);
  });
});
