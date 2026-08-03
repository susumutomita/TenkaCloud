/**
 * `form-setup` の純ロジック (プロセスもネットワークも触らない)。
 *
 * Google 側の準備は今まで README の手順書だった。 手順書は 「読み飛ばした 1 行」
 * を検知できず、 しかもこの機能の失敗は no-cors POST の裏に隠れて無音で消える。
 * そこで検証できるところは全部ここへ寄せ、 CLI 本体 (`setup.ts`) は clasp / gh の
 * 実行と対話だけを持つ。
 *
 * 特に formResponseUrl は、 LP が実行時に使う検証器 (`landing/contact-form.js` の
 * `parseConfig`) をそのまま通す。 ここで別の正規表現を書くと、 LP が弾く URL を
 * 通してしまい、 「同期は成功したのにフォームが出ない」 に戻る。
 */
import { createRequire } from "node:module";
import { join } from "node:path";

/** Apps Script のエディタで一度だけ実行してもらう関数名。 */
export const BOOTSTRAP_FUNCTION = "bootstrap";

/** workflow が secrets を読む GitHub Environment の既定名。 */
const DEFAULT_ENVIRONMENT = "google-form";

/** doPost の共有シークレットに許す最短長 (bootstrap は 32 桁の hex を作る)。 */
const MIN_SYNC_TOKEN_LENGTH = 32;

const SCRIPT_ID_PATTERN = /^[\w-]{20,}$/;
const DEPLOYMENT_ID_PATTERN = /[\w-]{30,}/;
const WEB_APP_URL_PATTERN = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/;

/** CLI の実行条件。 `parseArgs` が引数から組み立てる。 */
export interface SetupOptions {
  /** `owner/name`。 null なら gh がカレントリポジトリを解決する。 */
  repo: string | null;
  /** secrets を書き込む GitHub Environment。 */
  environment: string;
  /** 仕上げの dry run 実行を打たない。 */
  skipWorkflow: boolean;
}

/** `bootstrap()` が返す、 検証済みの Google 側の識別子。 */
export interface BootstrapPayload {
  formId: string;
  syncToken: string;
  formResponseUrl: string;
  responseSpreadsheetId: string | null;
  notifyEmails: string | null;
}

/** GitHub Environment へ書き込む secret 1 件。 */
export interface SecretEntry {
  name: string;
  value: string;
}

const USAGE =
  "Usage: bun run scripts/form/setup.ts [--repo <owner/name>] [--environment <name>] [--skip-workflow]";

/**
 * 値を取るフラグの読み出し。
 *
 * 値を省略すると次のフラグを値として飲み込み、 意図しない Environment へ
 * secrets を書いてしまう。 `--` 始まりは値ではないとみなして落とす。
 */
function takeValue(arg: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) {
    throw new Error(`${arg} に値がありません。\n${USAGE}`);
  }
  return value;
}

/** 値を取るフラグ 1 つ分の適用。 未知のフラグはここで例外になる。 */
function applyFlag(options: SetupOptions, arg: string, next: string | undefined): boolean {
  if (arg === "--repo") {
    const value = takeValue(arg, next);
    if (!/^[\w.-]+\/[\w.-]+$/.test(value)) {
      throw new Error(`--repo は owner/name の形で指定してください: ${value}`);
    }
    options.repo = value;
    return true;
  }
  if (arg === "--environment") {
    options.environment = takeValue(arg, next);
    return true;
  }
  throw new Error(`未知の引数です: ${arg}\n${USAGE}`);
}

/**
 * コマンドライン引数を読む。 既定は「カレントリポジトリ」「google-form
 * Environment」「dry run まで走らせる」。
 */
export function parseArgs(argv: readonly string[]): SetupOptions {
  const options: SetupOptions = {
    repo: null,
    environment: DEFAULT_ENVIRONMENT,
    skipWorkflow: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--skip-workflow") {
      options.skipWorkflow = true;
      continue;
    }
    if (applyFlag(options, arg, argv[index + 1])) index += 1;
  }

  return options;
}

/**
 * `form/.clasp.json` から scriptId を読む。 ファイルが無ければ null (= 新規作成)。
 *
 * 壊れている場合に null へ倒すと、 既存プロジェクトがあるのにもう 1 つ作って
 * しまい、 デプロイ先とフォームの対応が分からなくなる。 そこは例外にする。
 */
export function readScriptId(raw: string | null): string | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("form/.clasp.json を読めません。 壊れている場合は消してから再実行してください");
  }
  const scriptId =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>).scriptId
      : undefined;
  if (typeof scriptId !== "string" || !SCRIPT_ID_PATTERN.test(scriptId)) {
    throw new Error(`form/.clasp.json の scriptId が不正です: ${String(scriptId)}`);
  }
  return scriptId;
}

/**
 * `clasp create` の出力から scriptId を取り出す。
 *
 * 取れなかったときに空文字などへ倒すと、 以後の push とデプロイが
 * 別プロジェクトを指したまま進む。 見つからなければ落とす。
 */
export function parseScriptId(stdout: string): string {
  const matched = /script\.google\.com\/d\/([\w-]+)/.exec(stdout);
  if (!matched) {
    throw new Error(`clasp create の出力から script id を取り出せません:\n${stdout}`);
  }
  return matched[1];
}

/**
 * `clasp deploy` の出力から deploymentId を取り出す。
 *
 * これが誤ると Web アプリの URL が別のデプロイを指し、 CI は 「認証は通るのに
 * 同期が効かない」 という診断しづらい壊れ方をする。 見つからなければ落とす。
 */
export function parseDeploymentId(stdout: string): string {
  // clasp 2.x は "- <deploymentId> @<version>." の行に出す。
  for (const line of stdout.split("\n")) {
    const matched = /^-\s+(\S+)\s+@/.exec(line);
    if (matched && DEPLOYMENT_ID_PATTERN.test(matched[1])) return matched[1];
  }
  throw new Error(`clasp deploy の出力から deployment id を取り出せません:\n${stdout}`);
}

/** workflow が `FORM_WEBAPP_URL` として期待する `exec` URL を組み立てる。 */
export function webAppUrl(deploymentId: string): string {
  return `https://script.google.com/macros/s/${deploymentId}/exec`;
}

/** 操作者に開いてもらう Apps Script エディタの URL。 */
export function editorUrl(scriptId: string): string {
  return `https://script.google.com/d/${scriptId}/edit`;
}

/**
 * LP が実行時に使う検証器で URL を確かめる。
 *
 * ここで独自の正規表現を持つと、 LP 側の規則が変わったときに気づけない。
 * 組織ドメイン付きの URL (`/a/example.com/forms/...`) はまさにこの経路で
 * 弾かれる — README の 「一度は人が確かめること」 に書いてあった罠を、
 * secrets を書く前の機械チェックへ移している。
 */
function assertLandingAcceptsUrl(formResponseUrl: string): void {
  const contactForm = createRequire(import.meta.url)(
    join(import.meta.dir, "../../landing/contact-form.js"),
  ) as { parseConfig: (raw: unknown) => unknown };
  try {
    contactForm.parseConfig({
      formResponseUrl,
      fields: { probe: { entryId: "entry.1", title: "probe", kind: "text" } },
    });
  } catch (error) {
    throw new Error(
      `formResponseUrl を LP が受け付けません (${String(error)})。` +
        " 組織ドメイン付きの URL になっていないか、 フォームの公開設定を確認してください",
    );
  }
}

/**
 * エディタから貼り付けられた `bootstrap()` の出力を読み、 検証して返す。
 *
 * ここを緩めると、 誤った値のまま secrets が書かれる。 それが表に出るのは
 * 実際に問い合わせが消えたときなので、 疑わしい入力は全部ここで落とす。
 */
export function parseBootstrapPayload(raw: string): BootstrapPayload {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error(`${BOOTSTRAP_FUNCTION} の出力が貼り付けられていません`);
  }

  // エディタのログは "18:02:11  Info  {...}" のように前置きが付く。 最初の { から
  // 最後の } までを取り出せば、 素の JSON も貼り付けられたログもどちらも通る。
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  let parsed: unknown;
  try {
    if (start < 0 || end < start) throw new Error("no JSON object");
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    throw new Error(
      `${BOOTSTRAP_FUNCTION}() の出力を JSON として読めません。` +
        ` Apps Script エディタで ${BOOTSTRAP_FUNCTION} を実行し、 実行ログの JSON を丸ごと貼り付けてください:\n${trimmed}`,
    );
  }

  const record = parsed as Record<string, unknown>;
  const text = (name: string): string => {
    const value = record[name];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`${BOOTSTRAP_FUNCTION}() の出力に ${name} がありません`);
    }
    return value.trim();
  };
  const optional = (name: string): string | null => {
    const value = record[name];
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  };

  const formId = text("formId");
  const syncToken = text("syncToken");
  if (syncToken.length < MIN_SYNC_TOKEN_LENGTH) {
    throw new Error(
      `syncToken が短すぎます (${syncToken.length} 文字)。 ${MIN_SYNC_TOKEN_LENGTH} 文字以上必要です`,
    );
  }
  const formResponseUrl = text("formResponseUrl");
  assertLandingAcceptsUrl(formResponseUrl);

  return {
    formId,
    syncToken,
    formResponseUrl,
    responseSpreadsheetId: optional("responseSpreadsheetId"),
    notifyEmails: optional("notifyEmails"),
  };
}

/**
 * workflow が読む 4 つの secret を、 書き込む順に並べて返す。
 *
 * 1 つでも欠けたり空だったりすると CI は 「secrets はあるのに中身が無い」 と
 * いう、 未設定より診断しづらい状態になる。 揃っていなければ計画を作らない。
 */
export function buildSecretPlan(values: {
  clasprcJson: string;
  scriptId: string;
  webAppUrl: string;
  syncToken: string;
}): SecretEntry[] {
  // workflow は 4 つが揃っている前提で動く。 空のまま書くと、 CI では
  // 「secrets は存在するが中身が空」 になり、 未設定より診断しづらい。
  if (!WEB_APP_URL_PATTERN.test(values.webAppUrl)) {
    throw new Error(
      `FORM_WEBAPP_URL が .../macros/s/<deploymentId>/exec の形ではありません: ${values.webAppUrl}`,
    );
  }
  const plan: SecretEntry[] = [
    { name: "CLASPRC_JSON", value: values.clasprcJson },
    { name: "FORM_SCRIPT_ID", value: values.scriptId },
    { name: "FORM_WEBAPP_URL", value: values.webAppUrl },
    { name: "FORM_SYNC_TOKEN", value: values.syncToken },
  ];
  for (const entry of plan) {
    if (entry.value.trim().length === 0) {
      throw new Error(`${entry.name} の値が空です`);
    }
  }
  return plan;
}
