import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { type Client, createClient } from "@libsql/client/http";
import type { RuntimeEnvironment } from "./backend-config.js";
import { initializeControlDataSchema, LibsqlExecutor } from "./libsql-executor.js";
import type { SqlExecutor } from "./sql-port.js";

/**
 * The historical SQL-executor cold-start cache. One acquire() per runtime:
 * the decrypted Turso
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

/**
 * What actually went wrong, in one line a CloudWatch reader can act on.
 *
 * Handlers log `err.message` and nothing else, and every route in front of this
 * cache answers a failure with a bare `internal_error`. An AWS SDK error's
 * `message` on its own frequently omits the two things that identify the
 * failure — the error's `name` (`AccessDeniedException` vs
 * `ParameterNotFound`) and the HTTP status — so the operator was left with a
 * 500 and no way to tell a missing IAM grant from an expired token.
 *
 * Carries `name`, `message` and the status code only. Never the token, and
 * never the whole error object: the point is a legible line, not a dump.
 */
function describeCause(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  const suffix = status === undefined ? "" : ` (HTTP ${status})`;
  return `${err.name}: ${err.message}${suffix}`;
}

function redactToken(message: string, token: string): string {
  // Client/header validation can quote or URL-encode its input in diagnostics.
  const forms = [token, JSON.stringify(token).slice(1, -1), encodeURIComponent(token)];
  return forms.reduce((text, secret) => text.split(secret).join("[REDACTED]"), message);
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
      const response = await deps.ssm
        .send(new GetParameterCommand({ Name: parameterName, WithDecryption: true }))
        .catch((err: unknown) => {
          throw new Error(
            `Turso auth token could not be read from SSM SecureString ${parameterName}. ` +
              "GetParameter(WithDecryption) needs ssm:GetParameter on that parameter; the " +
              "decrypt under alias/aws/ssm is authorised by the AWS managed key itself. " +
              `Underlying: ${describeCause(err)}`,
          );
        });
      if (response.Parameter?.Type !== "SecureString") {
        throw new Error(`Turso auth token must be an SSM SecureString: ${parameterName}`);
      }
      const authToken = response.Parameter.Value?.trim();
      if (!authToken) {
        throw new Error(`Turso auth token not found in SSM SecureString: ${parameterName}`);
      }

      let client: Client;
      try {
        client = deps.createClient({ url, authToken });
      } catch (error) {
        throw new Error(
          redactToken(
            `Turso control-data client initialization failed. Underlying: ${describeCause(error)}`,
            authToken,
          ),
        );
      }
      await initializeControlDataSchema(client).catch((err: unknown) => {
        client.close();
        throw new Error(
          redactToken(
            `Turso control-data schema bootstrap failed against ${url}. ` +
              `A 401 / UNAUTHORIZED here means the token in ${parameterName} is rejected by that ` +
              "database (expired, revoked, or issued for a different one). " +
              `Underlying: ${describeCause(err)}`,
            authToken,
          ),
        );
      });
      return new LibsqlExecutor(client);
    })().catch((err: unknown) => {
      cachedSql = undefined;
      throw err;
    });
    return cachedSql;
  };
}

export function createDefaultSqlExecutorCache(
  env: RuntimeEnvironment = {
    CONTROL_DATA_BACKEND: process.env.CONTROL_DATA_BACKEND,
    TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL,
    TURSO_AUTH_TOKEN_PARAMETER_NAME: process.env.TURSO_AUTH_TOKEN_PARAMETER_NAME,
  },
): () => Promise<SqlExecutor> {
  return createSqlExecutorCache({
    env,
    ssm: new SSMClient({ ignoreConfiguredEndpointUrls: true }),
    createClient,
  });
}
