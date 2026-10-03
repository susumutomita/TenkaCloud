/**
 * Issue #2953: human TenantAPI authorizer で access token を弾く opt-in flag key。
 *
 * **default OFF**。稼働中の authorizer の UPDATE であり、読み違えていれば全 tenant の console が
 * 401 になる。#2948 の `TenantMachine` role により緊急性は無くなっているので、非本番 stage の
 * live pre-flight (ID token 200 / access token 401) を済ませてから立てる。
 */
export const HUMAN_AUTHORIZER_REJECTS_ACCESS_TOKENS_FEATURE_KEY =
  "humanAuthorizerRejectsAccessTokens";

/** `features.humanAuthorizerRejectsAccessTokens` を読む唯一の accessor。未設定 / false は OFF。 */
export function isHumanAuthorizerAudiencePinEnabled(
  features: Readonly<Record<string, boolean>> | undefined,
): boolean {
  return features?.[HUMAN_AUTHORIZER_REJECTS_ACCESS_TOKENS_FEATURE_KEY] === true;
}

/**
 * Issue #3290: 非 AWS 問題の team 別クラウド認証情報 API を tenant API に開く flag key。
 * console の Team Cloud Credentials パネルと同じ key で、既定 OFF。
 */
const NON_AWS_RUNTIME_FEATURE_KEY = "nonAwsRuntime";

/** `features.nonAwsRuntime` を読む唯一の accessor。未設定 / false は OFF。 */
export function isNonAwsRuntimeEnabled(
  features: Readonly<Record<string, boolean>> | undefined,
): boolean {
  return features?.[NON_AWS_RUNTIME_FEATURE_KEY] === true;
}

export function resolveFeatures(
  env: NodeJS.ProcessEnv,
): Readonly<Record<string, boolean>> | undefined {
  const raw = env.CDK_PARAM_FEATURES;
  if (raw === undefined || raw.trim() === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`CDK_PARAM_FEATURES は JSON object で指定してください (got: ${raw})`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`CDK_PARAM_FEATURES は JSON object で指定してください (got: ${raw})`);
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "boolean") {
      throw new Error(
        `CDK_PARAM_FEATURES の "${key}" は boolean で指定してください (got: ${JSON.stringify(value)})`,
      );
    }
  }
  return parsed as Readonly<Record<string, boolean>>;
}
