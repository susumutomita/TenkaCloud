#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { resolveAppConfig } from "../lib/app-config";
import { buildTenkaCloudApp } from "../lib/app-wiring";

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

const config = resolveAppConfig({
  env: process.env,
  binDir: __dirname,
});

buildTenkaCloudApp(app, config);
