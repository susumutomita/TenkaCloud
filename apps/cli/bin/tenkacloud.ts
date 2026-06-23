#!/usr/bin/env bun
/**
 * Issue #988 (Phase 1) + Issue #1305 (Phase 2): TenkaCloud CLI entry point。
 *
 * Phase 1 subcommand:
 *   - tenkacloud login    : Cognito Hosted UI を loopback PKCE で叩いて token 取得
 *   - tenkacloud logout   : credential store を空にする
 *   - tenkacloud whoami   : 現在の id_token claim を表示
 *   - tenkacloud status   : サインイン状態 (token expiry 残時間) を表示
 *
 * Phase 2 subcommand (#1305):
 *   - tenkacloud tenants <list|get|create|delete>
 *   - tenkacloud events <list|get|create|end|archive|report>
 *   - tenkacloud deploy <eventId> <teamId> <problemId>
 *   - tenkacloud deploy <bulk|status|logs>
 *   - tenkacloud scoreboard <eventId>
 *   - tenkacloud score-events <eventId> [--team --from --to]
 *   - tenkacloud idp <list|create|update|delete>
 *   - tenkacloud audit <query|export>
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { runAudit } from "../src/commands/audit.ts";
import { runDeploy } from "../src/commands/deploy.ts";
import { runEvents } from "../src/commands/events.ts";
import { runIdp } from "../src/commands/idp.ts";
import { runLocal } from "../src/commands/local.ts";
import { runScoreboard, runScoreEvents } from "../src/commands/scoreboard.ts";
import { runTenants } from "../src/commands/tenants.ts";
import { MissingApiBaseError } from "../src/config/api-urls.ts";
import { clearTokens, isExpired, loadTokens, saveTokens } from "../src/credential-store.ts";
import { ApiError } from "../src/http/fetch-with-auth.ts";
import { signInWithCognito } from "../src/oauth.ts";

function readEnvConfig() {
  const hostedUiDomain = process.env.TENKACLOUD_COGNITO_HOSTED_UI_DOMAIN;
  const clientId = process.env.TENKACLOUD_COGNITO_CLI_CLIENT_ID;
  const issuer = process.env.TENKACLOUD_COGNITO_ISSUER;
  if (!hostedUiDomain || !clientId || !issuer) {
    console.error(
      "Error: 環境変数が不足しています。 次を設定してください:\n" +
        "  TENKACLOUD_COGNITO_HOSTED_UI_DOMAIN (= https://<prefix>.auth.<region>.amazoncognito.com)\n" +
        "  TENKACLOUD_COGNITO_CLI_CLIENT_ID    (= UserPool に追加した CLI 用 client ID)\n" +
        "  TENKACLOUD_COGNITO_ISSUER           (= https://cognito-idp.<region>.amazonaws.com/<userPoolId>)",
    );
    process.exit(2);
  }
  return { hostedUiDomain, clientId, issuer };
}

function readHostedUiDomain(): string {
  const v = process.env.TENKACLOUD_COGNITO_HOSTED_UI_DOMAIN;
  if (!v) {
    console.error(
      "Error: TENKACLOUD_COGNITO_HOSTED_UI_DOMAIN が未設定です (= refresh token 用に必要)",
    );
    process.exit(2);
  }
  return v;
}

function openBrowser(url: string): Promise<void> {
  // OS 別に open / xdg-open / start を切り替え。 失敗しても続行 (= ユーザーが手動で URL を貼る選択肢を残す)。
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "explorer" : "xdg-open";
  return new Promise((resolve) => {
    const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
    child.on("error", () => resolve());
    child.unref();
    // 起動完了を待たず即 resolve (= browser process が長寿命でも CLI は閉じる)
    setTimeout(resolve, 100);
  });
}

async function cmdLogin(): Promise<number> {
  const config = readEnvConfig();
  console.log("TenkaCloud CLI sign-in を開始します…");
  const tokens = await signInWithCognito(
    {
      hostedUiDomain: config.hostedUiDomain,
      clientId: config.clientId,
      issuer: config.issuer,
    },
    {
      openBrowser,
      notify: (msg) => console.log(`  → ${msg}`),
    },
  );
  saveTokens({
    accessToken: tokens.accessToken,
    idToken: tokens.idToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    issuer: config.issuer,
    clientId: config.clientId,
  });
  const remainSec = tokens.expiresAt - Math.floor(Date.now() / 1000);
  console.log(`✓ Sign-in 完了 (token 有効期限: あと ${Math.floor(remainSec / 60)} 分)`);
  return 0;
}

function cmdLogout(): number {
  clearTokens();
  console.log("✓ Logout (credential store を空にしました)");
  return 0;
}

function decodeJwtClaims(jwt: string): Record<string, unknown> | undefined {
  const parts = jwt.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = parts[1];
    if (!payload) return undefined;
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const buf = Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    return JSON.parse(buf.toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function cmdWhoami(): number {
  const tokens = loadTokens();
  if (!tokens) {
    console.log("(未サインイン)");
    return 1;
  }
  const claims = decodeJwtClaims(tokens.idToken);
  if (!claims) {
    console.error("ID token の decode に失敗しました");
    return 2;
  }
  console.log(JSON.stringify(claims, null, 2));
  return 0;
}

function cmdStatus(): number {
  const tokens = loadTokens();
  if (!tokens) {
    console.log("未サインイン (`tenkacloud login` でログインしてください)");
    return 1;
  }
  if (isExpired(tokens)) {
    console.log(
      "token が expire しています。 Phase 2 では API call 時に自動 refresh されます。 refresh も失敗する場合は `tenkacloud login` を再実行してください。",
    );
    return 1;
  }
  const remainSec = tokens.expiresAt - Math.floor(Date.now() / 1000);
  console.log(`Signed in (issuer: ${tokens.issuer}, expires in ${Math.floor(remainSec / 60)} min)`);
  return 0;
}

const USAGE = `tenkacloud — TenkaCloud CLI

Auth:
  tenkacloud login                 Cognito Hosted UI 経由でサインイン (PKCE + loopback)
  tenkacloud logout                credential store を空にする
  tenkacloud whoami                現在の ID token claim を JSON で表示
  tenkacloud status                サインイン状態を表示

System Admin (Control Plane):
  tenkacloud tenants list                              tenant 一覧
  tenkacloud tenants get <tenantId>                    tenant 詳細
  tenkacloud tenants create --name --tier --admin-email  新規 tenant 作成
  tenkacloud tenants delete <tenantId>                 tenant 削除

Tenant Admin (Application Plane):
  tenkacloud events list [--status <s>]                event 一覧
  tenkacloud events get <eventId>                      event 詳細
  tenkacloud events create --name --start --end --problemset
  tenkacloud events end <eventId>                      競技終了
  tenkacloud events archive <eventId>                  archive
  tenkacloud events report <eventId>                   markdown 形式 summary

Problem deploy:
  tenkacloud deploy <eventId> <teamId> <problemId>     1 deployment を発火
  tenkacloud deploy bulk <eventId>                     全 team x 全 problem を一括 deploy
  tenkacloud deploy status <deploymentId>              deployment status
  tenkacloud deploy logs <deploymentId>                deployment logs

Scoreboard:
  tenkacloud scoreboard <eventId>                      scoreboard を表示
  tenkacloud score-events <eventId> [--team --from --to]  score events を fetch

SAML IdP:
  tenkacloud idp list
  tenkacloud idp create --name --metadata-url
  tenkacloud idp update <idpId> --metadata-url
  tenkacloud idp delete <idpId>

Audit:
  tenkacloud audit query [--from --to --principal --action]
  tenkacloud audit export --from --to --out <path>

Local (self-paced — no AWS/Cognito):
  tenkacloud local up [problemId] [--port N]   local API 起動 + portal runtime-config 生成
  tenkacloud local open [url]                   participant portal をブラウザで開く
  tenkacloud local status                       local API の稼働状況
  tenkacloud local evaluate <problemId> <flag>  flag をローカル採点
  tenkacloud local down                         local API を停止

Output flags (どの subcommand でも):
  --json  raw JSON 出力 (= jq 用)
  --csv   CSV 出力 (= Excel 用)
  default: pretty ascii table

Env (login):
  TENKACLOUD_COGNITO_HOSTED_UI_DOMAIN
  TENKACLOUD_COGNITO_CLI_CLIENT_ID
  TENKACLOUD_COGNITO_ISSUER

Env (Phase 2 API base URLs):
  TENKACLOUD_API_BASE_CONTROL  (= System Admin / tenants)
  TENKACLOUD_API_BASE_TENANT   (= Tenant Admin / events / idp / audit)
  TENKACLOUD_API_BASE_DEPLOY   (= Problem deploy)
  TENKACLOUD_API_BASE_EVENT    (= Scoreboard / score-events)
`;

async function runWithErrorHandling(fn: () => Promise<number>): Promise<number> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof MissingApiBaseError) {
      console.error(`Error: ${err.message}`);
      return 2;
    }
    if (err instanceof ApiError) {
      console.error(`Error: ${err.userMessage}`);
      return err.status === 401 ? 2 : 1;
    }
    if (err instanceof Error) {
      console.error(`Error: ${err.message}`);
      return 1;
    }
    console.error(`Error: ${String(err)}`);
    return 1;
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const restArgs = process.argv.slice(3);
  let code: number;
  switch (cmd) {
    case "login":
      code = await cmdLogin();
      break;
    case "logout":
      code = cmdLogout();
      break;
    case "whoami":
      code = cmdWhoami();
      break;
    case "status":
      code = cmdStatus();
      break;
    case "tenants":
      code = await runWithErrorHandling(() =>
        runTenants(restArgs, { auth: { hostedUiDomain: readHostedUiDomain() } }),
      );
      break;
    case "events":
      code = await runWithErrorHandling(() =>
        runEvents(restArgs, { auth: { hostedUiDomain: readHostedUiDomain() } }),
      );
      break;
    case "deploy":
      code = await runWithErrorHandling(() =>
        runDeploy(restArgs, { auth: { hostedUiDomain: readHostedUiDomain() } }),
      );
      break;
    case "scoreboard":
      code = await runWithErrorHandling(() =>
        runScoreboard(restArgs, { auth: { hostedUiDomain: readHostedUiDomain() } }),
      );
      break;
    case "score-events":
      code = await runWithErrorHandling(() =>
        runScoreEvents(restArgs, { auth: { hostedUiDomain: readHostedUiDomain() } }),
      );
      break;
    case "idp":
      code = await runWithErrorHandling(() =>
        runIdp(restArgs, { auth: { hostedUiDomain: readHostedUiDomain() } }),
      );
      break;
    case "audit":
      code = await runWithErrorHandling(() =>
        runAudit(restArgs, { auth: { hostedUiDomain: readHostedUiDomain() } }),
      );
      break;
    case "local":
      code = await runWithErrorHandling(() =>
        runLocal(restArgs, {
          fs: {
            existsSync,
            readFileSync: (p, enc) => readFileSync(p, enc),
            writeFileSync: (p, data) => writeFileSync(p, data),
            mkdirSync: (p, opts) => {
              mkdirSync(p, opts);
            },
            rmSync: (p, opts) => rmSync(p, opts),
            statIsDirectory: (p) => statSync(p).isDirectory(),
            readdirSync: (p) => readdirSync(p),
          },
          spawnDetached: (command, spawnArgs) => {
            const child = spawn(command, [...spawnArgs], { detached: true, stdio: "ignore" });
            child.unref();
            return child.pid ?? -1;
          },
          openBrowser: (url) => {
            const opener =
              process.platform === "darwin"
                ? "open"
                : process.platform === "win32"
                  ? "explorer"
                  : "xdg-open";
            const child = spawn(opener, [url], { detached: true, stdio: "ignore" });
            child.unref();
          },
        }),
      );
      break;
    case "-h":
    case "--help":
    case "help":
    case undefined:
      console.log(USAGE);
      code = 0;
      break;
    default:
      console.error(`Unknown command: ${cmd}\n\n${USAGE}`);
      code = 1;
  }
  process.exit(code);
}

void main();
