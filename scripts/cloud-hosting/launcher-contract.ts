import { cloudControlDataConfiguration } from "../../infrastructure/lib/cloud-hosting/config.js";

/** Validate current launcher options before any AWS operation. */
export function assertCurrentLauncherConfiguration(env: NodeJS.ProcessEnv): void {
  const action = env.ACTION ?? "deploy";
  if (!["deploy", "destroy", "destroy-all"].includes(action))
    throw new Error("Current hosting supports deploy/destroy/destroy-all.");
  // Teardown resolves the provider from deployed stack Outputs, never desired configuration.
  if (action === "deploy")
    cloudControlDataConfiguration({
      CDK_PARAM_CONTROL_DATA_BACKEND: env.CONTROL_DATA_BACKEND,
      CDK_PARAM_TURSO_DATABASE_URL: env.TURSO_DATABASE_URL,
      CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME: env.TURSO_AUTH_TOKEN_PARAMETER_NAME,
    });
  if (!["false", "true"].includes(env.RETAIN_DATA_TABLES ?? "false"))
    throw new Error("RetainDataTables must be false (default) or true.");
}
