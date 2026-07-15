import { resolve } from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

/**
 * Issue #2655 (root cause #2654): the ExternalIdAudit and SystemAuditWriter Lambdas were sized to
 * 1024MB in #2652 out of caution that they carried "the same 36.3MB bundle" as DeployStatusWriter
 * (aws-cdk-lib leaking into the runtime graph). #2657 removed that leak at the source and guards it
 * with the `handler-no-transitive-cdk-import` harness rule. These bundle-size tests pin the outcome
 * for the two audit handlers the same way `deploy-status-writer-bundle.test.ts` does for the writer:
 * their runtime bundles must exclude aws-cdk-lib and stay small, so the 1024MB stopgap can only ever
 * be lowered (never re-inflated) by the live re-measurement tracked in #2650.
 */

// A CDK leak inflated these bundles to ~36MB (#2654). aws-cdk-lib bundled is multiple MB on its
// own, so a ceiling here — generous enough for the real runtime deps (@libsql/client + the AWS SDK
// clients these handlers use) — still fails loudly if aws-cdk-lib (or a comparably heavy construct
// dependency) ever re-enters the graph. The metafile assertion below is the exact guard; this is the
// gross-bloat backstop.
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

describe("audit handler runtime bundles (#2655 / #2654)", () => {
  it.each(
    HANDLERS,
  )("should exclude aws-cdk-lib and stay below the runtime-only size ceiling ($name)", async ({
    entry,
  }) => {
    const result = await build({
      entryPoints: [resolve(import.meta.dirname, entry)],
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
