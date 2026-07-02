import { spawnSync } from "node:child_process";
import {
  chmodSync,
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

/**
 * scripts/lib/battles-common.sh `assume_competitor_role_if_configured` (#2205).
 *
 * The cross-account AssumeRole path (competitor CFn CreateStack via CodeBuild) plus its
 * N-1 ExternalId grace fallback (#603) had no bash-level test — only the unrelated Lambda
 * helper (`assume-competitor-role.test.ts`) was covered. This pins the 5 scenarios the
 * issue calls out, plus one more edge (grace fallback with no previous version to try).
 *
 * `assume_competitor_role_if_configured` is a shell *function*, not a standalone script, so
 * the driver sources `battles-common.sh` then calls it inside one `bash -c` invocation —
 * mirrors `delete-battles-account-check.test.ts`'s fake-`aws`-on-PATH pattern. All variable
 * data flows through child env (never string-interpolated into the `-c` command) to avoid
 * shell injection, matching that file's convention.
 */

const BATTLES_COMMON = resolve(__dirname, "..", "..", "..", "scripts", "lib", "battles-common.sh");
const tempDirs: string[] = [];

interface RunResult {
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly awsCalls: string;
}

function run(env: Record<string, string>): RunResult {
  const dir = mkdtempSync(join(tmpdir(), "tenkacloud-battles-common-"));
  tempDirs.push(dir);
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const callLog = join(dir, "aws-calls.log");

  // Fake `aws` covers exactly the 3 subcommands assume_competitor_role_if_configured issues:
  //   ssm get-parameter --name <param>              (current version, JSON output)
  //   ssm get-parameter --name <param>:<N>           (a specific previous version, text output)
  //   sts assume-role --external-id <id> ...         (success iff id == FAKE_ASSUME_SUCCESS_EXTERNAL_ID)
  const fakeAws = `#!/usr/bin/env bash
echo "$@" >> "$AWS_CALL_LOG"

find_flag_value() {
  local flag="$1"
  shift
  local want_next=0
  for arg in "$@"; do
    if [ "$want_next" = 1 ]; then echo "$arg"; return 0; fi
    if [ "$arg" = "$flag" ]; then want_next=1; fi
  done
}

if [ "$1" = "ssm" ] && [ "$2" = "get-parameter" ]; then
  name="$(find_flag_value --name "$@")"
  case "$name" in
    *:*)
      if [ -n "\${FAKE_PREVIOUS_EXTERNAL_ID:-}" ]; then
        echo "\${FAKE_PREVIOUS_EXTERNAL_ID}"
        exit 0
      fi
      exit 254
      ;;
    *)
      if [ -n "\${FAKE_CURRENT_EXTERNAL_ID:-}" ]; then
        echo "{\\"Parameter\\":{\\"Value\\":\\"\${FAKE_CURRENT_EXTERNAL_ID}\\",\\"Version\\":\${FAKE_CURRENT_VERSION:-1}}}"
        exit 0
      fi
      exit 254
      ;;
  esac
fi

if [ "$1" = "sts" ] && [ "$2" = "assume-role" ]; then
  ext_id="$(find_flag_value --external-id "$@")"
  if [ -n "\${FAKE_ASSUME_SUCCESS_EXTERNAL_ID:-}" ] && [ "$ext_id" = "\${FAKE_ASSUME_SUCCESS_EXTERNAL_ID}" ]; then
    echo '{"Credentials":{"AccessKeyId":"AKIAFAKE","SecretAccessKey":"fake-secret","SessionToken":"fake-token"}}'
    exit 0
  fi
  echo "fake AccessDenied for external-id=\${ext_id}" >&2
  exit 254
fi

exit 0
`;
  writeFileSync(join(binDir, "aws"), fakeAws);
  chmodSync(join(binDir, "aws"), 0o755);

  const result = spawnSync(
    "bash",
    [
      "-c",
      'set -e; source "$BATTLES_COMMON"; assume_competitor_role_if_configured; ' +
        'echo "RESULT_AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID:-}"; ' +
        'echo "RESULT_AWS_REGION=${AWS_REGION:-}"',
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        AWS_CALL_LOG: callLog,
        BATTLES_COMMON,
        COMPETITOR_ROLE_ARN: "",
        EXTERNAL_ID_SSM_PARAMETER: "",
        // This sandbox's ambient environment injects proxy AWS credentials; clear them so
        // "no credentials applied" assertions observe the script's own behavior, not the host.
        AWS_ACCESS_KEY_ID: "",
        AWS_SECRET_ACCESS_KEY: "",
        AWS_SESSION_TOKEN: "",
        AWS_REGION: "",
        AWS_DEFAULT_REGION: "",
        ...env,
      },
    },
  );
  return {
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
    awsCalls: existsSync(callLog) ? readFileSync(callLog, "utf8") : "",
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("battles-common.sh assume_competitor_role_if_configured (#2205 / #603 grace fallback)", {
  timeout: 30_000,
}, () => {
  it("should take the same-account path (no AssumeRole) when both vars are unset", () => {
    const { status, awsCalls, stdout } = run({});

    expect(status).toBe(0);
    expect(awsCalls).toBe("");
    expect(stdout).toContain("RESULT_AWS_ACCESS_KEY_ID=");
    expect(stdout).not.toMatch(/RESULT_AWS_ACCESS_KEY_ID=\S/);
  });

  it("should fail loudly when only COMPETITOR_ROLE_ARN is set (fail-closed on partial config)", () => {
    const { status, stderr, awsCalls } = run({
      COMPETITOR_ROLE_ARN: "arn:aws:iam::999999999999:role/competitor-deploy",
    });

    expect(status).toBe(1);
    expect(stderr).toContain("両方必須です");
    expect(awsCalls).toBe("");
  });

  it("should fail loudly when only EXTERNAL_ID_SSM_PARAMETER is set (fail-closed on partial config)", () => {
    const { status, stderr, awsCalls } = run({
      EXTERNAL_ID_SSM_PARAMETER: "/tenkacloud/battles/external-id",
    });

    expect(status).toBe(1);
    expect(stderr).toContain("両方必須です");
    expect(awsCalls).toBe("");
  });

  it("should succeed and apply credentials with the current ExternalId", () => {
    const { status, stderr, stdout } = run({
      COMPETITOR_ROLE_ARN: "arn:aws:iam::999999999999:role/competitor-deploy",
      EXTERNAL_ID_SSM_PARAMETER: "/tenkacloud/battles/external-id",
      FAKE_CURRENT_EXTERNAL_ID: "ext-current",
      FAKE_CURRENT_VERSION: "3",
      FAKE_ASSUME_SUCCESS_EXTERNAL_ID: "ext-current",
    });

    expect(status, stderr).toBe(0);
    // battles-common.sh writes progress/success lines to stdout — only its `error:` lines
    // go to stderr (grep the source: only 4 lines use `>&2`).
    expect(stdout).not.toContain("grace_fallback_used");
    expect(stdout).toContain("RESULT_AWS_ACCESS_KEY_ID=AKIAFAKE");
  });

  it("should fall back to the N-1 ExternalId (grace window) when the current one is rejected", () => {
    const { status, stderr, stdout } = run({
      COMPETITOR_ROLE_ARN: "arn:aws:iam::999999999999:role/competitor-deploy",
      EXTERNAL_ID_SSM_PARAMETER: "/tenkacloud/battles/external-id",
      FAKE_CURRENT_EXTERNAL_ID: "ext-rotated",
      FAKE_CURRENT_VERSION: "3",
      FAKE_PREVIOUS_EXTERNAL_ID: "ext-previous",
      FAKE_ASSUME_SUCCESS_EXTERNAL_ID: "ext-previous",
    });

    expect(status, stderr).toBe(0);
    expect(stdout).toContain("grace_fallback_used");
    expect(stdout).toContain("version=2");
    expect(stdout).toContain("RESULT_AWS_ACCESS_KEY_ID=AKIAFAKE");
  });

  it("should fail loudly when both the current and N-1 ExternalId are rejected", () => {
    const { status, stderr, stdout } = run({
      COMPETITOR_ROLE_ARN: "arn:aws:iam::999999999999:role/competitor-deploy",
      EXTERNAL_ID_SSM_PARAMETER: "/tenkacloud/battles/external-id",
      FAKE_CURRENT_EXTERNAL_ID: "ext-rotated",
      FAKE_CURRENT_VERSION: "3",
      FAKE_PREVIOUS_EXTERNAL_ID: "ext-previous",
      FAKE_ASSUME_SUCCESS_EXTERNAL_ID: "ext-neither-matches",
    });

    expect(status).toBe(1);
    expect(stderr).toContain("AssumeRole failed with both current and previous");
    expect(stdout).not.toMatch(/RESULT_AWS_ACCESS_KEY_ID=\S/);
  });

  it("should fail loudly (not attempt a version-0 lookup) when the current version is 1", () => {
    const { status, stderr, awsCalls } = run({
      COMPETITOR_ROLE_ARN: "arn:aws:iam::999999999999:role/competitor-deploy",
      EXTERNAL_ID_SSM_PARAMETER: "/tenkacloud/battles/external-id",
      FAKE_CURRENT_EXTERNAL_ID: "ext-only-version",
      FAKE_CURRENT_VERSION: "1",
      FAKE_ASSUME_SUCCESS_EXTERNAL_ID: "some-other-id",
    });

    expect(status).toBe(1);
    expect(stderr).toContain("no previous version is available");
    expect(awsCalls).not.toMatch(/:0\b/);
  });
});
