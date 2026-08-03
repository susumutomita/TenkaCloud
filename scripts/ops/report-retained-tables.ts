#!/usr/bin/env bun
/**
 * Issue #2444: destroy 後に残存する RETAIN された DynamoDB テーブルを列挙して billing 警告を
 * 出すだけの CLI entry。
 *
 * `make destroy` (tenkacloud-lite down) は `scripts/lib/retained-tables.ts` の
 * `reportRetainedTables` を CLI runner の spawnCapture 経由で直接呼ぶが、 `make destroy-saas`
 * (cleanup.sh, bash) はプロセスを跨げないので、 この entry を `bun run` して同じ警告ロジックを
 * 共有する。
 *
 * 削除は一切しない (RETAIN は意図的なので誤削除防止)。 exit code は常に 0 — cleanup.sh の
 * `set -eo pipefail` や冪等性 / exit code を壊さないため (list 失敗は警告に留める)。
 *
 * ロジックは全て pure module 側にあり単体テスト済み。 本 file は aws CLI を spawn する
 * 実 IO seam の配線のみ (= scripts/capacity-model.ts と同じ「lib=logic / CLI=IO」分割)。
 */

import { spawn } from "node:child_process";
import { type AwsResult, reportRetainedTables } from "../lib/retained-tables";

function defaultAwsRunner(args: readonly string[]): Promise<AwsResult> {
  return new Promise((resolveFn) => {
    // The AWS CLI has no fixed install path (brew / apt / pip / asdf all differ), so PATH
    // resolution is the only portable option for an operator-run reporting script.
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- operator-run tooling
    const proc = spawn("aws", [...args]);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("close", (code) => resolveFn({ code: code ?? 0, stdout, stderr }));
    proc.on("error", () => resolveFn({ code: 127, stdout, stderr }));
  });
}

await reportRetainedTables(defaultAwsRunner, (text) => process.stdout.write(text));
process.exit(0);
