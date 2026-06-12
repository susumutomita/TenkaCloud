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
 * deploy-battles.sh / battles-common.sh — failed-stack recovery before redeploy.
 *
 * A first deploy that fails during CREATE (e.g. the Aurora free-plan error) leaves
 * the stack in ROLLBACK_COMPLETE. `aws cloudformation deploy` cannot update such a
 * stack, so "失敗分を再実行" would abort before issuing any CloudFormation operation
 * — the operator sees a deploy that is accepted but never reaches CloudFormation.
 * `delete_unrecoverable_stack_if_present` deletes the un-updatable stack first so
 * the retry re-creates it. This pins which StackStatus values trigger that delete.
 */

const COMMON_SCRIPT = resolve(__dirname, "..", "..", "..", "scripts", "lib", "battles-common.sh");
const tempDirs: string[] = [];

/** Run delete_unrecoverable_stack_if_present with a fake `aws` that reports `status`. */
function runRecovery(status: string): { stderr: string; awsCalls: string } {
  const dir = mkdtempSync(join(tmpdir(), "tenkacloud-stack-recovery-"));
  tempDirs.push(dir);
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const callLog = join(dir, "aws-calls.log");
  // Fake aws + driver are CONSTANT scripts: the absolute paths and the status flow
  // only through the child env (read as "$VAR"), so no untrusted value is spliced
  // into a shell command string (keeps CodeQL's shell-injection scan happy).
  // `describe-stacks` prints FAKE_STACK_STATUS (empty => exit non-zero = stack
  // absent); delete-stack / wait are appended to AWS_CALL_LOG for assertions.
  const fakeAws = `#!/usr/bin/env bash
echo "$@" >> "$AWS_CALL_LOG"
if [ "$1" = "cloudformation" ] && [ "$2" = "describe-stacks" ]; then
  if [ -z "$FAKE_STACK_STATUS" ]; then exit 254; fi
  echo "$FAKE_STACK_STATUS"
  exit 0
fi
exit 0
`;
  writeFileSync(join(binDir, "aws"), fakeAws, { mode: 0o755 });
  chmodSync(join(binDir, "aws"), 0o755);

  const driver = `set -euo pipefail
source "$BATTLES_COMMON"
delete_unrecoverable_stack_if_present "tc-demo-team" "us-east-1"
`;
  const result = spawnSync("bash", ["-c", driver], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      BATTLES_COMMON: COMMON_SCRIPT,
      AWS_CALL_LOG: callLog,
      FAKE_STACK_STATUS: status,
    },
  });
  expect(result.status, result.stderr).toBe(0);
  return {
    stderr: result.stderr,
    awsCalls: existsSync(callLog) ? readFileSync(callLog, "utf8") : "",
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

// bash + fake aws を spawn する実 I/O テスト。全 suite 並列時は fork 飽和で default 5s を
// 超え flake するため、明示 timeout を持つ (package-source-bundle と同型)。
describe("delete_unrecoverable_stack_if_present", { timeout: 30_000 }, () => {
  for (const status of [
    "ROLLBACK_COMPLETE",
    "ROLLBACK_FAILED",
    "CREATE_FAILED",
    "DELETE_FAILED",
    "REVIEW_IN_PROGRESS",
  ]) {
    it(`should delete the stack before redeploy when status is ${status}`, () => {
      const { awsCalls } = runRecovery(status);
      expect(awsCalls).toContain("cloudformation delete-stack");
      expect(awsCalls).toContain("cloudformation wait stack-delete-complete");
    });
  }

  for (const status of ["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"]) {
    it(`should leave a healthy stack untouched when status is ${status}`, () => {
      const { awsCalls } = runRecovery(status);
      expect(awsCalls).toContain("cloudformation describe-stacks");
      expect(awsCalls).not.toContain("delete-stack");
    });
  }

  it("should do nothing when the stack does not exist", () => {
    const { awsCalls } = runRecovery("");
    expect(awsCalls).not.toContain("delete-stack");
  });
});
