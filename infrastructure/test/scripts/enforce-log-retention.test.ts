import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * `scripts/enforce-log-retention.sh` (#2960).
 *
 * The measurement that produced this script: after `make destroy-saas`, 48 log groups
 * survived and **29 of them had no retention**, so their storage bill runs forever. Most
 * call sites are fixed at construction; two CDK-internal provider paths cannot be, and
 * this script is the backstop for those.
 *
 * A backstop that silently does nothing is worse than none — the number it reports is
 * what somebody will read instead of checking. So the tests here pin both directions:
 * it sets retention where retention is missing, and it does not touch anything that
 * isn't ours or that already has a policy.
 *
 * `aws` is faked on PATH; the script itself is never modified. Scenario data flows
 * through the child environment rather than being interpolated into a command string.
 */

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const SCRIPT = resolve(REPO_ROOT, "scripts", "enforce-log-retention.sh");
const tempDirs: string[] = [];

interface Scenario {
  /** Log groups the fake `aws logs describe-log-groups` reports as having no retention. */
  readonly withoutRetention?: readonly string[];
  /** Names whose `put-retention-policy` fails. */
  readonly putFailures?: readonly string[];
  readonly retentionDays?: string;
  readonly dryRun?: boolean;
}

interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly awsCalls: string;
}

function run(scenario: Scenario): RunResult {
  const dir = mkdtempSync(join(tmpdir(), "tenkacloud-retention-"));
  tempDirs.push(dir);
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const callLog = join(dir, "aws-calls.log");
  writeFileSync(callLog, "");

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

case "$1 $2" in
  "logs describe-log-groups")
    prefix="$(find_flag_value --log-group-name-prefix "$@")"
    for name in \${FAKE_WITHOUT_RETENTION}; do
      case "$name" in
        "$prefix"*) printf '%s\\n' "$name" ;;
      esac
    done
    exit 0
    ;;
  "logs put-retention-policy")
    name="$(find_flag_value --log-group-name "$@")"
    for failing in \${FAKE_PUT_FAILURES}; do
      [ "$failing" = "$name" ] && exit 255
    done
    exit 0
    ;;
esac
exit 0
`;
  const awsPath = join(binDir, "aws");
  writeFileSync(awsPath, fakeAws);
  chmodSync(awsPath, 0o755);

  // `.env` は読ませない (ENV_FILE を存在しない path に向ける)。 retention の値は環境変数から
  // 渡し、 リポジトリの実 `.env` に結果が左右されないようにする。
  const result = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      ENV_FILE: join(dir, "no-such.env"),
      AWS_CALL_LOG: callLog,
      FAKE_WITHOUT_RETENTION: (scenario.withoutRetention ?? []).join(" "),
      FAKE_PUT_FAILURES: (scenario.putFailures ?? []).join(" "),
      CDK_PARAM_LOG_RETENTION_DAYS: scenario.retentionDays ?? "1",
      DRY_RUN: scenario.dryRun ? "1" : "0",
    },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    awsCalls: readFileSync(callLog, "utf8"),
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("enforce-log-retention.sh", () => {
  it("sets retention on a tenkacloud Lambda log group that has none", () => {
    const result = run({ withoutRetention: ["/aws/lambda/tenkacloud-control-plane-Custom-abc"] });
    expect(result.status).toBe(0);
    expect(result.awsCalls).toContain("put-retention-policy");
    expect(result.awsCalls).toContain("/aws/lambda/tenkacloud-control-plane-Custom-abc");
    expect(result.stdout).toContain("retention applied to 1 log group");
  });

  it("covers the CDK-internal provider paths the constructs give no prop for", () => {
    // この 2 つが、 構築側から塞げないと分かっている経路そのもの。 ここが漏れると
    // backstop の意味が無い。
    const result = run({
      withoutRetention: [
        "/aws/lambda/tenkacloud-lite-CustomS3AutoDeleteObjects-x",
        "/aws/lambda/tenkacloud-control-plane-CustomAWSCDKOpenIdConnec-y",
      ],
    });
    expect(result.stdout).toContain("retention applied to 2 log group");
  });

  it("covers the SBT CodeBuild groups, whose names carry no tenkacloud", () => {
    const result = run({
      withoutRetention: ["/aws/codebuild/provisioningJobRunnercodebu-zzz"],
    });
    expect(result.stdout).toContain("retention applied to 1 log group");
  });

  it("does not touch a log group that is not ours", () => {
    // 別プロジェクトの retention を黙って縮めると、 気付くのはログが必要になって
    // 消えていたときになる。 prefix だけでなく名前でも確認する。
    const result = run({
      withoutRetention: ["tenkacloud-keep", "/aws/lambda/tenkacloud-mine", "tenkacloud-"],
    });
    const puts = result.awsCalls
      .split("\n")
      .filter((line) => line.startsWith("logs put-retention-policy"));
    for (const line of puts) expect(line.toLowerCase()).toContain("tenkacloud");
  });

  it("asks for nothing when every group already has a retention", () => {
    // describe は `retentionInDays == null` だけを返す query なので、 設定済みのものは
    // そもそも列挙されない。 put が 1 度も呼ばれないことを固定する。
    const result = run({ withoutRetention: [] });
    expect(result.status).toBe(0);
    expect(result.awsCalls).not.toContain("put-retention-policy");
    expect(result.stdout).toContain("retention applied to 0 log group");
  });

  it("queries only groups whose retention is null", () => {
    const result = run({ withoutRetention: ["/aws/lambda/tenkacloud-x"] });
    expect(result.awsCalls).toContain("retentionInDays==`null`");
  });

  it("uses the retention the param names, not a hardcoded number", () => {
    const result = run({ withoutRetention: ["/aws/lambda/tenkacloud-x"], retentionDays: "7" });
    expect(result.awsCalls).toContain("--retention-in-days 7");
  });

  it("refuses a retention CloudWatch does not accept, before touching anything", () => {
    // 2 日は CloudWatch の受け付ける値に無い。 put が全件失敗してから気付くのでは遅い。
    const result = run({ withoutRetention: ["/aws/lambda/tenkacloud-x"], retentionDays: "2" });
    expect(result.status).toBe(2);
    expect(result.awsCalls).not.toContain("put-retention-policy");
    expect(result.stderr).toContain("not a retention CloudWatch accepts");
  });

  it("fails loudly when a put fails, naming what is still unset", () => {
    // 握り潰すと、 残った 1 件が無期限保持のまま課金され続ける。
    const result = run({
      withoutRetention: ["/aws/lambda/tenkacloud-ok", "/aws/lambda/tenkacloud-bad"],
      putFailures: ["/aws/lambda/tenkacloud-bad"],
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("/aws/lambda/tenkacloud-bad");
    expect(result.stderr).not.toContain("/aws/lambda/tenkacloud-ok");
  });

  it("changes nothing under DRY_RUN, and says what it would have changed", () => {
    const result = run({ withoutRetention: ["/aws/lambda/tenkacloud-x"], dryRun: true });
    expect(result.status).toBe(0);
    expect(result.awsCalls).not.toContain("put-retention-policy");
    expect(result.stdout).toContain("would set retention");
  });
});
