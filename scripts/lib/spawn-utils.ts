/**
 * Shared child-process spawn helpers for the TenkaCloud orchestration CLIs
 * (`scripts/tenkacloud-ops.ts`, `scripts/tenkacloud-lite.ts`).
 *
 * 両 CLI が個別に同形の spawn 抽象を持っていたのを 1 箇所に集約したもの。 mutate 系
 * (deploy / destroy / bootstrap) は出力を逐次見せたいので `spawnInherit` で stdio を継承し、
 * read 系 (aws CLI の JSON / text 取得) は出力を文字列に貯める `spawnCapture` を使う。
 *
 * これらは各 CLI が `CliIO` に注入する **default 実装** であり、 unit test では injectable な
 * seam を通じて stub に差し替える (= AWS / CDK を実行せずに subcommand dispatch を観測する)。
 */

import { spawn } from "node:child_process";

/** Captured result of a spawned process: exit code + accumulated stdout / stderr. */
export interface SpawnResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Spawn a command, capturing stdout / stderr into strings. stdin is ignored.
 * On spawn error (= binary not found etc.) resolves with code 127 so callers can
 * treat it like any other non-zero exit instead of throwing.
 */
export function spawnCapture(cmd: string, args: readonly string[]): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolveSpawn) => {
    const child = spawn(cmd, args as string[], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("close", (code: number | null) => {
      resolveSpawn({ code: code ?? 0, stdout, stderr });
    });
    child.on("error", (err: Error) => {
      resolveSpawn({ code: 127, stdout: "", stderr: err.message });
    });
  });
}

/**
 * Spawn a command with inherited stdio (= the child's output streams straight to
 * the parent terminal) and resolve with its exit code. On spawn error resolves 127.
 */
export function spawnInherit(cmd: string, args: readonly string[]): Promise<number> {
  return new Promise<number>((resolveSpawn) => {
    const child = spawn(cmd, [...args], { stdio: "inherit" });
    child.on("close", (code: number | null) => resolveSpawn(code ?? 0));
    child.on("error", () => resolveSpawn(127));
  });
}
