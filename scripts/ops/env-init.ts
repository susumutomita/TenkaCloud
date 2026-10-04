#!/usr/bin/env bun
/** Restore the existing first-run .env wizard using the cloud hosting configuration contract. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { cloudStackNames } from "../../infrastructure/lib/cloud-hosting/stack-names";

export const DEFAULT_ENV = "development";
export interface EnvInitOptions {
  readonly env: string;
  readonly repoRoot: string;
  readonly ask: (question: string, fallback: string) => Promise<string>;
  readonly print: (line: string) => void;
  readonly nonInteractive?: boolean;
  readonly values?: NodeJS.ProcessEnv;
}
export interface EnvKeyPrompt {
  readonly key: string;
  readonly label: string;
  readonly defaultValue: string;
  readonly validate: (value: string) => boolean;
}
export const PROMPTS: readonly EnvKeyPrompt[] = [
  {
    key: "TENKACLOUD_ADMIN_EMAIL",
    label: "Organizer invitation email / 開催者の招待先メール",
    defaultValue: "",
    validate: (value) => {
      const parts = value.split("@");
      return (
        value.length <= 254 &&
        !/[\s,]/u.test(value) &&
        parts.length === 2 &&
        Boolean(parts[0]) &&
        Boolean(parts[1]?.includes("."))
      );
    },
  },
  {
    key: "ACCOUNT_ID",
    label: "Hosting AWS account ID (12 digits) / 配置先 AWS アカウント",
    defaultValue: "",
    validate: (value) => /^\d{12}$/u.test(value),
  },
  {
    key: "AWS_REGION",
    label: "AWS region / AWS リージョン",
    defaultValue: "ap-northeast-1",
    validate: (value) => /^[a-z]{2}-[a-z]+-\d$/u.test(value),
  },
];

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

async function resolvePromptValue(prompt: EnvKeyPrompt, opts: EnvInitOptions): Promise<string> {
  const fallback = opts.values?.[prompt.key]?.trim() || prompt.defaultValue;
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = opts.nonInteractive
      ? fallback
      : await opts.ask(`${prompt.key} (${prompt.label})`, fallback);
    const value = raw.trim() || fallback;
    if (prompt.validate(value)) return value;
    if (opts.nonInteractive) break;
    opts.print(`Invalid ${prompt.key}; enter the actual deployment value.`);
  }
  throw new Error(
    `A valid ${prompt.key} is required; no .env was created. Use an interactive terminal or export the required values.`,
  );
}

export async function runEnvInit(opts: EnvInitOptions): Promise<{
  readonly status: "created" | "exists";
  readonly path: string;
}> {
  cloudStackNames(opts.env);
  const directory = join(opts.repoRoot, "infrastructure", "environments", opts.env);
  const path = join(directory, ".env");
  if (existsSync(path)) {
    opts.print(`Existing environment retained: ${path}`);
    return { status: "exists", path };
  }
  const example = join(directory, ".env.example");
  const sample = existsSync(example)
    ? example
    : join(opts.repoRoot, "infrastructure", "environments", DEFAULT_ENV, ".env.example");
  const original = readFileSync(sample, "utf8");
  opts.print(`TenkaCloud cloud .env wizard: ${path}`);
  const overrides: Record<string, string> = { ENV: opts.env };
  for (const prompt of PROMPTS) overrides[prompt.key] = await resolvePromptValue(prompt, opts);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, generateEnvContent(original, overrides), { mode: 0o600, flag: "wx" });
  opts.print(
    `Created ${path} (mode 0600). Turso: make turso-live ENV=${opts.env}; DynamoDB: make deploy ENV=${opts.env}.`,
  );
  return { status: "created", path };
}

async function main(): Promise<number> {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const reader = interactive
    ? createInterface({ input: process.stdin, output: process.stdout })
    : undefined;
  try {
    await runEnvInit({
      env: process.env.ENV ?? process.env.CDK_PARAM_ENVIRONMENT ?? DEFAULT_ENV,
      repoRoot: process.cwd(),
      values: process.env,
      nonInteractive: !interactive,
      ask: async (question, fallback) =>
        reader ? reader.question(`${question} [${fallback}]: `) : fallback,
      print: console.log,
    });
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    reader?.close();
  }
}
if (import.meta.main) process.exitCode = await main();
