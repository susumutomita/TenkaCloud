import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { systemCloudIo } from "../../../scripts/cloud-hosting/process";
import { prepareCloudSourceBundle } from "../../../scripts/cloud-hosting/source-bundle";

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

function resolveBundleEnv(env: Record<string, string>): SpawnSyncReturns<string> {
  const binDir = fakeAwsBinDir();
  return spawnSync("/bin/bash", [PREPARE_SCRIPT], {
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
    expect(script).toContain('  *) VERSIONING_STATUS="Enabled" ;;');
    expect(script).not.toContain('  *) VERSIONING_STATUS="Suspended" ;;');
  });

  it("should still allow an explicit opt-out for a pipeline-less deployment", () => {
    expect(script).toContain('  false | suspended | 0) VERSIONING_STATUS="Suspended" ;;');
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
  it("keeps shell regex repetition within macOS's RE_DUP_MAX", () => {
    // Apple's regcomp rejects larger bounds even when the input is only source.zip.
    // https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man3/regexec.3.html
    const script = readFileSync(PREPARE_SCRIPT, "utf8");
    for (const match of script.matchAll(/\{\d+,(\d+)\}/gu))
      expect(Number(match[1]), `nonportable shell regex: ${match[0]}`).toBeLessThanOrEqual(255);
  });

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

describe("scripts/prepare-source-bundle.sh caller identity", { timeout: 30_000 }, () => {
  it("should reject an account override that disagrees with the active profile", () => {
    const result = resolveBundleEnv({ AWS_REGION: "us-east-1", ACCOUNT_ID: "999988887777" });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("does not match the active AWS profile");
  });

  it("should preserve an explicit source object key", () => {
    const result = resolveBundleEnv({
      AWS_REGION: "us-east-1",
      CDK_SOURCE_NAME: "releases/host.zip",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("CDK_SOURCE_NAME=releases/host.zip");
  });

  it.each(["source.zip", "releases/source.zip", "a".repeat(1024)])(
    "accepts valid source keys without a platform-specific regex bound (%s)",
    (key) => {
      const result = resolveBundleEnv({ AWS_REGION: "ap-northeast-1", CDK_SOURCE_NAME: key });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`CDK_SOURCE_NAME=${key}`);
    },
  );

  it("should resolve distinct buckets per environment", () => {
    const development = resolveBundleEnv({ AWS_REGION: "us-east-1", ENV: "development" });
    const production = resolveBundleEnv({ AWS_REGION: "us-east-1", ENV: "production" });
    expect(development.status).toBe(0);
    expect(production.status).toBe(0);
    expect(development.stdout).not.toBe(production.stdout);
  });
});

function preparationFixture(): { root: string; bin: string; log: string } {
  const root = mkdtempSync(join(tmpdir(), "tenkacloud-prepare-bundle-"));
  tempDirs.push(root);
  const write = (relative: string, contents: string) => {
    mkdirSync(resolve(root, relative, ".."), { recursive: true });
    writeFileSync(join(root, relative), contents);
  };
  for (const relative of ["prepare-source-bundle.sh", "package-source-bundle.sh", "lib/names.sh"]) {
    mkdirSync(resolve(root, "scripts", relative, ".."), { recursive: true });
    copyFileSync(join(SCRIPT_DIR, relative), join(root, "scripts", relative));
  }
  write("scripts/ops/print-source-bundle-lifecycle.ts", "// Stubbed by fake Bun");
  write("package.json", JSON.stringify({ workspaces: ["infrastructure", "packages/*"] }));
  write(".nvmrc", "24");
  write("infrastructure/lib/index.ts", "export {};");
  write("packages/runtime/index.ts", "export {};");
  write("problems/demo/metadata.json", "{}");
  for (const app of ["application-admin-console", "participant-portal"]) {
    write(`apps/${app}/dist/index.html`, "built application");
  }
  write(
    "bin/aws",
    [
      "#!/usr/bin/env bash",
      'echo "aws|$AWS_PROFILE|$*" >> "$COMMAND_LOG"',
      'if [ "$1 $2" = "sts get-caller-identity" ]; then echo 111122223333; exit 0; fi',
      'if [ "$1 $2" = "s3api head-bucket" ]; then exit 1; fi',
      'if [ "$1 $2" = "s3api head-object" ]; then echo \'{"ETag":"abcdefabcdefabcdefabcdefabcdefab","VersionId":"version-A"}\'; exit 0; fi',
      `if [ "$1 $2" = "s3api put-object" ]; then test -f "$SOURCE_BUNDLE_ARCHIVE_PATH" || exit 98; printf '\\"abcdefabcdefabcdefabcdefabcdefab\\"\\tversion-A\\n'; fi`,
    ].join("\n"),
  );
  write("bin/git", '#!/usr/bin/env bash\necho "git|$*" >> "$COMMAND_LOG"\n');
  write(
    "bin/bun",
    [
      "#!/usr/bin/env bash",
      'echo "bun|$PWD|$*" >> "$COMMAND_LOG"',
      `if [ "$3" = "build" ]; then [ "$FAIL_BUILD" != "1" ]; else echo '{"Rules":[]}'; fi`,
    ].join("\n"),
  );
  for (const program of ["aws", "git", "bun"]) chmodSync(join(root, "bin", program), 0o755);
  return { root, bin: join(root, "bin"), log: join(root, "commands.log") };
}

function runPreparation(
  fixture: ReturnType<typeof preparationFixture>,
  failBuild = false,
  extraEnv: Record<string, string> = {},
) {
  return spawnSync("/bin/bash", [join(fixture.root, "scripts", "prepare-source-bundle.sh")], {
    encoding: "utf8",
    env: {
      PATH: `${fixture.bin}:${process.env.PATH ?? ""}`,
      AWS_PROFILE: "host-test",
      AWS_REGION: "us-east-1",
      COMMAND_LOG: fixture.log,
      FAIL_BUILD: failBuild ? "1" : "0",
      SOURCE_BUNDLE_PIN_EXECUTION: "1",
      ...extraEnv,
    },
  });
}

describe("scripts/prepare-source-bundle.sh offline orchestration", { timeout: 30_000 }, () => {
  it("runs the make-deploy adapter through real subprocesses and ZIP preparation with only AWS/build tools replaced", async () => {
    const fixture = preparationFixture();
    const env = await prepareCloudSourceBundle(
      {
        root: fixture.root,
        env: {
          PATH: `${fixture.bin}:${process.env.PATH ?? ""}`,
          ACCOUNT_ID: "111122223333",
          REGION: "ap-northeast-1",
          ENV: "development",
          AWS_PROFILE: "host-test",
          COMMAND_LOG: fixture.log,
          FAIL_BUILD: "0",
        },
      },
      systemCloudIo(),
    );
    expect(env.CDK_PARAM_S3_BUCKET_NAME).toMatch(
      /^tenkacloud-source-111122223333-ap-northeast-1-[a-f0-9]{8}$/u,
    );
    expect(env.CDK_SOURCE_NAME).toMatch(/^source\.zip\.executions\/[a-f0-9-]{36}\.zip$/u);
    expect(env.CDK_SOURCE_VERSION_ID).toBe("version-A");
    expect(env.CDK_PARAM_COMMIT_ID).toBe("abcdefabcdefabcdefabcdefabcdefab");
    const calls = readFileSync(fixture.log, "utf8");
    expect(calls).toContain("s3api head-object");
    expect(calls).toContain("--version-id version-A");
    expect(calls).toContain("--expected-bucket-owner 111122223333");
    expect(existsSync(join(fixture.root, ".cache", "source-bundle"))).toBe(false);
  });

  it("should build the two apps before AWS mutation and keep profile/region/owner consistent", () => {
    const fixture = preparationFixture();
    const result = runPreparation(fixture);
    expect(result.status, result.stderr).toBe(0);
    const log = readFileSync(fixture.log, "utf8");
    const calls = log.trim().split("\n");
    expect(log).toContain("git|submodule update --init --recursive problems");
    expect(log).not.toContain("--force");
    expect(log).not.toContain("install");
    for (const call of calls.filter((call) => call.startsWith("bun|"))) {
      expect(call).toContain("|--no-env-file run ");
    }
    expect(
      calls.filter((call) => call.startsWith("bun|") && call.endsWith("--no-env-file run build")),
    ).toHaveLength(2);
    expect(log.indexOf("participant-portal|--no-env-file run build")).toBeLessThan(
      log.indexOf("s3api head-bucket"),
    );
    for (const call of calls.filter((call) => call.startsWith("aws|"))) {
      expect(call).toContain("aws|host-test|");
      expect(call).toContain("--region us-east-1");
      if (call.includes("s3api") && !call.includes("create-bucket")) {
        expect(call).toContain("--expected-bucket-owner 111122223333");
      }
    }
    expect(log).toContain("--if-none-match * --query [ETag,VersionId] --output text");
    expect(result.stdout).toContain("SOURCE_UPLOAD_VERSION_ID=version-A");
    expect(log).toMatch(/--key source\.zip\.executions\/[a-f0-9-]{36}\.zip/u);
    expect(existsSync(join(fixture.root, ".cache", "source-bundle"))).toBe(false);
  });

  it("rejects disabled versioning for pinned cloud execution before building or bucket changes", () => {
    const fixture = preparationFixture();
    const result = runPreparation(fixture, false, { CDK_PARAM_SOURCE_BUCKET_VERSIONING: "false" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("pins require source bucket versioning");
    const log = readFileSync(fixture.log, "utf8");
    expect(log).not.toContain("s3api");
    expect(log).not.toContain("bun|");
  });

  it("should not mutate AWS or leave an archive when a local build fails", () => {
    const fixture = preparationFixture();
    const result = runPreparation(fixture, true);
    expect(result.status).not.toBe(0);
    expect(readFileSync(fixture.log, "utf8")).not.toContain("s3api");
    expect(existsSync(join(fixture.root, ".cache", "source-bundle"))).toBe(false);
  });
});

it.each(["../source.zip", "release/./source.zip", "release/../source.zip", "x".repeat(1025)])(
  "should reject unsafe or oversized source keys before preparation (%s)",
  (key) => {
    const result = resolveBundleEnv({ AWS_REGION: "us-east-1", CDK_SOURCE_NAME: key });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("invalid source bucket or object key");
  },
);

it("should reject invalid repeated dots in bucket names", () => {
  const result = resolveBundleEnv({
    AWS_REGION: "us-east-1",
    CDK_PARAM_S3_BUCKET_NAME: "my..bucket",
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("invalid source bucket or object key");
});
