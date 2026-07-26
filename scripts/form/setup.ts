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
 * ここで完結する。 純ロジックと検証は setup-core.ts にあり、 この本体は
 * 外部コマンドの実行と対話だけを持つ。
 *
 * 何度実行しても壊れない (既存の scriptId は再利用し、 secrets は上書き)。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  BOOTSTRAP_FUNCTION,
  buildSecretPlan,
  editorUrl,
  parseArgs,
  parseBootstrapPayload,
  parseDeploymentId,
  parseScriptId,
  readScriptId,
  type SetupOptions,
  webAppUrl,
} from "./setup-core";

const repoRoot = join(import.meta.dir, "../..");
const formDir = join(repoRoot, "form");
const claspJsonPath = join(formDir, ".clasp.json");
const clasprcPath = join(homedir(), ".clasprc.json");
const WORKFLOW = "form-sync.yml";
const SYNC_ENABLED_VARIABLE = "FORM_SYNC_ENABLED";

function step(message: string): void {
  process.stdout.write(`\n▶ ${message}\n`);
}

function note(message: string): void {
  process.stdout.write(`  ${message}\n`);
}

interface RunOptions {
  cwd?: string;
  /** 標準入力へ流す値。 secrets を argv に置かないために使う (ps から見える)。 */
  input?: string;
  /** 出力を捨てて成否だけ見る。 */
  quiet?: boolean;
}

/** 外部コマンドを実行し、 失敗したらその場で落とす。 握りつぶさない。 */
function run(command: string, args: readonly string[], options: RunOptions = {}): string {
  const result = spawnSync(command, args as string[], {
    cwd: options.cwd ?? repoRoot,
    input: options.input,
    encoding: "utf8",
    stdio: options.input === undefined ? ["inherit", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
  });
  if (result.error) {
    throw new Error(`${command} を実行できません: ${result.error.message}`);
  }
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (!options.quiet && stdout.trim().length > 0) {
    process.stdout.write(`${stdout.trimEnd()}\n`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} が失敗しました (exit ${result.status})\n${stderr}`,
    );
  }
  return stdout;
}

/** 成否だけを見る。 「まだ無い」 を例外にしないための入口。 */
function succeeds(command: string, args: readonly string[]): boolean {
  const result = spawnSync(command, args as string[], { cwd: repoRoot, encoding: "utf8" });
  return !result.error && result.status === 0;
}

function requireCommand(command: string, install: string): void {
  if (!succeeds("which", [command])) {
    throw new Error(`${command} が見つかりません。 ${install}`);
  }
}

function repoArgs(options: SetupOptions): string[] {
  return options.repo ? ["--repo", options.repo] : [];
}

function preflight(options: SetupOptions): void {
  step("前提コマンドを確認する");
  requireCommand("clasp", "npm install -g --ignore-scripts @google/clasp@2.5.0 で入れてください");
  requireCommand("gh", "https://cli.github.com/ から入れてください");
  if (!succeeds("gh", ["auth", "status"])) {
    throw new Error("gh が未認証です。 gh auth login を先に実行してください");
  }
  // gh がリポジトリを解決できるかを、 secrets を書く前に確かめる。
  run("gh", ["repo", "view", "--json", "nameWithOwner", ...repoArgs(options)], { quiet: true });
  note("clasp / gh とも準備できています");
}

function ensureClaspLogin(): string {
  step("clasp の認証を確認する");
  if (!existsSync(clasprcPath)) {
    note("~/.clasprc.json がありません。 ブラウザで Google の認可を行います");
    // clasp login は対話。 stdio を継承したまま待つ。
    run("clasp", ["login"]);
  }
  const clasprcJson = readFileSync(clasprcPath, "utf8");
  if (clasprcJson.trim().length === 0) {
    throw new Error("~/.clasprc.json が空です。 clasp login をやり直してください");
  }
  note("認証済みです");
  return clasprcJson;
}

function ensureScriptProject(): string {
  step("Apps Script プロジェクトを用意する");
  const existing = readScriptId(
    existsSync(claspJsonPath) ? readFileSync(claspJsonPath, "utf8") : null,
  );
  if (existing) {
    note(`既存のプロジェクトを使います: ${existing}`);
    return existing;
  }
  note("新しい standalone プロジェクトを作ります");
  const stdout = run(
    "clasp",
    ["create", "--type", "standalone", "--title", "TenkaCloud form-sync"],
    {
      cwd: formDir,
    },
  );
  const scriptId = parseScriptId(stdout);
  note(`作成しました: ${scriptId}`);
  return scriptId;
}

function pushAndDeploy(): string {
  step("sync.gs を push して Web アプリをデプロイする");
  run("clasp", ["push", "-f"], { cwd: formDir });
  const stdout = run("clasp", ["deploy", "-d", "form-setup"], { cwd: formDir });
  const url = webAppUrl(parseDeploymentId(stdout));
  note(`Web アプリ: ${url}`);
  return url;
}

async function readBootstrapPayload(scriptId: string) {
  step(`Apps Script エディタで ${BOOTSTRAP_FUNCTION} を 1 回実行する`);
  note("フォーム本体・回答スプレッドシート・同期トークンは、 この 1 回で作られます。");
  note("Google の認可が要るため、 ここだけは自動化できません。");
  note("");
  note(`  1. ${editorUrl(scriptId)} を開く`);
  note(`  2. 関数の一覧から ${BOOTSTRAP_FUNCTION} を選んで実行し、 求められたら承認する`);
  note("  3. 実行ログに出る JSON を丸ごとコピーする");
  note("");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const pasted = await rl.question("実行ログの JSON を貼り付けて Enter: ");
    return parseBootstrapPayload(pasted);
  } finally {
    rl.close();
  }
}

function writeSecrets(
  options: SetupOptions,
  values: { clasprcJson: string; scriptId: string; webAppUrl: string; syncToken: string },
): void {
  step(`GitHub Environment "${options.environment}" に secrets を書く`);
  // Environment が無いと gh secret set --env が落ちる。 先に冪等に作る。
  const repo = run(
    "gh",
    ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner", ...repoArgs(options)],
    {
      quiet: true,
    },
  ).trim();
  run("gh", ["api", "-X", "PUT", `repos/${repo}/environments/${options.environment}`], {
    quiet: true,
  });

  for (const entry of buildSecretPlan(values)) {
    // 値は stdin で渡す。 argv に置くと ps や shell 履歴から読めてしまう。
    run("gh", ["secret", "set", entry.name, "--env", options.environment, ...repoArgs(options)], {
      input: entry.value,
      quiet: true,
    });
    note(`${entry.name} を設定しました`);
  }
}

function enablePushSync(options: SetupOptions): void {
  step(`リポジトリ変数 ${SYNC_ENABLED_VARIABLE} を有効にする`);
  run("gh", ["variable", "set", SYNC_ENABLED_VARIABLE, "--body", "true", ...repoArgs(options)], {
    quiet: true,
  });
  note("form/ への push で dry run が走るようになりました");
}

function startDryRun(options: SetupOptions): void {
  step("初回の dry run を起動する");
  run("gh", ["workflow", "run", WORKFLOW, "-f", "dry_run=true", ...repoArgs(options)], {
    quiet: true,
  });
  note("フォームは変更されません。 計画はジョブサマリーに出ます");
  note(`確認: gh run list --workflow ${WORKFLOW}`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  preflight(options);
  const clasprcJson = ensureClaspLogin();
  const scriptId = ensureScriptProject();
  const url = pushAndDeploy();
  const payload = await readBootstrapPayload(scriptId);

  writeSecrets(options, {
    clasprcJson,
    scriptId,
    webAppUrl: url,
    syncToken: payload.syncToken,
  });
  enablePushSync(options);
  if (options.skipWorkflow) {
    note("--skip-workflow のため dry run は起動しません");
  } else {
    startDryRun(options);
  }

  process.stdout.write("\n完了しました。 次の手順:\n");
  process.stdout.write(`  1. dry run のジョブサマリーで計画と blocker を確認する\n`);
  process.stdout.write(
    `  2. 問題なければ gh workflow run ${WORKFLOW} -f dry_run=false で本番同期する\n`,
  );
  process.stdout.write("  3. 生成される entry マップの PR を確認してマージする\n");
  process.stdout.write(`\nフォーム: ${payload.formResponseUrl}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
