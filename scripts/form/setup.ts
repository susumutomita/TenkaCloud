#!/usr/bin/env bun
/**
 * Google フォーム側の準備を一気に通す CLI (`make form-setup`)。
 *
 * これまで form/README.md の手順書だった作業のうち、 機械にできるものを全部
 * 引き受ける。 残る人手は 2 つだけで、 どちらも Google の認可が要るため
 * 自動化できない。
 *
 *   1. `clasp login` のブラウザ認可
 *   2. Apps Script エディタで `bootstrap` を 1 回実行し、 ログの JSON を貼る
 *
 * それ以外 (Apps Script プロジェクトの作成、 push、 Web アプリのデプロイ、
 * GitHub Environment と secrets、 リポジトリ変数、 初回 dry run の起動) は
 * ここで完結する。
 *
 * この入口は実物の `SetupIo` を組み立てるだけ。 手順は setup-run.ts、 検証と
 * 解析は setup-core.ts にあり、 どちらもテストから直接呼べる。
 *
 * 何度実行しても壊れない (既存の scriptId は再利用し、 secrets は上書き)。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "./setup-core";
import { runSetup, type SetupIo } from "./setup-run";

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const io: SetupIo = {
    repoRoot: join(import.meta.dir, "../.."),
    homeDir: homedir(),
    env: process.env,
    prompt: (question) => rl.question(question),
    write: (text) => {
      process.stdout.write(text);
    },
  };
  try {
    await runSetup(options, io);
  } finally {
    rl.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
