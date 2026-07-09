// Issue #1295: pin CDK test synth outdir to a repo-local gitignored path so
// the test suite stops leaking `cdk.outXXXXXX` into `$TMPDIR` indefinitely.
//
// aws-cdk-lib's `App` uses `process.env.CDK_OUTDIR` (cxapi.OUTDIR_ENV) when
// the `outdir` prop is omitted; otherwise it falls back to
// `fs.mkdtempSync(path.join(os.tmpdir(), "cdk.out"))`, which is never cleaned
// up — even on normal test exit. Pinning it to a worker-scoped path inside
// the repo keeps output owned by this package. test/run-vitest.ts purges the
// worker directories before and after each run because VITEST_WORKER_ID is not
// stable across runs.
import { join, resolve } from "node:path";

process.env.CDK_OUTDIR = join(
  resolve(__dirname, ".."),
  "cdk.out.test",
  process.env.VITEST_WORKER_ID ?? "0",
);

// Issue #2515: skip real esbuild asset bundling for every CDK stack synthed in the test suite.
// aws-cdk-lib's `App` constructor unconditionally merges `CDK_CONTEXT_JSON` (cxapi.CONTEXT_ENV)
// into its context — this happens regardless of whether the test also passed a `context` prop,
// so setting this one env var here reaches every `new cdk.App()` call in every test file without
// per-file changes. Real esbuild bundling (~6.5-8s per Lambda, ~35MB js + ~90MB sourcemap) is
// what dominates `test:coverage` wall time; the only intentional exception is
// test/nodejs-function-bundling-smoke.test.ts, which temporarily clears this key around its own
// `new App()` call to keep one real-bundling exercise in the suite. See
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
