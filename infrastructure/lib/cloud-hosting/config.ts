export type CloudControlDataConfiguration =
  | { readonly kind: "dynamodb" }
  | {
      readonly kind: "turso";
      readonly databaseUrl: string;
      readonly authTokenParameterName: string;
    };

/** Preserve the original cloud backend selection and fail before any deployment. */
export function cloudControlDataConfiguration(
  env: NodeJS.ProcessEnv,
): CloudControlDataConfiguration {
  const kind = env.CDK_PARAM_CONTROL_DATA_BACKEND?.trim().toLowerCase() || "dynamodb";
  if (kind === "dynamodb") return { kind };
  if (kind !== "turso")
    throw new Error("CDK_PARAM_CONTROL_DATA_BACKEND must be one of dynamodb|turso.");
  const rawUrl = env.CDK_PARAM_TURSO_DATABASE_URL?.trim();
  const authTokenParameterName = env.CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME?.trim();
  if (!rawUrl || !authTokenParameterName)
    throw new Error(
      "CDK_PARAM_TURSO_DATABASE_URL and CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME are required when CDK_PARAM_CONTROL_DATA_BACKEND is turso.",
    );
  let url: URL;
  try {
    // The original libsql:// input selects the same secure HTTP endpoint.
    url = new URL(rawUrl.replace(/^libsql:\/\//iu, "https://"));
  } catch {
    throw new Error("CDK_PARAM_TURSO_DATABASE_URL must be a libsql:// or https:// database URL.");
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(
      "CDK_PARAM_TURSO_DATABASE_URL must be a libsql:// or https:// database URL without credentials, path, query or fragment.",
    );
  if (
    !/^\/(?!aws(?:\/|$)|ssm(?:\/|$))[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)*$/iu.test(authTokenParameterName)
  )
    throw new Error(
      "CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME must name one exact rooted SSM parameter, without wildcards.",
    );
  return { kind, databaseUrl: url.origin, authTokenParameterName };
}

/** Preserve #2959's exact opt-in from the original app-config/resolve.ts. */
export function retainCloudDataTables(env: NodeJS.ProcessEnv): boolean {
  return env.CDK_PARAM_RETAIN_DATA_TABLES === "true";
}
