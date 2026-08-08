import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT_DIR = resolve(__dirname, "..", "..", "..", "scripts");
const PREPARE_SCRIPT = join(SCRIPT_DIR, "prepare-source-bundle.sh");

const tempDirs: string[] = [];

/**
 * Drop a fake `aws` on PATH so the resolution logic runs with no real credentials.
 * It mimics CodeBuild: `aws configure get region` exits non-zero (no config file)
 * unless FAKE_AWS_CONFIGURE_REGION is provided; `aws sts get-caller-identity`
 * returns FAKE_AWS_ACCOUNT_ID.
 */
function fakeAwsBinDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tenkacloud-fake-aws-"));
  tempDirs.push(dir);
  const aws = join(dir, "aws");
  // Brace-less $VAR refs (not ${VAR}) keep this bash readable to biome's
  // noTemplateCurlyInString rule while behaving identically for an unset var.
  writeFileSync(
    aws,
    [
      "#!/usr/bin/env bash",
      'if [ "$1" = "configure" ] && [ "$2" = "get" ] && [ "$3" = "region" ]; then',
      '  if [ -n "$FAKE_AWS_CONFIGURE_REGION" ]; then',
      '    echo "$FAKE_AWS_CONFIGURE_REGION"; exit 0',
      "  fi",
      "  exit 1", // CodeBuild: no config file -> empty + non-zero
      "fi",
      'if [ "$1" = "sts" ] && [ "$2" = "get-caller-identity" ]; then',
      '  if [ -n "$FAKE_AWS_ACCOUNT_ID" ]; then echo "$FAKE_AWS_ACCOUNT_ID"; exit 0; fi',
      "  exit 1",
      "fi",
      'echo "unexpected aws call: $*" >&2',
      "exit 99",
      "",
    ].join("\n"),
  );
  chmodSync(aws, 0o755);
  return dir;
}

function resolveBundleEnv(env: Record<string, string>): ReturnType<typeof spawnSync> {
  const binDir = fakeAwsBinDir();
  return spawnSync("bash", [PREPARE_SCRIPT], {
    encoding: "utf8",
    env: {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      PREPARE_SOURCE_BUNDLE_RESOLVE_ONLY: "1",
      // Treat empty as unset (the script uses ${VAR:-...}); each test sets what it needs.
      REGION: "",
      AWS_REGION: "",
      AWS_DEFAULT_REGION: "",
      FAKE_AWS_ACCOUNT_ID: "111122223333",
      ...env,
    },
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

/**
 * Regression: `tenkacloud-saas-pipeline` failed its Source stage on every run with
 * "The source artifact bucket '<bucket>' is not versioned." install.sh creates this bucket AND
 * the CodePipeline whose S3SourceAction reads it, but the bucket defaulted to Suspended
 * versioning — a self-contradiction that made the pipeline structurally unable to succeed.
 * The cost rationale for Suspended (unbounded old versions of the same source.zip key) is
 * already handled by the lifecycle policy applied immediately after.
 */
describe("scripts/prepare-source-bundle.sh bucket versioning", () => {
  const script = readFileSync(PREPARE_SCRIPT, "utf8");

  it("should enable versioning by default (CodePipeline S3 sources require it)", () => {
    expect(script).toMatch(/^\s*\*\) VERSIONING_STATUS="Enabled" ;;$/m);
    expect(script).not.toMatch(/^\s*\*\) VERSIONING_STATUS="Suspended" ;;$/m);
  });

  it("should still allow an explicit opt-out for a pipeline-less deployment", () => {
    expect(script).toMatch(/^\s*false \| suspended \| 0\) VERSIONING_STATUS="Suspended" ;;$/m);
  });

  it("should bound old versions with a lifecycle policy so Enabled cannot grow unbounded", () => {
    expect(script).toContain("put-bucket-lifecycle-configuration");
    // The policy itself is emitted by scripts/ops/print-source-bundle-lifecycle.ts; the point
    // here is that it is applied in the same run that turns versioning on.
    expect(script.indexOf('VERSIONING_STATUS="Enabled"')).toBeLessThan(
      script.indexOf("put-bucket-lifecycle-configuration"),
    );
  });
});

// bash + aws CLI shim を spawn する実 I/O テスト。全 suite 並列時は fork 飽和で
// default 5s を超え flake するため、明示 timeout を持つ (package-source-bundle と同型)。
// The resolve-only seam (PREPARE_SOURCE_BUNDLE_RESOLVE_ONLY=1) exits before the
// deploy steps run, so the resolution tests never exercise the `bun run` / `bash`
// helper invocations further down. This static guard catches a moved helper (e.g.
// #2566 relocated print-source-bundle-lifecycle.ts into scripts/ops/) whose
// ${SCRIPT_DIR}-relative reference here was not updated — the exact break that
// failed the CodeBuild Lite deploy.
describe("scripts/prepare-source-bundle.sh helper references", () => {
  it("should reference helper scripts that exist on disk", () => {
    const script = readFileSync(PREPARE_SCRIPT, "utf8");
    const referenced = [...script.matchAll(/\$\{SCRIPT_DIR\}\/(\S+?\.(?:ts|sh))/g)].map(
      (match) => match[1],
    );

    // The script does invoke ${SCRIPT_DIR}-relative helpers; guard against a
    // regex that silently matches nothing.
    expect(referenced.length).toBeGreaterThan(0);
    for (const relativePath of referenced) {
      expect(existsSync(join(SCRIPT_DIR, relativePath)), `missing helper: ${relativePath}`).toBe(
        true,
      );
    }
  });
});

describe("scripts/prepare-source-bundle.sh region resolution", { timeout: 30_000 }, () => {
  it("should resolve region from AWS_REGION when no aws config profile exists", () => {
    // Reproduces the CodeBuild Lite-deploy failure: AWS_REGION is injected by the
    // build environment but `aws configure get region` has no config file.
    const result = resolveBundleEnv({ AWS_REGION: "ap-northeast-1" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("REGION=ap-northeast-1");
    expect(result.stdout).toContain("ACCOUNT_ID=111122223333");
    // Per-environment bucket: account+region prefix + an 8-hex env hash (so a second
    // environment in the same account+region does not collide). Hash value is left
    // unpinned (depends on the ambient ENV) — only the format is asserted.
    expect(result.stdout).toMatch(
      /CDK_PARAM_S3_BUCKET_NAME=tenkacloud-source-111122223333-ap-northeast-1-[0-9a-f]{8}\b/,
    );
  });

  it("should fall back to AWS_DEFAULT_REGION when AWS_REGION is unset", () => {
    const result = resolveBundleEnv({ AWS_DEFAULT_REGION: "us-east-1" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("REGION=us-east-1");
  });

  it("should prefer an explicit REGION override over the AWS env vars", () => {
    const result = resolveBundleEnv({
      REGION: "eu-west-1",
      AWS_REGION: "ap-northeast-1",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("REGION=eu-west-1");
  });

  it("should still honor the local aws configure profile when no env region is set", () => {
    const result = resolveBundleEnv({ FAKE_AWS_CONFIGURE_REGION: "ap-southeast-2" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("REGION=ap-southeast-2");
  });

  it("should fail with a clear error when region cannot be resolved at all", () => {
    const result = resolveBundleEnv({});

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("REGION / ACCOUNT_ID を解決できません");
  });
});

describe("scripts/prepare-source-bundle.sh bucket resolution (fresh-account #1749)", {
  timeout: 30_000,
}, () => {
  it("should compute a per-environment bucket when the name is unset", () => {
    const result = resolveBundleEnv({ AWS_REGION: "ap-northeast-1" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(
      /CDK_PARAM_S3_BUCKET_NAME=tenkacloud-source-111122223333-ap-northeast-1-[0-9a-f]{8}\b/,
    );
  });

  it("should override the non-unique synth placeholder with a per-environment name", () => {
    // The Makefile's synth-only `tenkacloud-source-placeholder` is globally non-unique,
    // so a fresh account cannot create it; the deploy path must replace it.
    const result = resolveBundleEnv({
      AWS_REGION: "ap-northeast-1",
      CDK_PARAM_S3_BUCKET_NAME: "tenkacloud-source-placeholder",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(
      /CDK_PARAM_S3_BUCKET_NAME=tenkacloud-source-111122223333-ap-northeast-1-[0-9a-f]{8}\b/,
    );
  });

  it("should upgrade the legacy non-hashed account-region bucket name to per-environment", () => {
    // The Makefile default still emits `tenkacloud-source-<account>-<region>` (no hash);
    // the script is authoritative and upgrades it so two environments in the same
    // account+region get distinct buckets.
    const result = resolveBundleEnv({
      AWS_REGION: "ap-northeast-1",
      CDK_PARAM_S3_BUCKET_NAME: "tenkacloud-source-111122223333-ap-northeast-1",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(
      /CDK_PARAM_S3_BUCKET_NAME=tenkacloud-source-111122223333-ap-northeast-1-[0-9a-f]{8}\b/,
    );
  });

  it("should honor an explicit, non-placeholder bucket override", () => {
    const result = resolveBundleEnv({
      AWS_REGION: "ap-northeast-1",
      CDK_PARAM_S3_BUCKET_NAME: "my-own-source-bucket",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("CDK_PARAM_S3_BUCKET_NAME=my-own-source-bucket");
  });
});
