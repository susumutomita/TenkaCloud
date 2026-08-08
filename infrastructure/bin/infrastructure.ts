#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { resolveBundlingStacks } from "../lib/app-config/bundling-context.js";
import { resolveAppConfig } from "../lib/app-config/index.js";
import { buildTenkaCloudApp } from "../lib/app-wiring/index.js";
import { assertSaasSynthHasNoActivePacks } from "../lib/problem-pack/saas-pack-guard.js";

/**
 * TenkaCloud CDK app の composition root。
 *
 * 1. `resolveAppConfig` が `process.env` + `infrastructure/environments/<env>/{.env,config.json}` +
 *    `problems/<category>/<id>/metadata.json` を読んで `AppConfig` (= 静的 plain object) を返す。
 * 2. `buildTenkaCloudApp` が `AppConfig` だけを参照して全 stack を `new cdk.App()` 上に配線する。
 *
 * env / default / config 解決は `lib/app-config/resolve.ts` で pure function 化されているので、
 * 本ファイルは composition root の責務 (= App 起点 + 解決済 config の引き渡し) だけに専念する。
 * Issue #766 の refactor で 481 行 → 約 30 行に縮小。
 */

const app = new cdk.App();

// #1446 follow-up: pre-commit `make check-synth` は synth の shape (module 解決 / 型 /
// construct ツリー / template 生成) だけを検証するのが目的で、 Lambda の実 Docker バンドルは
// 不要。 SBT の Python Lambda 等のバンドルは毎回 `cdk-<hash>` イメージを生成し CDK が掃除しない
// ため Docker ディスクが膨らみ synth が ENOSPC で失敗していた。 `CDK_SKIP_BUNDLING=1` のときは
// `aws:cdk:bundling-stacks` を空にして全 stack のバンドルを skip する (= 検証は通り Docker 不要)。
// CLI の `-c` は `aws:` prefix を拒否するため context は code 側で設定する。 実バンドルは
// `make synth` / `make deploy` (env 無し) で従来どおり走る。
// 解決規則と各 env の意味は resolveBundlingStacks の doc comment を正本とする。
const bundlingStacks = resolveBundlingStacks(process.env);
if (bundlingStacks) {
  app.node.setContext("aws:cdk:bundling-stacks", bundlingStacks);
}

// Issue #2459: SaaS mode passes no `catalogSource` to `resolveAppConfig`, so any pack
// activated via `make pack-activate` would otherwise be silently ignored on `make deploy-saas`.
// Fail loud BEFORE config resolution so a stray activation never reaches a live SaaS deploy.
assertSaasSynthHasNoActivePacks(import.meta.dirname, process.env);

const config = resolveAppConfig({
  env: process.env,
  binDir: import.meta.dirname,
});

buildTenkaCloudApp(app, config);
