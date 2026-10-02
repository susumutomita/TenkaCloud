/** Explicit destroy-all reset uses only the provider identity captured from the deployed stack. */
export async function purgeTursoControlData(target: {
  readonly databaseUrl: string;
  readonly parameterName: string;
  readonly region: string;
}): Promise<void> {
  const [{ SSMClient }, { createClient }, { createSqlExecutorCache }, { resetControlData }] =
    await Promise.all([
      import("@aws-sdk/client-ssm"),
      import("@libsql/client/http"),
      import("../../infrastructure/lib/problem-deploy/control-data/sql-executor-cache"),
      import("../../infrastructure/lib/problem-deploy/control-data/sql-reset"),
    ]);
  const ssm = new SSMClient({ region: target.region, ignoreConfiguredEndpointUrls: true });
  let client: ReturnType<typeof createClient> | undefined;
  try {
    const sql = await createSqlExecutorCache({
      env: {
        CONTROL_DATA_BACKEND: "turso",
        TURSO_DATABASE_URL: target.databaseUrl,
        TURSO_AUTH_TOKEN_PARAMETER_NAME: target.parameterName,
      },
      ssm,
      createClient: (config) => {
        client = createClient(config);
        return client;
      },
    })();
    await resetControlData(sql);
  } finally {
    client?.close();
    ssm.destroy();
  }
}
