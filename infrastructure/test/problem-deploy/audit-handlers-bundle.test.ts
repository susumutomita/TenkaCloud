import { describe, expect, it } from "vitest";
import { inspectRuntimeBundle } from "./runtime-bundle-inspection";

// A CDK leak inflated the affected runtime graph to roughly 36 MB. This ceiling leaves generous
// room for @libsql/client and the AWS SDK clients while still catching a comparable regression.
const MAX_RUNTIME_BUNDLE_BYTES = 5_000_000;

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

describe("audit handler runtime bundles (#2655)", () => {
  it.each(
    HANDLERS,
  )("should exclude aws-cdk-lib and stay below the runtime-only size ceiling ($name)", async ({
    entry,
  }) => {
    const bundle = await inspectRuntimeBundle(entry);

    expect(bundle.inputs.some((input) => input.includes("node_modules/aws-cdk-lib/"))).toBe(false);
    expect(bundle.bytes).toBeGreaterThan(0);
    expect(bundle.bytes).toBeLessThan(MAX_RUNTIME_BUNDLE_BYTES);
  });
});
