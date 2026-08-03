/**
 * `form-setup` の手順そのもの。
 *
 * プロセス実行とファイル読み書きという外界は `SetupIo` にまとめ、 実行の順序と
 * 判断だけをここに置く。 この CLI は GitHub の secrets を書き、 リポジトリ変数を
 * 変え、 workflow を起動する。 順序を 1 つ取り違えても人間には気づきにくく、
 * 気づいたときには権限のある資源が書き換わっている。 だからテストから同じ関数を
 * 呼べる形にしてある。
 *
 * `setup.ts` は実物の `SetupIo` を作ってここへ渡すだけの薄い入口。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BOOTSTRAP_FUNCTION,
  buildSecretPlan,
  editorUrl,
  parseBootstrapPayload,
  parseDeploymentId,
  parseScriptId,
  readScriptId,
  type SetupOptions,
  webAppUrl,
} from "./setup-core";

/** `form-sync` workflow のファイル名。 */
const WORKFLOW = "form-sync.yml";

/** push 実行を解禁するリポジトリ変数。 */
const SYNC_ENABLED_VARIABLE = "FORM_SYNC_ENABLED";

/** Apps Script プロジェクトの表示名。 */
const PROJECT_TITLE = "TenkaCloud form-sync";

/**
 * 外界との境界。
 *
 * テストは実物の実装のまま、 `repoRoot` / `homeDir` を一時ディレクトリに、
 * `env.PATH` を実行可能なスタブコマンドの置き場に向けて使う。 差し替えるのは
 * 「どこを見るか」 だけで、 プロセス起動もファイル読み込みも本番と同じ経路を通る。
 */
export interface SetupIo {
  repoRoot: string;
  homeDir: string;
  env: NodeJS.ProcessEnv;
  /** 操作者への問い合わせ。 貼り付けられた文字列を返す。 */
  prompt(question: string): Promise<string>;
  /** 進捗表示の出力先。 */
  write(text: string): void;
}

interface RunOptions {
  cwd?: string;
  /** 標準入力へ流す値。 secrets を argv に置かないために使う (ps から見える)。 */
  input?: string;
  /** 出力を表示せず、 戻り値としてだけ使う。 */
  quiet?: boolean;
  /** 端末に直結する。 対話するコマンド専用。 */
  interactive?: boolean;
}

/** 大きな区切りの見出しを出す。 */
function step(io: SetupIo, message: string): void {
  io.write(`\n▶ ${message}\n`);
}

/** 見出しにぶら下がる補足を出す。 */
function note(io: SetupIo, message: string): void {
  io.write(`  ${message}\n`);
}

/**
 * 非 interactive 時の stdio。 stdout/stderr は常に pipe。 stdin は `input` を渡すときだけ
 * pipe にし、 渡さないなら継承したままにして子側の TTY 検出を壊さない。
 */
function pipedStdio(hasInput: boolean): ["inherit" | "pipe", "pipe", "pipe"] {
  return [hasInput ? "pipe" : "inherit", "pipe", "pipe"];
}

/**
 * 外部コマンドを実行し、 失敗したらその場で落とす。 握りつぶさない。
 *
 * `interactive` のときだけ stdio を丸ごと継承する。 `clasp login` は認可 URL を
 * 表示してから入力を待つため、 stdout を pipe すると URL が終了まで出てこず、
 * 操作者にはハングとしか見えない。
 */
function run(
  io: SetupIo,
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): string {
  const result = spawnSync(command, args as string[], {
    cwd: options.cwd ?? io.repoRoot,
    env: io.env,
    input: options.input,
    encoding: "utf8",
    stdio: options.interactive ? "inherit" : pipedStdio(options.input !== undefined),
  });
  if (result.error) {
    throw new Error(`${command} を実行できません: ${result.error.message}`);
  }
  const stdout = result.stdout ?? "";
  if (!options.quiet && !options.interactive && stdout.trim().length > 0) {
    io.write(`${stdout.trimEnd()}\n`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} が失敗しました (exit ${result.status})\n${result.stderr ?? ""}`,
    );
  }
  return stdout;
}

/** 成否だけを見る。 「まだ無い」 を例外にしないための入口。 */
function succeeds(io: SetupIo, command: string, args: readonly string[]): boolean {
  const result = spawnSync(command, args as string[], {
    cwd: io.repoRoot,
    env: io.env,
    encoding: "utf8",
  });
  return !result.error && result.status === 0;
}

/** 必要な外部コマンドの存在を、 何かを書き換える前に確かめる。 */
function requireCommand(io: SetupIo, command: string, install: string): void {
  if (!succeeds(io, command, ["--version"])) {
    throw new Error(`${command} が見つかりません。 ${install}`);
  }
}

/** `--repo` が指定されていれば gh へ転送する。 無ければ gh の解決に任せる。 */
function repoArgs(options: SetupOptions): string[] {
  return options.repo ? ["--repo", options.repo] : [];
}

/**
 * 前提を確かめ、 対象リポジトリの `owner/name` を返す。
 *
 * secrets を書き始めてから 「gh が未認証だった」 と分かると、 途中まで書かれた
 * Environment が残る。 だから書き込みの前に全部確かめる。
 */
function preflight(io: SetupIo, options: SetupOptions): string {
  step(io, "前提コマンドを確認する");
  requireCommand(
    io,
    "clasp",
    "npm install -g --ignore-scripts @google/clasp@2.5.0 で入れてください",
  );
  requireCommand(io, "gh", "https://cli.github.com/ から入れてください");
  if (!succeeds(io, "gh", ["auth", "status"])) {
    throw new Error("gh が未認証です。 gh auth login を先に実行してください");
  }
  const repo = run(
    io,
    "gh",
    ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner", ...repoArgs(options)],
    { quiet: true },
  ).trim();
  if (repo.length === 0) {
    throw new Error("gh が対象リポジトリを解決できません。 --repo owner/name を指定してください");
  }
  note(io, `対象リポジトリ: ${repo}`);
  return repo;
}

/** `~/.clasprc.json` を用意し、 その中身を返す。 secrets の 1 つになる。 */
function ensureClaspLogin(io: SetupIo): string {
  step(io, "clasp の認証を確認する");
  const clasprcPath = join(io.homeDir, ".clasprc.json");
  if (!existsSync(clasprcPath)) {
    note(io, "~/.clasprc.json がありません。 ブラウザで Google の認可を行います");
    run(io, "clasp", ["login"], { interactive: true });
  }
  if (!existsSync(clasprcPath)) {
    throw new Error("clasp login のあとも ~/.clasprc.json がありません");
  }
  const clasprcJson = readFileSync(clasprcPath, "utf8");
  if (clasprcJson.trim().length === 0) {
    throw new Error("~/.clasprc.json が空です。 clasp login をやり直してください");
  }
  note(io, "認証済みです");
  return clasprcJson;
}

/** Apps Script プロジェクトを用意する。 既にあれば作らずに再利用する。 */
function ensureScriptProject(io: SetupIo, formDir: string): string {
  step(io, "Apps Script プロジェクトを用意する");
  const claspJsonPath = join(formDir, ".clasp.json");
  const existing = readScriptId(
    existsSync(claspJsonPath) ? readFileSync(claspJsonPath, "utf8") : null,
  );
  if (existing) {
    note(io, `既存のプロジェクトを使います: ${existing}`);
    return existing;
  }
  note(io, "新しい standalone プロジェクトを作ります");
  const stdout = run(io, "clasp", ["create", "--type", "standalone", "--title", PROJECT_TITLE], {
    cwd: formDir,
  });
  const scriptId = parseScriptId(stdout);
  note(io, `作成しました: ${scriptId}`);
  return scriptId;
}

/** sync.gs を push し、 Web アプリをデプロイして `exec` URL を返す。 */
function pushAndDeploy(io: SetupIo, formDir: string): string {
  step(io, "sync.gs を push して Web アプリをデプロイする");
  run(io, "clasp", ["push", "-f"], { cwd: formDir });
  const stdout = run(io, "clasp", ["deploy", "-d", "form-setup"], { cwd: formDir });
  const url = webAppUrl(parseDeploymentId(stdout));
  note(io, `Web アプリ: ${url}`);
  return url;
}

/** 操作者に `bootstrap` を実行してもらい、 その出力を受け取って検証する。 */
async function readBootstrapPayload(io: SetupIo, scriptId: string) {
  step(io, `Apps Script エディタで ${BOOTSTRAP_FUNCTION} を 1 回実行する`);
  note(io, "フォーム本体・回答スプレッドシート・同期トークンは、 この 1 回で作られます。");
  note(io, "Google の認可が要るため、 ここだけは自動化できません。");
  note(io, "");
  note(io, `  1. ${editorUrl(scriptId)} を開く`);
  note(io, `  2. 関数の一覧から ${BOOTSTRAP_FUNCTION} を選んで実行し、 求められたら承認する`);
  note(io, "  3. 実行ログに出る JSON を丸ごとコピーする");
  note(io, "");
  return parseBootstrapPayload(await io.prompt("実行ログの JSON を貼り付けて Enter: "));
}

/** GitHub Environment を作り、 workflow が読む 4 つの secrets を書く。 */
function writeSecrets(
  io: SetupIo,
  options: SetupOptions,
  repo: string,
  values: { clasprcJson: string; scriptId: string; webAppUrl: string; syncToken: string },
): void {
  step(io, `GitHub Environment "${options.environment}" に secrets を書く`);
  // Environment が無いと gh secret set --env が落ちる。 先に冪等に作る。
  run(io, "gh", ["api", "-X", "PUT", `repos/${repo}/environments/${options.environment}`], {
    quiet: true,
  });

  for (const entry of buildSecretPlan(values)) {
    // 値は stdin で渡す。 argv に置くと ps や shell 履歴から読めてしまう。
    run(
      io,
      "gh",
      ["secret", "set", entry.name, "--env", options.environment, ...repoArgs(options)],
      {
        input: entry.value,
        quiet: true,
      },
    );
    note(io, `${entry.name} を設定しました`);
  }
}

/** `form/` への push で dry run が走るようにする。 */
function enablePushSync(io: SetupIo, options: SetupOptions): void {
  step(io, `リポジトリ変数 ${SYNC_ENABLED_VARIABLE} を有効にする`);
  run(
    io,
    "gh",
    ["variable", "set", SYNC_ENABLED_VARIABLE, "--body", "true", ...repoArgs(options)],
    {
      quiet: true,
    },
  );
  note(io, "form/ への push で dry run が走るようになりました");
}

/** 初回の dry run を起動する。 フォームは変更されない。 */
function startDryRun(io: SetupIo, options: SetupOptions): void {
  step(io, "初回の dry run を起動する");
  run(io, "gh", ["workflow", "run", WORKFLOW, "-f", "dry_run=true", ...repoArgs(options)], {
    quiet: true,
  });
  note(io, "フォームは変更されません。 計画はジョブサマリーに出ます");
  note(io, `確認: gh run list --workflow ${WORKFLOW}`);
}

/** 手順を順に通す。 途中で失敗したら例外がそのまま上がる。 */
export async function runSetup(options: SetupOptions, io: SetupIo): Promise<void> {
  const formDir = join(io.repoRoot, "form");

  const repo = preflight(io, options);
  const clasprcJson = ensureClaspLogin(io);
  const scriptId = ensureScriptProject(io, formDir);
  const url = pushAndDeploy(io, formDir);
  const payload = await readBootstrapPayload(io, scriptId);

  writeSecrets(io, options, repo, {
    clasprcJson,
    scriptId,
    webAppUrl: url,
    syncToken: payload.syncToken,
  });
  enablePushSync(io, options);
  if (options.skipWorkflow) {
    note(io, "--skip-workflow のため dry run は起動しません");
  } else {
    startDryRun(io, options);
  }

  io.write("\n完了しました。 次の手順:\n");
  io.write("  1. dry run のジョブサマリーで計画と blocker を確認する\n");
  io.write(`  2. 問題なければ gh workflow run ${WORKFLOW} -f dry_run=false で本番同期する\n`);
  io.write("  3. 生成される entry マップの PR を確認してマージする\n");
  io.write(`\nフォーム: ${payload.formResponseUrl}\n`);
}
