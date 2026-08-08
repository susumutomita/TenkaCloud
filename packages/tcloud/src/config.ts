/**
 * Issue #2951: 非機密の CLI 設定。
 *
 * ここに置いてよいのは「どこに繋ぐか」と「どの client か」だけである。client secret は
 * この設定にも、この設定が書かれるファイルにも **絶対に載せない**。secret の受け渡しは
 * 引数か環境変数だけで、保存は OS keychain 上の access token に限る。
 */

export interface TcloudConfig {
  /** tenant stack の CfnOutput `MachineApiUrl`。 */
  readonly machineApiUrl: string;
  /** Cognito Hosted UI domain の `/oauth2/token`。 */
  readonly tokenUrl: string;
  readonly clientId: string;
  /** この credential が要求する scope 一式 (capability + tenant binding)。 */
  readonly scopes: readonly string[];
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const REQUIRED_FIELDS = ["machineApiUrl", "tokenUrl", "clientId"] as const;

/** 設定ファイル / 環境変数から読んだ生値を検証する。欠けているものは名指しで落とす。 */
export function parseConfig(raw: unknown): TcloudConfig {
  if (!raw || typeof raw !== "object") {
    throw new ConfigError("設定が読み込めません (JSON object ではありません)。");
  }
  const candidate = raw as Record<string, unknown>;
  const missing = REQUIRED_FIELDS.filter(
    (field) => typeof candidate[field] !== "string" || (candidate[field] as string).length === 0,
  );
  if (missing.length > 0) {
    throw new ConfigError(
      `設定に ${missing.join(", ")} がありません。\`tcloud auth login\` で設定するか、` +
        "TCLOUD_MACHINE_API_URL / TCLOUD_TOKEN_URL / TCLOUD_CLIENT_ID を設定してください。",
    );
  }
  const scopes = Array.isArray(candidate.scopes)
    ? candidate.scopes.filter((value): value is string => typeof value === "string")
    : [];
  if (scopes.length === 0) {
    throw new ConfigError(
      "設定に scopes がありません。capability scope と tenant binding scope " +
        "(tc-tenant-<tenantId>/bind) の両方が必要です。",
    );
  }
  if (!scopes.some((scope) => scope.endsWith("/bind"))) {
    throw new ConfigError(
      "scopes に tenant binding scope (tc-tenant-<tenantId>/bind) がありません。" +
        "binding が無い token は machine principal として解決されません。",
    );
  }
  return {
    machineApiUrl: candidate.machineApiUrl as string,
    tokenUrl: candidate.tokenUrl as string,
    clientId: candidate.clientId as string,
    scopes,
  };
}

/** 設定ファイルに書き出す前に secret 相当が混ざっていないことを確認する。 */
export function assertNoSecrets(config: Record<string, unknown>): void {
  const forbidden = Object.keys(config).filter((key) => /secret|password|token$/i.test(key));
  if (forbidden.length > 0) {
    throw new ConfigError(
      `設定ファイルに保存できない項目です: ${forbidden.join(", ")} (secret は保存しません)。`,
    );
  }
}

export interface ConfigEnv {
  readonly TCLOUD_MACHINE_API_URL?: string;
  readonly TCLOUD_TOKEN_URL?: string;
  readonly TCLOUD_CLIENT_ID?: string;
  readonly TCLOUD_SCOPES?: string;
}

/** 環境変数から設定を組み立てる (CI 用)。1 つでも欠けていれば undefined。 */
export function configFromEnv(env: ConfigEnv): TcloudConfig | undefined {
  if (!env.TCLOUD_MACHINE_API_URL || !env.TCLOUD_TOKEN_URL || !env.TCLOUD_CLIENT_ID) {
    return undefined;
  }
  return parseConfig({
    machineApiUrl: env.TCLOUD_MACHINE_API_URL,
    tokenUrl: env.TCLOUD_TOKEN_URL,
    clientId: env.TCLOUD_CLIENT_ID,
    scopes: (env.TCLOUD_SCOPES ?? "").split(/\s+/).filter(Boolean),
  });
}
