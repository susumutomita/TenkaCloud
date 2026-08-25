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
 * scripts/delete-battles.sh — expected-account verification (#1797).
 *
 * credentials が「stack の実在しない account」を指したまま delete-stack すると、
 * CFn は no-op 成功 / wait も成功扱いになり、DB は DELETED なのに実 stack が
 * CREATE_COMPLETE で残存する silent leak になる。`DELETE_EXPECTED_AWS_ACCOUNT_ID`
 * が渡されたとき `sts get-caller-identity` と突き合わせ、mismatch を delete-stack
 * 発行前に loud fail させることを pin する。
 */

const DELETE_SCRIPT = resolve(__dirname, "..", "..", "..", "scripts", "delete-battles.sh");
const tempDirs: string[] = [];

function runDelete(env: Record<string, string>): {
  status: number | null;
  stderr: string;
  stdout: string;
  awsCalls: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "tenkacloud-delete-battles-"));
  tempDirs.push(dir);
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const callLog = join(dir, "aws-calls.log");
  // Fake aws は CONSTANT script: 可変値は child env 経由でのみ流す (shell injection 回避)。
  // sts get-caller-identity は FAKE_CALLER_ACCOUNT を返し、それ以外 (delete-stack / wait)
  // は記録して成功する。
  // FAKE_STS_STDERR_NOISE: #3063 regression 用。setlocale 警告等、STS 呼び出しの
  // *成功時* にも stderr へ紛れ得る無関係な 1 行を注入できるようにする。fake aws が
  // bash script である以上、この注入がなければ「たまたま locale 警告が出ない環境」
  // でテストが常に通ってしまう (= 検出器として機能しない) ので、host の locale 状態に
  // 依存せず決定論的に再現する。
  const fakeAws = `#!/usr/bin/env bash
echo "$@" >> "$AWS_CALL_LOG"
if [ "$1" = "sts" ] && [ "$2" = "get-caller-identity" ]; then
  if [ -z "$FAKE_CALLER_ACCOUNT" ]; then echo "fake sts failure" >&2; exit 254; fi
  if [ -n "\${FAKE_STS_STDERR_NOISE:-}" ]; then echo "$FAKE_STS_STDERR_NOISE" >&2; fi
  echo "$FAKE_CALLER_ACCOUNT"
  exit 0
fi
exit 0
`;
  // writeFileSync の mode は umask で削られ得るので chmodSync で 0o755 を保証する。
  writeFileSync(join(binDir, "aws"), fakeAws);
  chmodSync(join(binDir, "aws"), 0o755);

  const result = spawnSync("bash", [DELETE_SCRIPT, "tc-demo-team", "ap-northeast-1"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      AWS_CALL_LOG: callLog,
      COMPETITOR_ROLE_ARN: "",
      CFN_EXEC_ROLE_ARN: "",
      ...env,
    },
  });
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

// bash + fake aws を spawn する実 I/O テスト。全 suite 並列時は fork 飽和で default 5s を
// 超え flake するため、明示 timeout を持つ (test/scripts の spawn 系と同型)。
describe("delete-battles.sh expected-account verification (#1797)", { timeout: 30_000 }, () => {
  it("should abort before delete-stack when credentials point at a different account", () => {
    const { status, stderr, awsCalls } = runDelete({
      DELETE_EXPECTED_AWS_ACCOUNT_ID: "999999999999",
      FAKE_CALLER_ACCOUNT: "111111111111",
    });
    expect(status).toBe(1);
    expect(stderr).toContain("999999999999");
    expect(stderr).toContain("111111111111");
    expect(awsCalls).toContain("sts get-caller-identity");
    expect(awsCalls).not.toContain("cloudformation delete-stack");
  });

  it("should proceed with delete-stack + wait when the accounts match", () => {
    const { status, stderr, awsCalls } = runDelete({
      DELETE_EXPECTED_AWS_ACCOUNT_ID: "999999999999",
      FAKE_CALLER_ACCOUNT: "999999999999",
    });
    expect(status, stderr).toBe(0);
    expect(awsCalls).toContain("cloudformation delete-stack");
    expect(awsCalls).toContain("cloudformation wait stack-delete-complete");
  });

  // #3063: `2>&1` で account ID の値と診断を同じ変数へ詰めていたせいで、STS 呼び出しが
  // *成功* していても stderr に紛れた無関係な 1 行 (setlocale 警告など) が account ID
  // へ混入し、一致している account を mismatch と誤判定して正しい delete を拒否していた。
  // FAKE_STS_STDERR_NOISE でその無関係な 1 行を注入し、host の locale 生成状況に関係なく
  // 決定論的に再現する。
  it("should proceed with delete-stack + wait when the accounts match even if stderr carries an unrelated warning line (#3063)", () => {
    const { status, stderr, awsCalls } = runDelete({
      DELETE_EXPECTED_AWS_ACCOUNT_ID: "999999999999",
      FAKE_CALLER_ACCOUNT: "999999999999",
      FAKE_STS_STDERR_NOISE: "bash: warning: setlocale: LC_ALL: cannot change locale (en_US.UTF-8)",
    });
    expect(status, stderr).toBe(0);
    expect(stderr).not.toContain("aborting before delete-stack");
    expect(awsCalls).toContain("cloudformation delete-stack");
    expect(awsCalls).toContain("cloudformation wait stack-delete-complete");
  });

  it("should fail loudly with a clear error when sts get-caller-identity itself fails", () => {
    const { status, stderr, awsCalls } = runDelete({
      DELETE_EXPECTED_AWS_ACCOUNT_ID: "999999999999",
      FAKE_CALLER_ACCOUNT: "",
    });
    expect(status).toBe(1);
    expect(stderr).toContain("get-caller-identity failed");
    expect(awsCalls).not.toContain("cloudformation delete-stack");
  });

  it("should skip the check for manual invocations without DELETE_EXPECTED_AWS_ACCOUNT_ID", () => {
    const { status, stderr, awsCalls } = runDelete({
      DELETE_EXPECTED_AWS_ACCOUNT_ID: "",
      FAKE_CALLER_ACCOUNT: "111111111111",
    });
    expect(status, stderr).toBe(0);
    expect(awsCalls).not.toContain("sts get-caller-identity");
    expect(awsCalls).toContain("cloudformation delete-stack");
  });
});
