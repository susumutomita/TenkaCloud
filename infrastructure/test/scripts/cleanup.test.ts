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
 * scripts/cleanup.sh idempotency (#2204). CLAUDE.md promises `make destroy-saas`
 * (this script) removes every stack + S3 bucket "idempotently from any partial-failure
 * / partial-delete state" -- a promise with zero machine verification before this file.
 *
 * cleanup.sh is a real, long-running script that shells out to `aws` (many subcommands)
 * and `bun run cdk -- destroy`. Both are faked on PATH (mirrors delete-battles-account-check.test.ts
 * / battles-common-assume-role.test.ts); the script itself is NOT modified (per the issue's
 * "変更しないこと"). All scenario data flows through child env, never interpolated into a
 * shell command string, to avoid injection.
 */

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const CLEANUP_SCRIPT = resolve(REPO_ROOT, "scripts", "cleanup.sh");
const tempDirs: string[] = [];
/** `.env` fixtures written inside the repo (cleanup.sh resolves ENV_FILE relative to it). */
const fixtureDirs: string[] = [];

interface RunResult {
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly awsCalls: string;
  readonly bunCalls: string;
  /** `aws` + `bun` invocations in a single ordered log, for step-ordering assertions. */
  readonly orderedCalls: string;
  /** `CDK_PARAM_*` variables as the `bun`/cdk child process actually saw them. */
  readonly cdkParamEnv: string;
}

interface Scenario {
  /** Buckets `aws s3 ls` returns, filtered by cleanup.sh's own regex before use. */
  readonly s3Buckets?: readonly string[];
  readonly sourceBucketExists?: boolean;
  readonly adminConsoleHostingStackExists?: boolean;
  /** Full CFn stack names cleanup.sh's tenant-stack list-stacks query should return. */
  readonly tenantStacks?: readonly string[];
  /** Full SSM parameter names (already `/external-id`-suffixed) to report as orphans. */
  readonly orphanSsmParams?: readonly string[];
  /** [#2959] `aws dynamodb list-tables` が返す table 名。 */
  readonly dynamoTables?: readonly string[];
  /** [#2960] `aws logs describe-log-groups` が返す log group 名。 */
  readonly logGroups?: readonly string[];
  /** [#2960] delete-log-group が失敗し、その後も見える log group 名。 */
  readonly logGroupDeleteFailures?: readonly string[];
  /** [#2959] delete-table が失敗し、その後も describe-table で見える table 名。 */
  readonly dynamoDeleteFailures?: readonly string[];
  /** `cdk destroy --all` exits non-zero (e.g. synth failure) instead of tearing stacks down. */
  readonly cdkDestroyAllFails?: boolean;
  /**
   * CFn cancels the admin-console-hosting delete and reverts the stack to CREATE_COMPLETE
   * (what really happens while another stack still imports one of its exports).
   */
  readonly adminConsoleHostingDeleteCanceled?: boolean;
  /** `ENV` to run under; the caller is responsible for the matching `.env` fixture. */
  readonly env?: string;
  /** `aws sts get-caller-identity` fails the way an expired SSO session really fails. */
  readonly stsExpired?: boolean;
  /**
   * Pre-set (already exported) CDK params, the way `make` does: Makefile `-include`s the
   * .env and then bares an `export`, so every .env variable reaches the script's environment
   * before it runs -- with its quoting intact.
   */
  readonly preExportedCdkParams?: Readonly<Record<string, string>>;
}

function run(scenario: Scenario): RunResult {
  const dir = mkdtempSync(join(tmpdir(), "tenkacloud-cleanup-"));
  tempDirs.push(dir);
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const callLog = join(dir, "aws-calls.log");
  const bunCallLog = join(dir, "bun-calls.log");

  const s3Buckets = scenario.s3Buckets ?? [];
  const tenantStacks = scenario.tenantStacks ?? [];
  const orphanSsmParams = scenario.orphanSsmParams ?? [];
  const dynamoTables = scenario.dynamoTables ?? [];
  const logGroups = scenario.logGroups ?? [];
  const logGroupDeleteFailures = scenario.logGroupDeleteFailures ?? [];
  const dynamoDeleteFailures = scenario.dynamoDeleteFailures ?? [];

  // Fake `aws`: covers exactly the subcommands cleanup.sh issues. Cognito UserPool / API
  // Gateway key / LogGroup orphan sweeps always report "nothing found" -- those 3 scans are
  // identical read-then-conditionally-delete shapes to the SSM sweep this test does pin, and
  // the issue's own scope is "最低3シナリオ(冪等性) + SSM orphan 対象選択".
  const fakeAws = `#!/usr/bin/env bash
echo "$@" >> "$AWS_CALL_LOG"
echo "aws $@" >> "$ORDERED_CALL_LOG"

find_flag_value() {
  local flag="$1"
  shift
  local want_next=0
  for arg in "$@"; do
    if [ "$want_next" = 1 ]; then echo "$arg"; return 0; fi
    if [ "$arg" = "$flag" ]; then want_next=1; fi
  done
}

case "$1 $2" in
  "configure get")
    echo "\${FAKE_REGION}"
    exit 0
    ;;
  "sts get-caller-identity")
    if [ "\${FAKE_STS_EXPIRED:-0}" = "1" ]; then
      echo "aws: [ERROR]: Your session has expired. Please reauthenticate using 'aws login'." >&2
      exit 255
    fi
    echo "\${FAKE_ACCOUNT_ID}"
    exit 0
    ;;
  "s3 ls")
    for b in \${FAKE_S3_BUCKETS}; do
      echo "2024-01-01 00:00:00 $b"
    done
    exit 0
    ;;
  "s3api head-bucket")
    bucket="$(find_flag_value --bucket "$@")"
    if [ "$bucket" = "\${FAKE_SOURCE_BUCKET}" ]; then
      [ "\${FAKE_SOURCE_BUCKET_EXISTS:-0}" = "1" ] && exit 0 || exit 255
    fi
    for b in \${FAKE_S3_BUCKETS}; do
      [ "$b" = "$bucket" ] && exit 0
    done
    exit 255
    ;;
  "s3api list-object-versions")
    echo '{"Versions":[],"DeleteMarkers":[]}'
    exit 0
    ;;
  "s3api delete-bucket")
    exit 0
    ;;
  "cloudformation describe-stacks")
    name="$(find_flag_value --stack-name "$@")"
    if [ "$name" = "tenkacloud-admin-console-hosting" ]; then
      [ "\${FAKE_ADMIN_CONSOLE_HOSTING_EXISTS:-0}" = "1" ] || exit 255
      # Before the delete is issued the stack is simply there. Afterwards it either
      # disappears (describe-stacks fails, = the real DELETE_COMPLETE observation) or,
      # when CFn cancels the delete, reverts to CREATE_COMPLETE and stays forever.
      if [ -f "$DELETE_MARKER" ]; then
        if [ "\${FAKE_ADMIN_CONSOLE_HOSTING_DELETE_CANCELED:-0}" = "1" ]; then
          echo "CREATE_COMPLETE"
          exit 0
        fi
        exit 255
      fi
      echo "CREATE_COMPLETE"
      exit 0
    fi
    exit 255
    ;;
  "cloudformation delete-stack")
    touch "$DELETE_MARKER"
    exit 0
    ;;
  "cloudformation describe-stack-events")
    echo "\${FAKE_DELETE_CANCEL_REASON}"
    exit 0
    ;;
  "cloudformation wait")
    exit 0
    ;;
  "cloudformation list-stacks")
    for s in \${FAKE_TENANT_STACKS}; do
      printf '%s\\t' "$s"
    done
    echo
    exit 0
    ;;
  "ssm describe-parameters")
    for p in \${FAKE_ORPHAN_SSM_PARAMS}; do
      printf '%s\\t' "$p"
    done
    echo
    exit 0
    ;;
  "ssm delete-parameter")
    exit 0
    ;;
  "logs describe-log-groups")
    lg_prefix="$(find_flag_value --log-group-name-prefix "$@")"
    for g in \${FAKE_LOG_GROUPS}; do
      case "$g" in
        "$lg_prefix"*)
          # 削除済みのものは返さない (= 冪等性と 「already gone」 判定のため)。
          if [ -f "$LG_DELETE_LOG" ] && grep -qx "$g" "$LG_DELETE_LOG" 2>/dev/null; then
            for f in \${FAKE_LG_DELETE_FAILS}; do
              [ "$f" = "$g" ] && printf '%s\\t' "$g"
            done
            continue
          fi
          printf '%s\\t' "$g"
          ;;
      esac
    done
    echo
    exit 0
    ;;
  "logs delete-log-group")
    lg_name="$(find_flag_value --log-group-name "$@")"
    echo "$lg_name" >> "$LG_DELETE_LOG"
    for f in \${FAKE_LG_DELETE_FAILS}; do
      [ "$f" = "$lg_name" ] && exit 255
    done
    exit 0
    ;;
  "cognito-idp list-user-pools")
    echo ""
    exit 0
    ;;
  "apigateway get-api-keys")
    echo ""
    exit 0
    ;;
  "dynamodb list-tables")
    for t in \${FAKE_DYNAMODB_TABLES}; do
      printf '%s\\t' "$t"
    done
    echo
    exit 0
    ;;
  "dynamodb delete-table")
    ddb_name="$(find_flag_value --table-name "$@")"
    echo "$ddb_name" >> "$DDB_DELETE_LOG"
    for f in \${FAKE_DDB_DELETE_FAILS}; do
      [ "$f" = "$ddb_name" ] && exit 255
    done
    exit 0
    ;;
  "dynamodb describe-table")
    ddb_name="$(find_flag_value --table-name "$@")"
    # 削除に失敗した table だけ 「まだ居る」 = 本当の失敗として扱う。
    for f in \${FAKE_DDB_DELETE_FAILS}; do
      [ "$f" = "$ddb_name" ] && exit 0
    done
    exit 255
    ;;
  *)
    exit 0
    ;;
esac
`;
  writeFileSync(join(binDir, "aws"), fakeAws);
  chmodSync(join(binDir, "aws"), 0o755);

  // Fake `bun`: cleanup.sh's only real `bun` calls are `bun run cdk -- destroy ...` (bun install is
  // guarded by `[[ ! -d node_modules ]]`, which is false in this checked-out repo).
  // The child also records the CDK_PARAM_* it inherited: cleanup.sh must NOT relay
  // .env-derived CDK params into cdk (bash `source` mangles JSON values), so this log
  // is what pins that contract.
  const fakeBun = `#!/usr/bin/env bash
echo "$@" >> "$BUN_CALL_LOG"
echo "bun $@" >> "$ORDERED_CALL_LOG"
env | grep '^CDK_PARAM_' >> "$FAKE_CDK_PARAM_ENV_LOG" || true
if [ "$1" = "run" ] && [ "$2" = "cdk" ] && [ "$4" = "destroy" ]; then
  if [ "$5" = "--all" ] && [ "\${FAKE_CDK_DESTROY_ALL_FAILS:-0}" = "1" ]; then
    echo "synth failed" >&2
    exit 1
  fi
  exit 0
fi
if [ "$1" = "install" ]; then
  exit 0
fi
exit 0
`;
  writeFileSync(join(binDir, "bun"), fakeBun);
  chmodSync(join(binDir, "bun"), 0o755);

  const FAKE_ACCOUNT_ID = "123456789012";
  const FAKE_REGION = "ap-northeast-1";
  const sourceBucket = `tenkacloud-source-${FAKE_ACCOUNT_ID}-${FAKE_REGION}`;
  const orderedCallLog = join(dir, "ordered-calls.log");
  const ddbDeleteLog = join(dir, "ddb-deletes.log");
  const lgDeleteLog = join(dir, "lg-deletes.log");
  const cdkParamEnvLog = join(dir, "cdk-param-env.log");
  // The runner's own environment must not decide the outcome of the CDK_PARAM_* assertions:
  // strip anything a developer shell may have exported before handing env to the script.
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith("CDK_PARAM_")) {
      delete childEnv[key];
    }
  }

  const result = spawnSync("bash", [CLEANUP_SCRIPT], {
    encoding: "utf8",
    cwd: resolve(__dirname, "..", "..", ".."),
    env: {
      ...childEnv,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      AWS_CALL_LOG: callLog,
      BUN_CALL_LOG: bunCallLog,
      ORDERED_CALL_LOG: orderedCallLog,
      FAKE_CDK_PARAM_ENV_LOG: cdkParamEnvLog,
      DELETE_MARKER: join(dir, "deleted-admin-console-hosting"),
      ENV: scenario.env ?? "tenkacloud-cleanup-test-env-does-not-exist",
      SYSTEM_ADMIN_EMAIL: "admin@example.com",
      FAKE_REGION: "ap-northeast-1",
      FAKE_ACCOUNT_ID: "123456789012",
      FAKE_SOURCE_BUCKET: sourceBucket,
      FAKE_SOURCE_BUCKET_EXISTS: scenario.sourceBucketExists ? "1" : "0",
      FAKE_ADMIN_CONSOLE_HOSTING_EXISTS: scenario.adminConsoleHostingStackExists ? "1" : "0",
      FAKE_ADMIN_CONSOLE_HOSTING_DELETE_CANCELED: scenario.adminConsoleHostingDeleteCanceled
        ? "1"
        : "0",
      FAKE_DELETE_CANCEL_REASON:
        "Cannot delete export tenkacloud-admin-console-hosting:ExportsOutputFnGetAttDistributionDomainName as it is in use by tenkacloud-admin-console-insight and tenkacloud-control-plane.",
      FAKE_CDK_DESTROY_ALL_FAILS: scenario.cdkDestroyAllFails ? "1" : "0",
      FAKE_STS_EXPIRED: scenario.stsExpired ? "1" : "0",
      FAKE_S3_BUCKETS: s3Buckets.join(" "),
      FAKE_TENANT_STACKS: tenantStacks.join(" "),
      FAKE_ORPHAN_SSM_PARAMS: orphanSsmParams.join(" "),
      DDB_DELETE_LOG: ddbDeleteLog,
      FAKE_DYNAMODB_TABLES: dynamoTables.join(" "),
      LG_DELETE_LOG: lgDeleteLog,
      FAKE_LOG_GROUPS: logGroups.join(" "),
      FAKE_LG_DELETE_FAILS: logGroupDeleteFailures.join(" "),
      FAKE_DDB_DELETE_FAILS: dynamoDeleteFailures.join(" "),
      ...(scenario.preExportedCdkParams ?? {}),
    },
  });
  return {
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
    awsCalls: existsSync(callLog) ? readFileSync(callLog, "utf8") : "",
    bunCalls: existsSync(bunCallLog) ? readFileSync(bunCallLog, "utf8") : "",
    orderedCalls: existsSync(orderedCallLog) ? readFileSync(orderedCallLog, "utf8") : "",
    cdkParamEnv: existsSync(cdkParamEnvLog) ? readFileSync(cdkParamEnvLog, "utf8") : "",
    ddbDeletes: existsSync(ddbDeleteLog) ? readFileSync(ddbDeleteLog, "utf8") : "",
    lgDeletes: existsSync(lgDeleteLog) ? readFileSync(lgDeleteLog, "utf8") : "",
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
  for (const dir of fixtureDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("cleanup.sh idempotency (#2204)", { timeout: 30_000 }, () => {
  it("should remove every resource when everything still exists", () => {
    const { status, stderr, awsCalls, bunCalls, stdout } = run({
      s3Buckets: ["tenkacloud-tenant-template-pooled-hostingbucket-abc"],
      sourceBucketExists: true,
      adminConsoleHostingStackExists: true,
      tenantStacks: ["tenkacloud-tenant-template-01hzx0k3m3k9zqhb3mrqhba1b2"],
      orphanSsmParams: ["/development/tenants/01hzx0k3m3k9zqhb3mrqhba1b2/external-id"],
    });

    expect(status, stderr).toBe(0);
    expect(awsCalls).toContain("s3api delete-bucket");
    expect(awsCalls).toContain(
      "cloudformation delete-stack --stack-name tenkacloud-admin-console-hosting",
    );
    expect(bunCalls).toContain(
      "run cdk -- destroy tenkacloud-tenant-template-01hzx0k3m3k9zqhb3mrqhba1b2 --force",
    );
    expect(bunCalls).toContain("run cdk -- destroy --all --force");
    expect(awsCalls).toContain(
      "ssm delete-parameter --name /development/tenants/01hzx0k3m3k9zqhb3mrqhba1b2/external-id",
    );
    expect(stdout).toContain("cleanup complete.");
  });

  it("should skip already-deleted resources and still finish successfully", () => {
    const { status, stderr, awsCalls, bunCalls, stdout } = run({
      s3Buckets: [],
      sourceBucketExists: false,
      adminConsoleHostingStackExists: false,
      tenantStacks: ["tenkacloud-tenant-template-01hzx0k3m3k9zqhb3mrqhba1b2"],
      orphanSsmParams: ["/development/tenants/01hzx0k3m3k9zqhb3mrqhba1b2/external-id"],
    });

    expect(status, stderr).toBe(0);
    expect(stdout).toContain("tenkacloud-admin-console-hosting not found; skip");
    expect(awsCalls).not.toContain(
      "cloudformation delete-stack --stack-name tenkacloud-admin-console-hosting",
    );
    expect(awsCalls).not.toContain("s3api delete-bucket");
    // The already-gone resources are skipped, but the still-present ones are still cleaned up.
    expect(bunCalls).toContain(
      "run cdk -- destroy tenkacloud-tenant-template-01hzx0k3m3k9zqhb3mrqhba1b2 --force",
    );
    expect(awsCalls).toContain(
      "ssm delete-parameter --name /development/tenants/01hzx0k3m3k9zqhb3mrqhba1b2/external-id",
    );
    expect(stdout).toContain("cleanup complete.");
  });

  it("should succeed with no errors when nothing was ever deployed", () => {
    const { status, stderr, awsCalls, bunCalls, stdout } = run({
      s3Buckets: [],
      sourceBucketExists: false,
      adminConsoleHostingStackExists: false,
      tenantStacks: [],
      orphanSsmParams: [],
    });

    expect(status, stderr).toBe(0);
    expect(stdout).toContain("(already gone)");
    expect(stdout).toContain("no orphan SSM parameters found");
    expect(awsCalls).not.toContain("s3api delete-bucket");
    expect(awsCalls).not.toContain("ssm delete-parameter");
    // cdk destroy --all still runs unconditionally (it's the idempotent backstop for the
    // CDK-managed pooled stack), but no per-tenant destroy is issued when none exist.
    expect(bunCalls).toContain("run cdk -- destroy --all --force");
    expect(bunCalls).not.toContain("run cdk -- destroy tenkacloud-tenant-template-");
    expect(stdout).toContain("cleanup complete.");
  });

  it("should scope the SSM orphan scan to the current ENV and delete only what it returns", () => {
    const { awsCalls } = run({
      orphanSsmParams: [
        "/development/tenants/team-a/external-id",
        "/development/tenants/team-b/external-id",
      ],
    });

    expect(awsCalls).toContain(
      "ssm describe-parameters --parameter-filters Key=Name,Option=BeginsWith,Values=/tenkacloud-cleanup-test-env-does-not-exist/tenants/",
    );
    expect(awsCalls).toContain(
      "ssm delete-parameter --name /development/tenants/team-a/external-id",
    );
    expect(awsCalls).toContain(
      "ssm delete-parameter --name /development/tenants/team-b/external-id",
    );
  });

  it("should not attempt to delete an SSM parameter when the orphan scan returns none", () => {
    const { awsCalls, stdout } = run({ orphanSsmParams: [] });

    expect(awsCalls).toContain("ssm describe-parameters");
    expect(awsCalls).not.toContain("ssm delete-parameter");
    expect(stdout).toContain("no orphan SSM parameters found");
  });

  // Issue #2444 -> #2959: かつては report-retained-tables.ts を bun run して billing 警告を
  // 出すだけだった。 その 「警告のみ」 運用の実測結果が 3 か月弱の無駄な課金だったので、
  // 既定を実削除に変えた。 sweep は完了バナーより前に走る。
  it("should sweep orphaned DynamoDB tables before finishing", () => {
    const { status, stderr, stdout } = run({});

    expect(status, stderr).toBe(0);
    expect(stdout).toContain("scanning for orphaned DynamoDB tables");
    expect(stdout).toContain("cleanup complete.");
    // 警告だけ出して終わる旧挙動に戻っていないこと。
    expect(stdout).not.toContain("billing warning only");
  });

  // ---- Regression: `make destroy-saas` once finished with "cleanup complete." + exit 0
  // while every backend stack was still deployed. Three defects made that possible. ----

  // 1. `cdk destroy --all` failing was swallowed into a single log line, so a total no-op
  //    teardown was indistinguishable from a successful one.
  it("should fail loudly when cdk destroy --all cannot tear the backend stacks down", () => {
    const { status, stdout } = run({ cdkDestroyAllFails: true });

    expect(status).not.toBe(0);
    expect(stdout).toContain("cdk destroy --all failed");
    expect(stdout).toContain("STILL DEPLOYED");
    expect(stdout).toContain("cleanup INCOMPLETE");
    // Nothing was torn down, so the script must not claim completion.
    expect(stdout).not.toContain("cleanup complete.");
  });

  // 2. The admin-console-hosting CFN-direct delete ran BEFORE `cdk destroy --all`, but
  //    control-plane / admin-console-insight import its CloudFront domain export -- CFn
  //    cancels a delete whose exports are still in use, so that ordering could never work
  //    from a fully deployed state.
  it("should delete admin-console-hosting only after cdk destroy --all released its exports", () => {
    const { orderedCalls } = run({ adminConsoleHostingStackExists: true });

    const destroyAllAt = orderedCalls.indexOf("bun run cdk -- destroy --all --force");
    const hostingDeleteAt = orderedCalls.indexOf(
      "aws cloudformation delete-stack --stack-name tenkacloud-admin-console-hosting",
    );

    expect(destroyAllAt).toBeGreaterThanOrEqual(0);
    expect(hostingDeleteAt).toBeGreaterThanOrEqual(0);
    expect(destroyAllAt).toBeLessThan(hostingDeleteAt);
  });

  // 3. `aws cloudformation wait stack-delete-complete` does not treat "delete canceled,
  //    stack reverted to CREATE_COMPLETE" as terminal, so it polled for the full 60 minutes
  //    while nothing happened. The replacement bails as soon as the stack leaves
  //    DELETE_IN_PROGRESS and prints what CloudFormation actually said.
  it("should stop waiting and surface the reason when CFn cancels the hosting delete", () => {
    const { status, stdout, awsCalls } = run({
      adminConsoleHostingStackExists: true,
      adminConsoleHostingDeleteCanceled: true,
    });

    expect(stdout).toContain("delete did not proceed (status=CREATE_COMPLETE)");
    expect(stdout).toContain("as it is in use by tenkacloud-admin-console-insight");
    expect(stdout).toContain("cleanup INCOMPLETE");
    expect(status).not.toBe(0);
    // The blocking `aws cloudformation wait` is gone for good.
    expect(awsCalls).not.toContain("cloudformation wait");
  });

  // 4. The root cause of the no-op: `set -a; source .env` strips the double quotes from
  //    `CDK_PARAM_FEATURES={"samlSso":true}`, exporting `{samlSso:true}`. cdk's own dotenv
  //    loader then refuses to override the already-set (mangled) value and synth dies on
  //    JSON.parse -- taking the whole `cdk destroy --all` with it. cleanup.sh must not relay
  //    .env-derived CDK params at all; the CDK app reads the same file itself.
  it("should not relay .env CDK_PARAM_* into cdk (bash source mangles JSON values)", () => {
    const envName = "tenkacloud-cleanup-test-env-fixture";
    const envDir = join(REPO_ROOT, "infrastructure", "environments", envName);
    mkdirSync(envDir, { recursive: true });
    fixtureDirs.push(envDir);
    writeFileSync(
      join(envDir, ".env"),
      ["SYSTEM_ADMIN_EMAIL=admin@example.com", 'CDK_PARAM_FEATURES={"samlSso":true}', ""].join(
        "\n",
      ),
    );

    const { status, stderr, cdkParamEnv } = run({ env: envName });

    expect(status, stderr).toBe(0);
    // cdk really was invoked with the params cleanup.sh owns (otherwise the checks below
    // would pass vacuously).
    expect(cdkParamEnv).toContain("CDK_PARAM_SYSTEM_ADMIN_EMAIL=admin@example.com");
    // The mangled value must never reach the child ...
    expect(cdkParamEnv).not.toContain("{samlSso:true}");
    // ... and neither must the .env-derived variable in any form.
    expect(cdkParamEnv).not.toContain("CDK_PARAM_FEATURES");
  });

  // 4b. The same defect has a second route, and killing only the first leaves it alive.
  //     Makefile `-include`s the .env then bares an `export`, so `make destroy-saas` hands
  //     cleanup.sh an already-exported, correctly-quoted CDK_PARAM_FEATURES. Re-assigning an
  //     exported variable keeps the export attribute, so a plain `source` (even without
  //     `set -a`) still propagates bash's quote-stripped value. Measured:
  //       make-exported : {"samlSso":true}
  //       after source  : {samlSso:true}
  //     cleanup.sh must therefore pass a pre-exported param through untouched.
  it("should pass make-exported CDK params through to cdk unmangled", () => {
    const envName = "tenkacloud-cleanup-test-env-make-export";
    const envDir = join(REPO_ROOT, "infrastructure", "environments", envName);
    mkdirSync(envDir, { recursive: true });
    fixtureDirs.push(envDir);
    writeFileSync(
      join(envDir, ".env"),
      ["SYSTEM_ADMIN_EMAIL=admin@example.com", 'CDK_PARAM_FEATURES={"samlSso":true}', ""].join(
        "\n",
      ),
    );

    const { status, stderr, cdkParamEnv } = run({
      env: envName,
      preExportedCdkParams: { CDK_PARAM_FEATURES: '{"samlSso":true}' },
    });

    expect(status, stderr).toBe(0);
    expect(cdkParamEnv).toContain('CDK_PARAM_FEATURES={"samlSso":true}');
    expect(cdkParamEnv).not.toContain("{samlSso:true}");
  });

  // 5. `export ACCOUNT_ID="$(aws sts ...)"` lets export's exit status win (SC2155), so an
  //    expired session left ACCOUNT_ID empty and the sweep carried on against bucket names
  //    built from an empty account id. Observed live: cleanup.sh logged "emptying related
  //    buckets" immediately after "Your session has expired".
  it("should stop immediately when the AWS session has expired", () => {
    const { status, stderr, awsCalls } = run({
      stsExpired: true,
      s3Buckets: ["tenkacloud-tenant-template-pooled-hostingbucket-abc"],
      adminConsoleHostingStackExists: true,
    });

    expect(status).not.toBe(0);
    expect(stderr).toContain("aws login");
    // Nothing may be swept with an unresolved account id.
    expect(awsCalls).not.toContain("s3 ls");
    expect(awsCalls).not.toContain("cloudformation delete-stack");
  });

  // 6. [#2959] destroy 後に残る DynamoDB table は、 かつて 「列挙して警告するだけ」 だった。
  //    その運用で 8 table + GSI 7 本を 3 か月弱払い続けたのが起票理由なので、 既定を削除に変えた。
  //    RemovalPolicy を DESTROY にしただけでは過去に RETAIN で deploy された孤児は残るため、
  //    この sweep が唯一の回収経路になる。
  describe("orphaned DynamoDB tables (#2959)", () => {
    it("should delete tenkacloud tables that outlived their stacks", () => {
      const { ddbDeletes, stdout } = run({
        dynamoTables: ["tenkacloud-problem-deploy-Events123", "tenkacloud-lite-Teams456"],
      });
      expect(ddbDeletes).toContain("tenkacloud-problem-deploy-Events123");
      expect(ddbDeletes).toContain("tenkacloud-lite-Teams456");
      expect(stdout).toContain("deleted 2 orphaned DynamoDB table(s)");
    });

    it("should never touch a table belonging to another project", () => {
      // 誤爆はコスト超過より取り返しがつかない。 prefix 一致だけを対象にする。
      const { ddbDeletes, stdout } = run({
        dynamoTables: ["some-other-project-Users", "prod-billing-ledger", "my-tenkacloud-copy"],
      });
      expect(ddbDeletes).not.toContain("some-other-project-Users");
      expect(ddbDeletes).not.toContain("prod-billing-ledger");
      expect(stdout).toContain("deleted 0 orphaned DynamoDB table(s)");
    });

    it("should match the prefix case-insensitively, as table names are not normalized", () => {
      const { ddbDeletes } = run({ dynamoTables: ["TenkaCloud-Lite-Events"] });
      expect(ddbDeletes).toContain("TenkaCloud-Lite-Events");
    });

    it("should collect a real delete failure and exit non-zero rather than report success", () => {
      // 失敗を握り潰すと 「掃除した」 と言いながら課金が残る。 #2934 と同じ轍を踏まない。
      const { status, stdout } = run({
        dynamoTables: ["tenkacloud-problem-deploy-Events123"],
        dynamoDeleteFailures: ["tenkacloud-problem-deploy-Events123"],
      });
      expect(status).not.toBe(0);
      expect(stdout).toContain("cleanup INCOMPLETE");
      expect(stdout).toContain("dynamodb delete-table tenkacloud-problem-deploy-Events123");
    });

    it("should treat an already-deleted table as success, so re-runs stay idempotent", () => {
      // delete-table が失敗しても describe-table で見えなければ 「既に消えている」。
      const { status, stdout } = run({ dynamoTables: ["tenkacloud-gone-Events"] });
      expect(status).toBe(0);
      expect(stdout).not.toContain("cleanup INCOMPLETE");
    });
  });

  // 7. [#2960] destroy 後に log group が 48 個残り、 うち 29 個が無期限保持だった。 旧実装の
  //    sweep はハードコード 1 件しか見ておらず、 48 個はどれも一致しないので素通りしていた。
  //    `/aws/lambda/*` は Lambda サービスが暗黙に作るので CFn の所有物ではなく、 stack を
  //    消しても消えない = 掃除する主体がここ以外に居ない。
  describe("orphaned CloudWatch log groups (#2960)", () => {
    it("should delete the lambda log groups CloudFormation never owned", () => {
      const { lgDeletes, stdout } = run({
        logGroups: [
          "/aws/lambda/tenkacloud-control-plane-AWS679f53fac002430cb0da5b-abc",
          "/aws/lambda/tenkacloud-problem-deploy-DeployApi-def",
        ],
      });
      expect(lgDeletes).toContain(
        "/aws/lambda/tenkacloud-control-plane-AWS679f53fac002430cb0da5b-abc",
      );
      expect(lgDeletes).toContain("/aws/lambda/tenkacloud-problem-deploy-DeployApi-def");
      expect(stdout).toContain("deleted 2 orphaned log group(s)");
    });

    it("should delete the CDK-authored tenkacloud- log groups", () => {
      const { lgDeletes } = run({
        logGroups: ["tenkacloud-problem-deploy-DeployCreateLogGroup123"],
      });
      expect(lgDeletes).toContain("tenkacloud-problem-deploy-DeployCreateLogGroup123");
    });

    it("should delete the SBT CodeBuild log groups", () => {
      const { lgDeletes } = run({
        logGroups: [
          "/aws/codebuild/provisioningJobRunnercodebuildProject-xyz",
          "/aws/codebuild/deprovisioningJobRunnercode-uvw",
          "/aws/codebuild/CdkCodeBuildProjectABC",
        ],
      });
      expect(lgDeletes).toContain("/aws/codebuild/provisioningJobRunnercodebuildProject-xyz");
      expect(lgDeletes).toContain("/aws/codebuild/deprovisioningJobRunnercode-uvw");
      expect(lgDeletes).toContain("/aws/codebuild/CdkCodeBuildProjectABC");
    });

    it("should never touch a log group belonging to something else", () => {
      // 誤爆はコスト超過より取り返しがつかない。 アカウント共通のものや他プロジェクトの
      // Lambda log group を巻き込まないことを直接見る。
      const { lgDeletes, stdout } = run({
        logGroups: [
          "/aws/apigateway/welcome",
          "/aws/lambda/some-other-project-handler",
          "other-service-logs",
        ],
      });
      expect(lgDeletes).toBe("");
      expect(stdout).toContain("deleted 0 orphaned log group(s)");
    });

    it("should collect a real delete failure and exit non-zero", () => {
      const { status, stdout } = run({
        logGroups: ["/aws/lambda/tenkacloud-problem-deploy-DeployApi-def"],
        logGroupDeleteFailures: ["/aws/lambda/tenkacloud-problem-deploy-DeployApi-def"],
      });
      expect(status).not.toBe(0);
      expect(stdout).toContain("cleanup INCOMPLETE");
      expect(stdout).toContain(
        "logs delete-log-group /aws/lambda/tenkacloud-problem-deploy-DeployApi-def",
      );
    });
  });
});
