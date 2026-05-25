// Issue #1295: pin CDK test synth outdir to a repo-local gitignored path so
// the test suite stops leaking `cdk.outXXXXXX` into `$TMPDIR` indefinitely.
//
// aws-cdk-lib's `App` uses `process.env.CDK_OUTDIR` (cxapi.OUTDIR_ENV) when
// the `outdir` prop is omitted; otherwise it falls back to
// `fs.mkdtempSync(path.join(os.tmpdir(), "cdk.out"))`, which is never cleaned
// up — even on normal test exit. Pinning it to a worker-scoped path inside
// the repo means each worker reuses the same directory (overwritten per
// synth), so total disk usage caps at the distinct-asset count of the suite
// instead of growing with every test run.
import { join, resolve } from "node:path";

process.env.CDK_OUTDIR = join(
  resolve(__dirname, ".."),
  "cdk.out.test",
  process.env.VITEST_WORKER_ID ?? "0",
);
