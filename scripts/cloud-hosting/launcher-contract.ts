/** Versioned launcher/source contract. Validate legacy-only options before any AWS operation. */
export function assertCurrentLauncherConfiguration(env: NodeJS.ProcessEnv): void {
  if (env.SOURCE_CONTRACT !== "current-cloud-v1")
    throw new Error("This checkout requires SourceContract=current-cloud-v1.");
  if (!["deploy", "destroy"].includes(env.ACTION ?? "deploy"))
    throw new Error(
      "Current hosting supports deploy/destroy. destroy-all belongs only to the fixed historical source contract; current retained data is never purged by the launcher.",
    );
  if (
    (env.CONTROL_DATA_BACKEND ?? "dynamodb") !== "dynamodb" ||
    env.TURSO_DATABASE_URL ||
    env.TURSO_AUTH_TOKEN_PARAMETER_NAME
  )
    throw new Error(
      "Current cloud hosting requires DynamoDB; Turso settings are supported only by historical sources.",
    );
  if (env.DEPLOY_EXTERNAL_ID)
    throw new Error(
      "Current hosting creates its installation ExternalId through competitor account registration; DeployExternalId is a historical-source option.",
    );
  if (
    [env.DYNAMO_READ_CAPACITY ?? "1", env.DYNAMO_WRITE_CAPACITY ?? "1"].some(
      (value) => value !== "1",
    )
  )
    throw new Error(
      "Current tables use on-demand DynamoDB; provisioned capacity overrides require historical sources.",
    );
  if (!["auto", "true"].includes(env.RETAIN_DATA_TABLES ?? "auto"))
    throw new Error("Current hosting retains event data; RetainDataTables=false is unsupported.");
}
