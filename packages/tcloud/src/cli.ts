#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { assertNoSecrets, type TcloudConfig } from "./config.js";
import { run } from "./run.js";
import { selectTokenStore } from "./token-store.js";

/**
 * Issue #2951: 現実の副作用を注入する薄い entrypoint。判断は全部 `run.ts` にある。
 *
 * `bunx` / `npx` は使わない (repo 方針)。この CLI は依存 0 本で、`bun run src/cli.ts` か
 * workspace の `bin` から直接動く。
 */

function configPath(): string {
  const base =
    process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.length > 0
      ? process.env.XDG_CONFIG_HOME
      : join(homedir(), ".config");
  return join(base, "tcloud", "config.json");
}

function readConfigFile(): unknown {
  try {
    return JSON.parse(readFileSync(configPath(), "utf8"));
  } catch {
    // 未設定は「設定が無い」であって障害ではない。parseConfig が何が足りないかを言う。
    return {};
  }
}

function writeConfigFile(config: TcloudConfig): void {
  // 二重の安全策: 型上 secret は入らないが、書く直前にも key 名で検査する。
  assertNoSecrets({ ...config });
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function hasCommand(command: string): boolean {
  return spawnSync("command", ["-v", command], { shell: true, encoding: "utf8" }).status === 0;
}

const exitCode = await run({
  argv: process.argv.slice(2),
  env: process.env,
  store: selectTokenStore({ platform: platform(), hasCommand }),
  fetchImpl: fetch,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
  readConfig: readConfigFile,
  writeConfig: writeConfigFile,
});

process.exit(exitCode);
