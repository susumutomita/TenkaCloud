// Issue #1295: pin CDK test synth outdir to a repo-local gitignored path so
// the test suite stops leaking `cdk.outXXXXXX` into `$TMPDIR` indefinitely.
//
// aws-cdk-lib's `App` uses `process.env.CDK_OUTDIR` (cxapi.OUTDIR_ENV) when
// the `outdir` prop is omitted; otherwise it falls back to
// `fs.mkdtempSync(path.join(os.tmpdir(), "cdk.out"))`, which is never cleaned
// up — even on normal test exit. Pinning it to a run + worker-scoped path inside
// the repo keeps output owned by this package. VITEST_WORKER_ID is unique only
// inside one Vitest invocation, so test/run-vitest.ts supplies a unique run ID
// and purges only that invocation's directory.
//
// The path lives *under* `cdk.out/` (a `cdk.out/test-synth/` subtree) on purpose:
// `infrastructure/tsconfig.json` and `vitest.config.ts` both already exclude
// `cdk.out`, and the source bundle excludes `cdk.out*`. Keeping test synth under
// that umbrella means a leftover run dir can never be type-checked by the build's
// `tsc` (no `include`, so it globs everything else) — the failure mode that broke
// `make deploy` when this dir was the sibling `cdk.out.test/`.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveCdkTestRunId, resolveVitestWorkerId } from "./cdk-test-outdir-contract";

const runId = resolveCdkTestRunId();
const workerId = resolveVitestWorkerId();

process.env.CDK_OUTDIR = join(resolve(__dirname, ".."), "cdk.out", "test-synth", runId, workerId);

// Issue #2515: skip real esbuild asset bundling for every CDK stack synthed in the test suite.
// aws-cdk-lib's `App` constructor unconditionally merges `CDK_CONTEXT_JSON` (cxapi.CONTEXT_ENV)
// into its context — this happens regardless of whether the test also passed a `context` prop,
// so setting this one env var here reaches every `new cdk.App({ autoSynth: false })` call in every test file without
// per-file changes. Real esbuild bundling (~6.5-8s per Lambda, ~35MB js + ~90MB sourcemap) is
// what dominates `test:coverage` wall time; the only intentional exception is
// test/nodejs-function-bundling-smoke.test.ts, which temporarily clears this key around its own
// `new App({ autoSynth: false })` call to keep one real-bundling exercise in the suite. See
// test/bundling-skip-context.test.ts for the pin.
//
// Merge rather than clobber: some other tool in the chain (e.g. a wrapped `cdk` CLI invocation)
// may already have populated CDK_CONTEXT_JSON before this process starts.
const existingCdkContext: Record<string, unknown> = process.env.CDK_CONTEXT_JSON
  ? JSON.parse(process.env.CDK_CONTEXT_JSON)
  : {};

process.env.CDK_CONTEXT_JSON = JSON.stringify({
  ...existingCdkContext,
  "aws:cdk:bundling-stacks": [],
});

// Every SPA-hosting construct stages its app's `dist/` through `BucketDeployment`'s
// `Source.asset`, which validates that the path EXISTS at synth time. A test run does not build
// the apps, so several test files each carried their own `ensurePlaceholderDist()` in a
// `beforeAll` — and about ten other files that synth the same constructs (TenantTemplateStack,
// AppPlaneCore, TenkaCloudLiteStack, the *-hosting constructs) carried none. Those files only
// passed because some file with the helper happened to run first in the same invocation and left
// the directory behind on disk.
//
// That order dependency became a failure the moment CI split the suite across runners
// (`run-coverage.ts --part`): the shard holding tenant-template-stack-saml.test.ts had no
// dist-creating file in it, and three tests died with `CannotFindAsset`. Creating the placeholder
// here — setup runs before EVERY test file — makes the precondition belong to the suite instead
// of to a lucky ordering. A real `vite build` overwrites it, so this has no effect on a built tree.
const REPO_ROOT = resolve(__dirname, "..", "..");
const PLACEHOLDER_DIST_APPS = [
  "application-admin-console",
  "admin-console",
  "participant-portal",
] as const;

for (const app of PLACEHOLDER_DIST_APPS) {
  const distDir = join(REPO_ROOT, "apps", app, "dist");
  if (existsSync(distDir)) continue;
  mkdirSync(distDir, { recursive: true });
  writeFileSync(
    join(distDir, "index.html"),
    "<!doctype html><html><body>placeholder</body></html>",
  );
}
