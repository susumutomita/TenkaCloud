#!/usr/bin/env bun
/**
 * Turso 選択時の deploy 直前ゲート。
 *
 * ## なぜ必要か
 *
 * `make env-check-lite` は turso のとき 2 つの変数が **空でないか** しか見ない。 実際に
 * deploy を壊す条件 — SSM parameter が存在しない、 SecureString でない、 token が期限切れ —
 * はどれも通過する。 その結果 CodeBuild は緑で終わり、 最初に DB を開く Lambda が cold start で
 * 落ちて、 運用者には Admin Console の不透明な 500 としてだけ見える。
 *
 * 同等の検査は `turso-live preflight` に既にあるが、 あれは初回 live 検証 wizard の一部で、
 * Turso CLI の存在と `CDK_PARAM_FEATURES={"samlSso":true}` を要求する。 どちらも deploy の
 * 前提ではないため、 pipeline / CodeBuild からは呼べない。 本 module は **deploy に必要な
 * 部分だけ** を取り出して、 `make deploy` の経路に置く。
 *
 * ## URL の受理範囲が live preflight と違う理由
 *
 * `turso-live preflight` は `https://` のみ受理するが、 runtime の client は
 * `@libsql/client/http` で `libsql:` / `https:` / `http:` を受け付ける。 lite-pipeline の
 * `TursoDatabaseUrl` parameter は運用者に `libsql://` を案内しているため、 `https://` 限定の
 * 検査を deploy 経路へそのまま置くと **実際には動く設定を拒否** してしまう。 ここでは
 * runtime が受けるもののうち平文の `http://` だけを外し、 `libsql://` と `https://` を通す。
 */

import { spawnSync } from "node:child_process";
import {
  describeTursoTokenExpiry,
  formatTursoTokenExpiryDate,
  TURSO_TOKEN_EXPIRY_WARNING_MS,
} from "./turso-token-rotate";

export interface CommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type CommandRunner = (command: string, args: readonly string[]) => CommandResult;

export interface CheckResult {
  readonly ok: boolean;
  readonly output: string;
}

const defaultRunner: CommandRunner = (command, args) => {
  const result = spawnSync(command, [...args], { encoding: "utf8" });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
};

/** `select 1` の結果。 token は載せない。 */
export interface TokenProbeResult {
  readonly ok: boolean;
  /** 失敗理由。 出力前に token を redact する。 */
  readonly detail?: string;
}

/** 保存済み token で 1 度だけ認証済みクエリを投げる seam (test は network を使わない)。 */
export type TokenProbe = (databaseUrl: string, token: string) => Promise<TokenProbeResult>;

/** 万一 Turso 側の応答が token を echo しても表示されないようにする。 */
function redactToken(message: string, token: string): string {
  return token === "" ? message : message.split(token).join("***");
}

/**
 * `libsql://` は libSQL client 用の scheme で、 HTTP API の endpoint は `https://`。
 * preflight は URL を受理する側で `libsql://` を通しているので、 probe 側で揃える。
 */
function toHttpEndpoint(databaseUrl: string): string {
  let endpoint = databaseUrl.replace(/^libsql:\/\//i, "https://");
  // 末尾 `/` の除去はループで行う。 同等の `/\/+$/` は backtracking が super-linear に
  // なりうるとして lint が止める (sonarjs/slow-regex)。
  while (endpoint.endsWith("/")) endpoint = endpoint.slice(0, -1);
  return endpoint;
}

/**
 * `turso-token-rotate` が rotate 後に投げるのと同じ `select 1`。 同じ形にしてあるのは、
 * 「rotate が成功と言った条件」 と 「deploy が通す条件」 がずれないようにするため。
 */
const defaultTokenProbe: TokenProbe = async (databaseUrl, token) => {
  try {
    const response = await fetch(`${toHttpEndpoint(databaseUrl)}/v2/pipeline`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        requests: [{ type: "execute", stmt: { sql: "select 1" } }, { type: "close" }],
      }),
    });
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` };
    const body = (await response.json()) as {
      readonly results?: readonly {
        readonly type?: string;
        readonly error?: { readonly message?: string };
      }[];
    };
    const failed = (body.results ?? []).find((entry) => entry.type === "error");
    return failed ? { ok: false, detail: failed.error?.message ?? "pipeline error" } : { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
};

/** `dynamodb` (既定) では本ゲートは何もしない。 */
export function tursoBackendSelected(env: NodeJS.ProcessEnv): boolean {
  const backend = env.CDK_PARAM_CONTROL_DATA_BACKEND?.trim().toLowerCase();
  return backend !== undefined && backend !== "" && backend !== "dynamodb";
}

function resolveRegion(env: NodeJS.ProcessEnv): string {
  return env.AWS_REGION?.trim() || env.AWS_DEFAULT_REGION?.trim() || "";
}

/**
 * AWS を呼ばずに判定できる設定不備。 runtime が受ける URL scheme を拒否しないこと、
 * SSM の階層名が `/` 始まりであることの 2 点が要点。
 */
export function validateTursoDeployConfig(env: NodeJS.ProcessEnv): readonly string[] {
  const errors: string[] = [];

  const databaseUrl = env.CDK_PARAM_TURSO_DATABASE_URL?.trim() ?? "";
  if (databaseUrl === "") {
    errors.push("CDK_PARAM_TURSO_DATABASE_URL が未設定です");
  } else if (!/^(libsql|https):\/\/[^/\s]+/i.test(databaseUrl)) {
    errors.push(
      `CDK_PARAM_TURSO_DATABASE_URL は libsql:// か https:// が必要です (現在: ${databaseUrl})`,
    );
  }

  const parameterName = env.CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME?.trim() ?? "";
  if (parameterName === "") {
    errors.push("CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME が未設定です");
  } else if (!parameterName.startsWith("/")) {
    errors.push(
      `CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME は / で始まる絶対パスが必要です (現在: ${parameterName})`,
    );
  }

  if (resolveRegion(env) === "") {
    errors.push("AWS_REGION (または AWS_DEFAULT_REGION) が必要です");
  }

  return errors;
}

/**
 * 保存済み token を 1 度だけ読み、 期限と **実際に使えるか** を確かめる。
 *
 * stdout は token そのものなので、 成功 / 失敗のどちらでも stdout を出力へ混ぜない
 * (`turso-live-guide.ts` の同名検査と同じ約束)。 token は戻り値にも載せない。
 *
 * ## `exp` だけでは足りない
 *
 * 期限切れは token が使えなくなる理由の 1 つでしかない。 rotate が途中で失敗した、 別 database
 * の token を書いた、 `turso-reset` で database を作り直した — どれでも token は `exp` 的には
 * 有効なまま Turso に 401 で拒否される。 その状態で deploy すると CodeBuild は緑で終わり、
 * 最初に DB を開く Lambda が cold start で落ちて、 運用者には Admin Console の不透明な 500
 * としてだけ見える。 このゲートが存在する理由そのものなので、 metadata ではなく **実際の
 * 認証済みクエリ 1 本** で確かめる。 `turso-token-rotate` が rotate 後に投げているのと同じ
 * `select 1` を、 同じ endpoint 形式で使う。
 */
async function checkStoredToken(
  parameterName: string,
  databaseUrl: string,
  env: NodeJS.ProcessEnv,
  run: CommandRunner,
  probe: TokenProbe,
): Promise<{ readonly ok: boolean; readonly lines: readonly string[] }> {
  const result = run("aws", [
    "ssm",
    "get-parameter",
    "--name",
    parameterName,
    "--with-decryption",
    "--region",
    resolveRegion(env),
    "--query",
    "Parameter.Value",
    "--output",
    "text",
  ]);
  if (result.status !== 0) {
    const detail = result.stderr.trim() || `exit ${result.status}`;
    return {
      ok: false,
      lines: [
        `✗ SSM parameter ${parameterName} を復号できません: ${detail}`,
        "  deploy する IAM principal に ssm:GetParameter と、SecureString の復号権限が必要です",
      ],
    };
  }
  const token = result.stdout.trim();
  const expiry = describeTursoTokenExpiry(token);
  const lines: string[] = [];
  if (expiry.kind === "never") {
    lines.push("✓ Turso token: 無期限");
  } else if (expiry.kind === "unknown") {
    lines.push("⚠ Turso token: JWT ではないため期限は未確認");
  } else {
    const date = formatTursoTokenExpiryDate(expiry.at);
    const remaining = expiry.at.getTime() - Date.now();
    if (remaining <= 0) {
      return {
        ok: false,
        lines: [
          `✗ Turso token は ${date} に期限切れです`,
          "  このまま deploy すると Turso が 401 を返し、Admin Console は 500 になります",
          "  → make turso-token-rotate で再発行してください",
        ],
      };
    }
    lines.push(
      remaining <= TURSO_TOKEN_EXPIRY_WARNING_MS
        ? `⚠ Turso token は ${date} に期限切れ — 7日以内`
        : `✓ Turso token: ${date} まで有効`,
    );
  }

  const probed = await probe(databaseUrl, token);
  if (!probed.ok) {
    return {
      ok: false,
      lines: [
        ...lines,
        `✗ 保存済み token で ${databaseUrl} に接続できません: ${redactToken(probed.detail ?? "不明なエラー", token)}`,
        "  期限は問題なくても、rotate 途中の失敗・別 database の token・turso-reset 後の作り直しで起こります",
        "  このまま deploy すると Turso が 401 を返し、Admin Console は 500 になります",
        "  → make turso-token-rotate で再発行してください",
      ],
    };
  }
  lines.push("✓ 保存済み token で select 1 が成功しました");
  return { ok: true, lines };
}

/**
 * deploy 直前の read-only 検査。 `dynamodb` では何も検査せず ok を返す。
 *
 * 検査するのは 「deploy 後に最初の DB アクセスが失敗する条件」 に限る。 AWS への呼び出しは
 * `describe-parameters` (metadata のみ) と `get-parameter` の 2 つだけで、 そのあと Turso へ
 * `select 1` を 1 本投げる。 どれも read-only で、 deploy 対象には一切触れない。
 */
export async function runTursoDeployPreflight(
  env: NodeJS.ProcessEnv,
  run: CommandRunner = defaultRunner,
  probe: TokenProbe = defaultTokenProbe,
): Promise<CheckResult> {
  if (!tursoBackendSelected(env)) {
    return { ok: true, output: "" };
  }

  const lines = ["=== Turso deploy preflight (read-only) ==="];
  const configErrors = validateTursoDeployConfig(env);
  if (configErrors.length > 0) {
    lines.push(...configErrors.map((error) => `✗ ${error}`));
    lines.push("→ make turso-live-guide で設定手順を確認できます");
    return { ok: false, output: lines.join("\n") };
  }

  const parameterName = env.CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME?.trim() ?? "";
  const described = run("aws", [
    "ssm",
    "describe-parameters",
    "--parameter-filters",
    `Key=Name,Option=Equals,Values=${parameterName}`,
    "--region",
    resolveRegion(env),
    "--query",
    "Parameters[0].Type",
    "--output",
    "text",
  ]);
  if (described.status !== 0) {
    const detail = described.stderr.trim() || `exit ${described.status}`;
    lines.push(`✗ SSM parameter ${parameterName} を確認できません: ${detail}`);
    return { ok: false, output: lines.join("\n") };
  }
  const parameterType = described.stdout.trim();
  if (parameterType === "" || parameterType === "None") {
    lines.push(
      `✗ SSM parameter ${parameterName} が ${resolveRegion(env)} に存在しません`,
      "  deploy 先と同じ account / region に SecureString を作成してください:",
      `  aws ssm put-parameter --name ${parameterName} --type SecureString --value <token>`,
    );
    return { ok: false, output: lines.join("\n") };
  }
  if (parameterType !== "SecureString") {
    lines.push(
      `✗ SSM parameter ${parameterName} の型が ${parameterType} です (SecureString が必要)`,
    );
    return { ok: false, output: lines.join("\n") };
  }
  lines.push(`✓ SSM parameter: SecureString (値は表示しません)`);

  const databaseUrl = env.CDK_PARAM_TURSO_DATABASE_URL?.trim() ?? "";
  const stored = await checkStoredToken(parameterName, databaseUrl, env, run, probe);
  lines.push(...stored.lines);
  if (!stored.ok) return { ok: false, output: lines.join("\n") };

  lines.push("✓ Turso preflight passed");
  return { ok: true, output: lines.join("\n") };
}

if (import.meta.main) {
  const result = await runTursoDeployPreflight(process.env);
  if (result.output) console.log(result.output);
  process.exit(result.ok ? 0 : 1);
}
