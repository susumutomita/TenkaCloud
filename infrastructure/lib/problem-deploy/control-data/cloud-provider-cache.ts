import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { type Client, createClient } from "@libsql/client/http";
import { type RuntimeEnvironment, selectBackend } from "./backend-config.js";
import type { CloudTableNames } from "./dynamodb-cloud-repository.js";
import { createSqlExecutorCache } from "./sql-executor-cache.js";
import type { SqlExecutor } from "./sql-port.js";

export interface CloudDataEnvironment extends RuntimeEnvironment {
  readonly EVENTS_TABLE_NAME?: string;
  readonly TEAMS_TABLE_NAME?: string;
  readonly DEPLOYMENTS_TABLE_NAME?: string;
}
export interface CloudDataOptions {
  readonly env: CloudDataEnvironment;
  readonly region?: string;
  readonly tables?: CloudTableNames;
}
function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`Missing cloud setting: ${name}`);
  return value;
}

/** One provider choice for API, workers and operators. Failed cold starts can retry, never fall back. */
export function createCloudProviderCache<T>(
  options: CloudDataOptions,
  adapters: {
    readonly turso: (sql: SqlExecutor) => T;
    readonly dynamodb: (document: DynamoDBDocumentClient, tables: CloudTableNames) => T;
  },
): () => Promise<T & { close(): void }> {
  const backend = selectBackend(options.env);
  let cached: Promise<T & { close(): void }> | undefined;
  return function acquire(): Promise<T & { close(): void }> {
    cached ??= (async (): Promise<T & { close(): void }> => {
      if (backend.kind === "turso") {
        const ssm = new SSMClient({ region: options.region, ignoreConfiguredEndpointUrls: true });
        let sqlClient: Client | undefined;
        try {
          const sql = await createSqlExecutorCache({
            env: options.env,
            ssm,
            createClient: (config) => {
              sqlClient = createClient(config);
              return sqlClient;
            },
          })();
          return {
            ...adapters.turso(sql),
            close: () => {
              sqlClient?.close();
              ssm.destroy();
              cached = undefined;
            },
          };
        } catch (error) {
          ssm.destroy();
          throw error;
        }
      }
      const tables = options.tables ?? {
        events: required(options.env.EVENTS_TABLE_NAME, "EVENTS_TABLE_NAME"),
        teams: required(options.env.TEAMS_TABLE_NAME, "TEAMS_TABLE_NAME"),
        deployments: required(options.env.DEPLOYMENTS_TABLE_NAME, "DEPLOYMENTS_TABLE_NAME"),
      };
      const client = new DynamoDBClient({
        region: options.region,
        ignoreConfiguredEndpointUrls: true,
      });
      const document = DynamoDBDocumentClient.from(client, {
        marshallOptions: { removeUndefinedValues: true },
      });
      return {
        ...adapters.dynamodb(document, tables),
        close: () => {
          client.destroy();
          cached = undefined;
        },
      };
    })().catch((error: unknown) => {
      cached = undefined;
      throw error;
    });
    return cached;
  };
}

/** Snapshot only the declared contract; operator callers supply their selected region explicitly. */
export function runtimeCloudDataOptions(): CloudDataOptions {
  return {
    region: process.env.AWS_REGION,
    env: {
      CONTROL_DATA_BACKEND: process.env.CONTROL_DATA_BACKEND,
      TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL,
      TURSO_AUTH_TOKEN_PARAMETER_NAME: process.env.TURSO_AUTH_TOKEN_PARAMETER_NAME,
      EVENTS_TABLE_NAME: process.env.EVENTS_TABLE_NAME,
      TEAMS_TABLE_NAME: process.env.TEAMS_TABLE_NAME,
      DEPLOYMENTS_TABLE_NAME: process.env.DEPLOYMENTS_TABLE_NAME,
    },
  };
}
