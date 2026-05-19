#!/usr/bin/env bun
/**
 * Issue #1056: deploy artifact bucket の lifecycle policy を stdout に JSON で emit する。
 *
 * `scripts/prepare-source-bundle.sh` が `aws s3api put-bucket-lifecycle-configuration` に
 * 渡すための AWS API shape を、 `infrastructure/environments/<env>/config.json` の
 * `sourceBundleConfig` を source of truth として組み立てる。 別 file `scripts/*.json` を
 * 持たず、 config が 1 箇所に集約される (= config 乱立を避ける運用判断)。
 *
 *   bun run scripts/print-source-bundle-lifecycle.ts [env]
 *
 * `env` を省略すると `${ENV:-development}` を使う。 placeholder expansion は emit script
 * で self-contained に行う (= `infrastructure/lib/utils/config-loader.ts` は ajv を import
 * するため repo-root context から呼ぶと module resolution に失敗する; 本 script で必要な
 * のは `${VAR:-default}` の最小展開だけなので 5 行で十分)。
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { SourceBundleConfig } from "../infrastructure/lib/config/config-interface";
import { buildSourceBundleLifecyclePolicy } from "../infrastructure/lib/source-bundle/lifecycle-policy";

const env = process.argv[2] ?? process.env.ENV ?? "development";
const configPath = path.resolve(
  __dirname,
  "..",
  "infrastructure",
  "environments",
  env,
  "config.json",
);

const content = readFileSync(configPath, "utf-8");
const expanded = content.replace(/\$\{([^}]+)\}/g, (_, expression: string) => {
  const [rawVarName, ...defaultParts] = expression.split(":-");
  const varName = rawVarName.trim();
  const defaultValue = defaultParts.length > 0 ? defaultParts.join(":-") : undefined;
  const value = process.env[varName];
  if (value !== undefined && value !== "") return JSON.stringify(value).slice(1, -1);
  if (defaultValue !== undefined) return JSON.stringify(defaultValue).slice(1, -1);
  throw new Error(`Environment variable ${varName} is not defined and no default provided`);
});

const config = JSON.parse(expanded) as { sourceBundleConfig?: SourceBundleConfig };
const policy = buildSourceBundleLifecyclePolicy(config.sourceBundleConfig);
console.log(JSON.stringify(policy));
