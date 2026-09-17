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
 * 保存済み token の JWT `exp` だけを見る。
 *
 * stdout は token そのものなので、 成功 / 失敗のどちらでも stdout を出力へ混ぜない
 * (`turso-live-guide.ts` の同名検査と同じ約束)。 期限切れの token は Turso が 401 を返し、
 * 全 Lambda が 500 になるが、 metadata だけの検査では見えない。
 */
function checkTokenExpiry(
  parameterName: string,
  env: NodeJS.ProcessEnv,
  run: CommandRunner,
): { readonly ok: boolean; readonly lines: readonly string[] } {
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
  const expiry = describeTursoTokenExpiry(result.stdout.trim());
  if (expiry.kind === "never") return { ok: true, lines: ["✓ Turso token: 無期限"] };
  if (expiry.kind === "unknown") {
    return { ok: true, lines: ["⚠ Turso token: JWT ではないため期限は未確認"] };
  }
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
  if (remaining <= TURSO_TOKEN_EXPIRY_WARNING_MS) {
    return { ok: true, lines: [`⚠ Turso token は ${date} に期限切れ — 7日以内`] };
  }
  return { ok: true, lines: [`✓ Turso token: ${date} まで有効`] };
}

/**
 * deploy 直前の read-only 検査。 `dynamodb` では何も検査せず ok を返す。
 *
 * 検査するのは 「deploy 後に最初の DB アクセスが失敗する条件」 に限る。 AWS への呼び出しは
 * `describe-parameters` (metadata のみ) と、 期限確認のための `get-parameter` の 2 つだけ。
 */
export function runTursoDeployPreflight(
  env: NodeJS.ProcessEnv,
  run: CommandRunner = defaultRunner,
): CheckResult {
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

  const expiry = checkTokenExpiry(parameterName, env, run);
  lines.push(...expiry.lines);
  if (!expiry.ok) return { ok: false, output: lines.join("\n") };

  lines.push("✓ Turso preflight passed");
  return { ok: true, output: lines.join("\n") };
}

if (import.meta.main) {
  const result = runTursoDeployPreflight(process.env);
  if (result.output) console.log(result.output);
  process.exit(result.ok ? 0 : 1);
}
