#!/usr/bin/env bun
/**
 * Issue #1345: `make env-init` の .env 生成 wizard。
 *
 * Lite mode の first-run UX 改善 (= 30-min onboarding target) の一環として、
 * `cp .env.example .env` → エディタで手編集 → 値が空 / placeholder の状態で
 * `make deploy` を叩いて失敗する pitfall を潰す。
 *
 * 設計判断:
 *   - 既存 `.env` があれば skip (idempotent)。 上書きしたいときは手動で削除させる
 *     (= destructive を黙ってやらない)。
 *   - .env.example を text parse して `KEY=value` 行を取り出し、 必須キーだけ prompt。
 *     SCHEMA を別 file 化しない (= source of truth は .env.example 1 つ)。
 *   - prompt は stdin / stdout で行う標準的な readline。 process がパイプされている
 *     場合 (= 非 TTY) はデフォルト値で書き出し (= CI / dev container でも壊れない)。
 *   - 値検証はデプロイ先の契約と一致させる。 email は @ を含む、region は
 *     ap-northeast-1 形式、ExternalId は competitor-bootstrap.yaml と同じ
 *     16〜128文字・ASCII許可文字だけを受け付ける。
 *
 * テスト容易性:
 *   - generateEnvContent / parseExampleKeys を pure 関数で export。
 *   - prompt は injectable (= shell test では non-TTY パスを通る)。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";

export const DEFAULT_ENV = "development";

export interface EnvInitOptions {
  readonly env: string;
  readonly repoRoot: string;
  readonly ask: (question: string, fallback: string) => Promise<string>;
  readonly print: (line: string) => void;
  readonly nonInteractive?: boolean;
}

export interface EnvKeyPrompt {
  readonly key: string;
  readonly label: string;
  readonly defaultValue: string;
  readonly required: boolean;
  readonly validate?: (value: string) => string | undefined;
}

/**
 * Issue #1345 task spec: 「必須 vars (SYSTEM_ADMIN_EMAIL / CDK_PARAM_DEPLOY_EXTERNAL_ID
 * / AWS_REGION) を prompt」。 Lite mode の実情に合わせて TENANT_ADMIN_EMAIL を主、
 * SYSTEM_ADMIN_EMAIL も書き出すが prompt は 1 回で済ます (= fallback 互換、
 * scripts/tenkacloud-lite.ts cmdUp の env 解決と同じ規約)。
 */
export const PROMPTS: readonly EnvKeyPrompt[] = [
  {
    key: "TENANT_ADMIN_EMAIL",
    label:
      "Application Admin Console 初期ユーザー宛先 (= Lite mode の Tenant Admin、 SaaS mode の System Admin)",
    defaultValue: "admin@example.com",
    required: true,
    validate: (v) => (v.includes("@") ? undefined : "email アドレス形式にしてください (= xxx@yyy)"),
  },
  {
    key: "AWS_REGION",
    label: "AWS リージョン (推奨: ap-northeast-1)",
    defaultValue: "ap-northeast-1",
    required: true,
    validate: (v) =>
      /^[a-z]{2}-[a-z]+-\d$/.test(v)
        ? undefined
        : "AWS region 形式にしてください (= ap-northeast-1 等)",
  },
  {
    key: "CDK_PARAM_DEPLOY_EXTERNAL_ID",
    label:
      "ExternalId (= competitor AWS account への AssumeRole で confused-deputy 攻撃を防ぐ secret、 任意の文字列)",
    defaultValue: "tenkacloud-lite-default",
    required: true,
    validate: (v) =>
      /^[A-Za-z0-9_=,.@:/-]{16,128}$/.test(v)
        ? undefined
        : "16〜128文字で、半角英数字と _ = , . @ : / - を使ってください",
  },
];

/**
 * .env.example を text parse して `KEY=value` の行から KEY = value の対応を取り出す。
 * comment / blank 行は無視。 multi-line value (= shell の quoted heredoc 等) は未対応
 * (= .env.example の形式ではそもそも使っていない)。
 */
export function parseExampleKeys(exampleContent: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of exampleContent.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const equalsIdx = line.indexOf("=");
    if (equalsIdx <= 0) continue;
    const key = line.slice(0, equalsIdx).trim();
    const value = line.slice(equalsIdx + 1).trim();
    out[key] = value;
  }
  return out;
}

/**
 * `.env` の中身を生成する。 prompt 結果 + .env.example の comment 構造を保つため、
 * example をベースに必須キーだけ override する。 まったく新しい key を入れない
 * (= example をそのまま compatible に保つ)。
 */
export function generateEnvContent(
  exampleContent: string,
  overrides: Readonly<Record<string, string>>,
): string {
  const lines = exampleContent.split("\n");
  const seen = new Set<string>();
  const result: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine;
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      result.push(line);
      continue;
    }
    const equalsIdx = trimmed.indexOf("=");
    if (equalsIdx <= 0) {
      result.push(line);
      continue;
    }
    const key = trimmed.slice(0, equalsIdx).trim();
    if (Object.hasOwn(overrides, key)) {
      result.push(`${key}=${overrides[key]}`);
      seen.add(key);
    } else {
      result.push(line);
    }
  }
  // override に存在するが example に無いキーは末尾に追記 (= future-proof)。
  const extras = Object.entries(overrides).filter(([k]) => !seen.has(k));
  if (extras.length > 0) {
    result.push("");
    result.push("# === Added by `make env-init` ===");
    for (const [k, v] of extras) {
      result.push(`${k}=${v}`);
    }
  }
  return result.join("\n");
}

/**
 * 1 つの prompt について、 最大 3 回まで再入力を許し validate を通った値を返す。
 * 非対話モードでは validate を skip して default を採用 (= 設計バグの場合 deploy
 * 時に再度 fail する)。
 */
async function resolvePromptValue(prompt: EnvKeyPrompt, opts: EnvInitOptions): Promise<string> {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const raw = opts.nonInteractive
      ? prompt.defaultValue
      : await opts.ask(`${prompt.key} (${prompt.label})`, prompt.defaultValue);
    const trimmed = raw.trim();
    const candidate = trimmed.length > 0 ? trimmed : prompt.defaultValue;
    const error = prompt.validate?.(candidate);
    if (!error) return candidate;
    opts.print(`  ✗ ${error}`);
    if (opts.nonInteractive) return candidate;
  }
  // 3 回 invalid なら最後の試行結果ではなく default を採用 (deterministic fallback)。
  return prompt.defaultValue;
}

function printIntro(opts: EnvInitOptions, envPath: string, examplePath: string): void {
  opts.print("=== TenkaCloud Lite mode .env wizard ===");
  opts.print("");
  opts.print(`生成先: ${envPath}`);
  opts.print(`参照元: ${examplePath}`);
  opts.print("");
  opts.print("必須の 3 項目を入力してください (Enter で default 採用):");
  opts.print("");
}

function printOutro(opts: EnvInitOptions, envPath: string): void {
  opts.print("");
  opts.print(`✓ .env を生成しました: ${envPath}`);
  opts.print("");
  opts.print("Next steps:");
  opts.print("  1. make deploy       — Lite mode deploy (= ~10 min)");
  opts.print("  2. make lite-console-url   — Application Admin Console URL を表示");
  opts.print("  3. make lite-portal-url    — Participant Portal URL を表示");
}

/**
 * `.env` を生成する main flow。 副作用は file 書き込みだけで、 prompt I/O は
 * injectable (= unit test で deterministic 答えを返せる)。
 */
export async function runEnvInit(opts: EnvInitOptions): Promise<{
  readonly status: "created" | "exists";
  readonly path: string;
}> {
  const envDir = join(opts.repoRoot, "infrastructure", "environments", opts.env);
  const envPath = join(envDir, ".env");
  const examplePath = join(envDir, ".env.example");

  if (existsSync(envPath)) {
    opts.print(`✓ ${envPath} は既に存在します (skip)`);
    opts.print("  上書きしたい場合は手動で削除してから再実行してください。");
    return { status: "exists", path: envPath };
  }

  if (!existsSync(examplePath)) {
    throw new Error(`.env.example が見つかりません: ${examplePath}`);
  }

  const exampleContent = readFileSync(examplePath, "utf8");
  printIntro(opts, envPath, examplePath);

  const overrides: Record<string, string> = {};
  for (const prompt of PROMPTS) {
    overrides[prompt.key] = await resolvePromptValue(prompt, opts);
  }

  // SaaS mode との env 共用を考えて SYSTEM_ADMIN_EMAIL も TENANT_ADMIN_EMAIL から
  // 派生させる (= 同 inbox で SystemAdmin invite も受けたい運用が多い)。
  const tenantAdminEmail = overrides.TENANT_ADMIN_EMAIL;
  if (tenantAdminEmail) {
    overrides.SYSTEM_ADMIN_EMAIL = tenantAdminEmail;
  }

  const content = generateEnvContent(exampleContent, overrides);
  mkdirSync(dirname(envPath), { recursive: true });
  writeFileSync(envPath, content, "utf8");

  printOutro(opts, envPath);
  return { status: "created", path: envPath };
}

async function defaultMain(): Promise<number> {
  const env = process.env.ENV ?? DEFAULT_ENV;
  const repoRoot = process.cwd();
  const isTty = process.stdin.isTTY && process.stdout.isTTY;

  if (!isTty) {
    // 非 TTY (= CI / pipe) では default 値で 1 発生成。 user 確認を強要しない。
    try {
      await runEnvInit({
        env,
        repoRoot,
        ask: async (_q, fallback) => fallback,
        print: (line) => process.stdout.write(`${line}\n`),
        nonInteractive: true,
      });
      return 0;
    } catch (err) {
      process.stderr.write(`env-init failed: ${(err as Error).message}\n`);
      return 1;
    }
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await runEnvInit({
      env,
      repoRoot,
      ask: async (question, fallback) => {
        const answer = await rl.question(`  ${question}\n  [default: ${fallback}] > `);
        return answer;
      },
      print: (line) => process.stdout.write(`${line}\n`),
    });
    return 0;
  } catch (err) {
    process.stderr.write(`env-init failed: ${(err as Error).message}\n`);
    return 1;
  } finally {
    rl.close();
  }
}

if (import.meta.main) {
  const exitCode = await defaultMain();
  process.exit(exitCode);
}
