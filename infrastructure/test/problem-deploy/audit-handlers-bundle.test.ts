import { describe, expect, it } from "vitest";
import { inspectRuntimeBundle } from "./runtime-bundle-inspection";

// A CDK leak inflated the affected runtime graph to roughly 36 MB. The old 5 MB ceiling left room
// for bundled AWS SDK clients; #2864 externalized `@aws-sdk/*` (runtime-provided SDK), so that
// allowance is gone and the ceiling tightens to the #2655 OOM-derived safety value shared with
// the DeployStatusWriter guard (measured: both audit bundles are ~285 KB after #2864).
const MAX_RUNTIME_BUNDLE_BYTES = 2_000_000;

const HANDLERS = [
  {
    name: "ExternalIdAudit",
    entry: "../../lib/problem-deploy/handlers/external-id-audit-handler/index.ts",
  },
  {
    name: "SystemAuditWriter",
    entry: "../../lib/problem-deploy/handlers/system-audit-writer/index.ts",
  },
] as const;

describe("audit handler runtime bundles (#2655, #2864)", () => {
  it.each(
    HANDLERS,
  )("should exclude aws-cdk-lib and @aws-sdk and stay below the runtime-only size ceiling ($name)", async ({
    entry,
  }) => {
    const bundle = await inspectRuntimeBundle(entry);

    expect(bundle.inputs.some((input) => input.includes("node_modules/aws-cdk-lib/"))).toBe(false);
    // Issue #2864: `@aws-sdk/*` は runtime 同梱 SDK を使う設計のため、 bundle への混入は設計違反。
    expect(bundle.inputs.some((input) => input.includes("node_modules/@aws-sdk/"))).toBe(false);
    expect(bundle.bytes).toBeGreaterThan(0);
    expect(bundle.bytes).toBeLessThan(MAX_RUNTIME_BUNDLE_BYTES);
  });
});
