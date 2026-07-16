import { GetParameterCommand, type SSMClient } from "@aws-sdk/client-ssm";
import type { Client } from "@libsql/client/http";
import type { RuntimeEnvironment } from "./backend-config.js";
import { initializeControlDataSchema, LibsqlExecutor } from "./libsql-executor.js";
import type { SqlExecutor } from "./types.js";

/**
 * [#2527 Slice 4] The SQL-executor cold-start cache, extracted verbatim from
 * `runtime-repositories.ts`. One acquire() per runtime: the decrypted Turso
 * token and libSQL client are fetched/built once and reused across warm
 * invocations; a failed SSM/token fetch self-evicts so the next invocation
 * retries instead of caching the rejection (fail-loud, never fall back).
 */

export interface RuntimeDependencies {
  readonly env: RuntimeEnvironment;
  readonly ssm: Pick<SSMClient, "send">;
  readonly createClient: (config: { readonly url: string; readonly authToken: string }) => Client;
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${name} is required when CONTROL_DATA_BACKEND is turso.`);
  }
  return normalized;
}

export function createSqlExecutorCache(deps: RuntimeDependencies): () => Promise<SqlExecutor> {
  let cachedSql: Promise<SqlExecutor> | undefined;

  return function acquireSqlExecutor(): Promise<SqlExecutor> {
    cachedSql ??= (async () => {
      const url = required(deps.env.TURSO_DATABASE_URL, "TURSO_DATABASE_URL");
      const parameterName = required(
        deps.env.TURSO_AUTH_TOKEN_PARAMETER_NAME,
        "TURSO_AUTH_TOKEN_PARAMETER_NAME",
      );
      const response = await deps.ssm.send(
        new GetParameterCommand({ Name: parameterName, WithDecryption: true }),
      );
      const authToken = response.Parameter?.Value?.trim();
      if (!authToken) {
        throw new Error(`Turso auth token not found in SSM SecureString: ${parameterName}`);
      }

      const client = deps.createClient({ url, authToken });
      await initializeControlDataSchema(client);
      return new LibsqlExecutor(client);
    })().catch((err: unknown) => {
      cachedSql = undefined;
      throw err;
    });
    return cachedSql;
  };
}
