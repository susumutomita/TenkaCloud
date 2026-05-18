#!/usr/bin/env bun
/**
 * Issue #988: TenkaCloud CLI entry point (Phase 1 scaffold)。
 *
 * Phase 1 で実装する subcommand:
 *   - tenkacloud login    : Cognito Hosted UI を loopback PKCE で叩いて token 取得
 *   - tenkacloud logout   : credential store を空にする
 *   - tenkacloud whoami   : 現在の id_token claim を表示
 *   - tenkacloud status   : サインイン状態 (token expiry 残時間) を表示
 *
 * Phase 2 以降で `tenants list` 等を実装する。 Phase 1 は OAuth flow と
 * credential storage の安定化が目的。
 */

import { spawn } from "node:child_process";
import { clearTokens, isExpired, loadTokens, saveTokens } from "../src/credential-store.ts";
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
      "token が expire しています (= refresh は Phase 2 で実装)。 `tenkacloud login` を再実行してください。",
    );
    return 1;
  }
  const remainSec = tokens.expiresAt - Math.floor(Date.now() / 1000);
  console.log(`Signed in (issuer: ${tokens.issuer}, expires in ${Math.floor(remainSec / 60)} min)`);
  return 0;
}

const USAGE = `tenkacloud — TenkaCloud CLI (Phase 1 scaffold)

Usage:
  tenkacloud login     Cognito Hosted UI 経由でサインイン (PKCE + loopback)
  tenkacloud logout    credential store を空にする
  tenkacloud whoami    現在の ID token claim を JSON で表示
  tenkacloud status    サインイン状態を表示

Env (required for login):
  TENKACLOUD_COGNITO_HOSTED_UI_DOMAIN
  TENKACLOUD_COGNITO_CLI_CLIENT_ID
  TENKACLOUD_COGNITO_ISSUER
`;

async function main(): Promise<void> {
  const cmd = process.argv[2];
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
