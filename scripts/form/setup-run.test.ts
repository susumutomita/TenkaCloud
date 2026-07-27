/**
 * `runSetup` の統合テスト。
 *
 * この CLI は GitHub の secrets を書き、 リポジトリ変数を変え、 workflow を
 * 起動する。 手順を 1 つ取り違えても人間には気づきにくいので、 順序と分岐を
 * 実際に走らせて確かめる。
 *
 * `clasp` と `gh` はモックではなく、 一時ディレクトリに置いた実行可能な
 * スタブコマンドで代替する。 `PATH` をそこへ向けるだけで、 プロセス起動も
 * ファイル読み書きも本番と同じ経路を通る。 呼ばれた引数と標準入力は
 * スタブ自身がログに書く。
 */
import { describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SetupOptions } from "./setup-core";
import { runSetup, type SetupIo } from "./setup-run";

const SCRIPT_ID = "1a-Bc_dEfGhIjKlMnOpQrStUvWxYz0123456789";
const DEPLOYMENT_ID = "AKfycbwSample_Deployment-Id0123456789";
const SYNC_TOKEN = "0123456789abcdef0123456789abcdef";
const BOOTSTRAP_JSON = JSON.stringify({
  formId: "1FAIpQLSc_form_id_that_is_long_enough_0123",
  syncToken: SYNC_TOKEN,
  formResponseUrl: "https://docs.google.com/forms/d/e/1FAIpQLScSampleFormKey123/formResponse",
  responseSpreadsheetId: "1sheet_id_0123456789",
  notifyEmails: "ops@example.com",
});

const CLASP_STUB = `#!/bin/sh
printf 'clasp %s\\n' "$*" >> "$FORM_SETUP_LOG"
case "$1" in
  --version) echo "2.5.0" ;;
  create) echo "Created new standalone script: https://script.google.com/d/${SCRIPT_ID}/edit" ;;
  push) echo "Pushed 2 files." ;;
  deploy) echo "Created version 1."; echo "- ${DEPLOYMENT_ID} @1." ;;
esac
exit 0
`;

const GH_STUB = `#!/bin/sh
printf 'gh %s\\n' "$*" >> "$FORM_SETUP_LOG"
case "$1" in
  --version) echo "gh version 2.0.0" ;;
  repo) echo "owner/name" ;;
  secret)
    piped=$(cat)
    printf 'stdin %s\\n' "$piped" >> "$FORM_SETUP_LOG"
    if [ -n "$FORM_SETUP_GH_SECRET_FAILS" ]; then
      echo "boom" >&2
      exit 1
    fi
    ;;
esac
exit 0
`;

interface Harness {
  io: SetupIo;
  /** スタブが記録した呼び出しの行。 */
  log(): string[];
  /** CLI が操作者へ表示した内容。 */
  output(): string;
}

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

/** 一時ディレクトリに repo / home / スタブコマンドを組み立てる。 */
function harness(overrides: { withClaspJson?: boolean; ghSecretFails?: boolean } = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), "form-setup-"));
  const binDir = join(root, "bin");
  const homeDir = join(root, "home");
  const repoRoot = join(root, "repo");
  const formDir = join(repoRoot, "form");
  for (const dir of [binDir, homeDir, formDir]) mkdirSync(dir, { recursive: true });

  const logPath = join(root, "calls.log");
  writeFileSync(logPath, "");
  writeExecutable(join(binDir, "clasp"), CLASP_STUB);
  writeExecutable(join(binDir, "gh"), GH_STUB);
  writeFileSync(join(homeDir, ".clasprc.json"), '{"token":{"access_token":"stub"}}');
  if (overrides.withClaspJson) {
    writeFileSync(
      join(formDir, ".clasp.json"),
      JSON.stringify({ scriptId: SCRIPT_ID, rootDir: "." }),
    );
  }

  const printed: string[] = [];
  return {
    io: {
      repoRoot,
      homeDir,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        FORM_SETUP_LOG: logPath,
        ...(overrides.ghSecretFails ? { FORM_SETUP_GH_SECRET_FAILS: "1" } : {}),
      },
      prompt: () => Promise.resolve(BOOTSTRAP_JSON),
      write: (text) => {
        printed.push(text);
      },
    },
    log: () =>
      readFileSync(logPath, "utf8")
        .split("\n")
        .filter((line) => line.length > 0),
    output: () => printed.join(""),
  };
}

const options = (over: Partial<SetupOptions> = {}): SetupOptions => ({
  repo: null,
  environment: "google-form",
  skipWorkflow: false,
  ...over,
});

describe("runSetup", () => {
  it("should create a script project when form/.clasp.json is absent", async () => {
    const { io, log } = harness();
    await runSetup(options(), io);
    expect(log().some((line) => line.startsWith("clasp create "))).toBe(true);
  });

  it("should reuse the recorded script project instead of creating a second one", async () => {
    const { io, log } = harness({ withClaspJson: true });
    await runSetup(options(), io);
    expect(log().some((line) => line.startsWith("clasp create "))).toBe(false);
    expect(log().some((line) => line.startsWith("clasp push "))).toBe(true);
  });

  it("should create the environment before writing any secret into it", async () => {
    const { io, log } = harness();
    await runSetup(options(), io);
    const lines = log();
    const created = lines.findIndex((line) =>
      line.includes("api -X PUT repos/owner/name/environments"),
    );
    const firstSecret = lines.findIndex((line) => line.startsWith("gh secret set "));
    expect(created).toBeGreaterThanOrEqual(0);
    expect(firstSecret).toBeGreaterThan(created);
  });

  it("should write exactly the four secrets the workflow reads", async () => {
    const { io, log } = harness();
    await runSetup(options(), io);
    const names = log()
      .filter((line) => line.startsWith("gh secret set "))
      .map((line) => line.split(" ")[3]);
    expect(names).toEqual(["CLASPRC_JSON", "FORM_SCRIPT_ID", "FORM_WEBAPP_URL", "FORM_SYNC_TOKEN"]);
  });

  it("should pass secret values over stdin so they never appear in argv", async () => {
    const { io, log } = harness();
    await runSetup(options(), io);
    const lines = log();
    expect(lines).toContain(`stdin ${SYNC_TOKEN}`);
    // argv 側にトークンが載っていたら ps や shell 履歴から読めてしまう。
    expect(
      lines.filter((line) => line.startsWith("gh ")).some((line) => line.includes(SYNC_TOKEN)),
    ).toBe(false);
  });

  it("should send the deployment URL built from the clasp deploy output", async () => {
    const { io, log } = harness();
    await runSetup(options(), io);
    expect(log()).toContain(`stdin https://script.google.com/macros/s/${DEPLOYMENT_ID}/exec`);
  });

  it("should enable the push-sync variable and start the dry run", async () => {
    const { io, log } = harness();
    await runSetup(options(), io);
    const lines = log();
    expect(
      lines.some((line) => line.startsWith("gh variable set FORM_SYNC_ENABLED --body true")),
    ).toBe(true);
    expect(lines.some((line) => line.startsWith("gh workflow run form-sync.yml"))).toBe(true);
  });

  it("should not start the dry run when --skip-workflow is given", async () => {
    const { io, log } = harness();
    await runSetup(options({ skipWorkflow: true }), io);
    const lines = log();
    expect(lines.some((line) => line.startsWith("gh workflow run "))).toBe(false);
    // 変数の設定までは行う。 dry run を打たないだけ。
    expect(lines.some((line) => line.startsWith("gh variable set "))).toBe(true);
  });

  it("should stop at the failing command instead of continuing the sequence", async () => {
    const { io, log } = harness({ ghSecretFails: true });
    await expect(runSetup(options(), io)).rejects.toThrow(/gh secret set/);
    expect(log().some((line) => line.startsWith("gh variable set "))).toBe(false);
  });

  it("should forward an explicit repository to every gh call that takes one", async () => {
    const { io, log } = harness();
    await runSetup(options({ repo: "owner/name" }), io);
    for (const line of log().filter((entry) => entry.startsWith("gh secret set "))) {
      expect(line).toContain("--repo owner/name");
    }
  });

  it("should close by pointing at the next steps and the form URL", async () => {
    const { io, output } = harness();
    await runSetup(options(), io);
    expect(output()).toContain("完了しました");
    expect(output()).toContain(
      "https://docs.google.com/forms/d/e/1FAIpQLScSampleFormKey123/formResponse",
    );
  });
});
