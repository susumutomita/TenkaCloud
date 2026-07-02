import * as fs from "node:fs";
import * as path from "node:path";
import type { Logger } from "winston";
import type { Config } from "../config/config-interface.js";

export interface ExpandOptions {
  /**
   * true なら env 未設定 + default 無しの placeholder を throw せず literal `${VAR}` のまま残す。
   * 用途: bin/infrastructure.ts は config 全体のうち `dynamoDbConfig` / `kmsConfig` 等の
   * 限定セクションしか consume しないので、無関係セクション (`${TenkaCloud_ADMIN_EMAIL}`
   * 等) の env 未設定で全体が落ちるのを避ける。consumer 側 (bin) が読まない field なら
   * literal `${VAR}` で残っていても無害。
   */
  tolerant?: boolean;
}

/**
 * `${VAR}` / `${VAR:-default}` placeholder を `secrets` (通常 process.env) で展開する。
 * jpki-api 互換の構文。env 値が定義されていれば優先、未定義なら default、両方無ければ throw
 * (tolerant=true 時は literal を残す)。
 *
 * 戻り値内の特殊文字 (改行・"" など) は JSON 文字列リテラルとして安全になるよう escape 済み
 * (JSON.stringify を使った後 trim)。これにより `${VAR}` を JSON の string value 内に埋めても
 * JSON.parse が壊れない。
 */
export function expandPlaceholders(
  content: string,
  secrets: NodeJS.ProcessEnv,
  opts: ExpandOptions = {},
): string {
  const placeholderRegex = /\$\{([^}]+)\}/g;
  return content.replace(placeholderRegex, (match: string, expression: string): string => {
    const [rawVarName, ...defaultParts] = expression.split(":-");
    const varName = rawVarName.trim();
    const defaultValue = defaultParts.length > 0 ? defaultParts.join(":-") : undefined;

    const value = secrets[varName];

    if (value !== undefined && value !== "") {
      return JSON.stringify(value).slice(1, -1);
    }

    if (defaultValue !== undefined) {
      return JSON.stringify(defaultValue).slice(1, -1);
    }

    if (opts.tolerant) {
      return match;
    }

    throw new Error(`Environment variable ${varName} is not defined and no default provided`);
  });
}

/**
 * Load config.json from the environment directory and replace ${VAR} / ${VAR:-default} placeholders
 * with values from process.env.
 */
export function processConfigFile(
  configPath: string,
  secrets: NodeJS.ProcessEnv,
  logger: Logger,
  opts: ExpandOptions = {},
): string {
  let content: string;
  try {
    content = fs.readFileSync(configPath, "utf-8");
  } catch {
    throw new Error(`Config file not found: ${configPath}`);
  }
  logger.info(`Read config file from ${configPath}`);

  const before = content;
  content = expandPlaceholders(content, secrets, opts);
  const replacedCount = (before.match(/\$\{[^}]+\}/g) ?? []).length;
  logger.info(`Replaced ${replacedCount} placeholder(s) in config`);
  return content;
}

/**
 * Parse config JSON string into a typed Config object.
 */
export function parseConfig(configContent: string, logger: Logger): Config {
  try {
    const config: Config = JSON.parse(configContent);
    logger.info("Parsed config JSON successfully");
    return config;
  } catch (error) {
    logger.error(`Error parsing config.json: ${(error as Error).message}`);
    throw error;
  }
}

/**
 * `environments/<envName>/config.json` を 1 ステップで読み出す facade。
 *
 *   - config.json が無ければ `undefined` (e.g., staging が未設定の場合)
 *   - placeholder は env で展開、未設定 + default 無しは tolerant=true なら literal `${VAR}` のまま残る
 *   - JSON parse して `Config` interface に揃える (JSON Schema validation はしない)
 *
 * tolerant が default なのは、 default 無し placeholder (= `accountId` の
 * `${AWS_ACCOUNT_ID}` 等) が creds 不在の synth / test で未展開のまま残ることを許すため。
 * consumer (resolve.ts) は展開済みの値だけを読む。 なお control-plane 系の設定は
 * config.json ではなく `CDK_PARAM_*` env 経由が正 (Issue #2197 で死に設定を削除済み)。
 */
export function loadConfig(envName: string, baseDir: string): Config | undefined {
  const configPath = path.resolve(baseDir, `../environments/${envName}/config.json`);
  if (!fs.existsSync(configPath)) {
    return undefined;
  }
  const noopLogger = {
    info: function info() {
      return this;
    },
    error: function error() {
      return this;
    },
  } as unknown as Logger;
  const content = processConfigFile(configPath, process.env, noopLogger, { tolerant: true });
  return parseConfig(content, noopLogger);
}
