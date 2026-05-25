/**
 * Issue #1305: CLI Phase 2 — API base URL resolution.
 *
 * TenkaCloud は plane ごとに別 API stack を持つ (Control / Tenant / Deploy / Event)。
 * CLI からはそれぞれ別の host を叩くため、 env で個別注入する。
 *
 * - TENKACLOUD_API_BASE_CONTROL  (= System Admin / tenants CRUD)
 * - TENKACLOUD_API_BASE_TENANT   (= Tenant Admin / events / idp / audit)
 * - TENKACLOUD_API_BASE_DEPLOY   (= Problem deploy worker / status / logs)
 * - TENKACLOUD_API_BASE_EVENT    (= Scoreboard / score-events polling)
 *
 * 一括 default URL は提供しない (= 環境ごとに違うため。 sigh の fall back は事故源)。
 * 未設定の env を要求した場合は loud に fail する。
 */

export type ApiScope = "control" | "tenant" | "deploy" | "event";

const ENV_KEY: Record<ApiScope, string> = {
  control: "TENKACLOUD_API_BASE_CONTROL",
  tenant: "TENKACLOUD_API_BASE_TENANT",
  deploy: "TENKACLOUD_API_BASE_DEPLOY",
  event: "TENKACLOUD_API_BASE_EVENT",
};

export class MissingApiBaseError extends Error {
  constructor(scope: ApiScope) {
    super(
      `API base URL が未設定です: ${ENV_KEY[scope]} を設定してください\n` +
        `  例: export ${ENV_KEY[scope]}=https://abc123.execute-api.ap-northeast-1.amazonaws.com`,
    );
    this.name = "MissingApiBaseError";
  }
}

export function resolveApiBase(scope: ApiScope, env: NodeJS.ProcessEnv = process.env): string {
  const key = ENV_KEY[scope];
  const value = env[key];
  if (!value || value.trim().length === 0) {
    throw new MissingApiBaseError(scope);
  }
  return value.replace(/\/$/, "");
}

export function apiEnvKey(scope: ApiScope): string {
  return ENV_KEY[scope];
}
