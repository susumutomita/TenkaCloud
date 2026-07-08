import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { type Client, createClient } from "@libsql/client/http";
import { createEventsRepository } from "./events-repository.js";
import { createFeatureFlagsRepository } from "./feature-flags-repository.js";
import { initializeControlDataSchema, LibsqlExecutor } from "./libsql-executor.js";
import {
  MirroredEventsRepository,
  MirroredFeatureFlagsRepository,
  MirroredNotificationsRepository,
  MirroredTeamsRepository,
} from "./mirrored-repositories.js";
import { createNotificationsRepository } from "./notifications-repository.js";
import { createTeamsRepository } from "./teams-repository.js";
import type {
  EventsRepository,
  FeatureFlagsRepository,
  NotificationsRepository,
  SqlExecutor,
  TeamsRepository,
} from "./types.js";

export interface ControlDataRepositories {
  readonly events: EventsRepository;
  readonly teams: TeamsRepository;
  readonly notifications: NotificationsRepository;
  readonly featureFlags: FeatureFlagsRepository;
}

export interface ControlDataRuntimeInput {
  readonly ddb: DynamoDBDocumentClient;
  readonly eventsTableName: string;
  readonly teamsTableName: string;
}

export interface ControlDataRuntime {
  readonly resolveRepositories: (
    input: ControlDataRuntimeInput,
  ) => Promise<ControlDataRepositories>;
  readonly resolveEventsRepository: (input: {
    readonly ddb: DynamoDBDocumentClient;
    readonly eventsTableName: string;
    readonly teamsTableName?: string;
  }) => Promise<EventsRepository>;
  readonly resolveTeamsRepository: (input: {
    readonly ddb: DynamoDBDocumentClient;
    readonly teamsTableName: string;
  }) => Promise<TeamsRepository>;
  readonly resolveNotificationsRepository: (input: {
    readonly ddb: DynamoDBDocumentClient;
    readonly eventsTableName: string;
  }) => Promise<NotificationsRepository>;
  readonly resolveFeatureFlagsRepository: (input: {
    readonly ddb: DynamoDBDocumentClient;
    readonly eventsTableName: string;
  }) => Promise<FeatureFlagsRepository>;
}

export interface RuntimeEnvironment {
  readonly CONTROL_DATA_BACKEND?: string;
  readonly TURSO_DATABASE_URL?: string;
  readonly TURSO_AUTH_TOKEN_PARAMETER_NAME?: string;
}

export interface RuntimeDependencies {
  readonly env: RuntimeEnvironment;
  readonly ssm: Pick<SSMClient, "send">;
  readonly createClient: (config: { readonly url: string; readonly authToken: string }) => Client;
}

type SelectedBackend = "dynamodb" | "turso" | "sql";

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${name} is required when CONTROL_DATA_BACKEND is turso/sql.`);
  }
  return normalized;
}

function selectBackend(env: RuntimeEnvironment): SelectedBackend {
  const backend = env.CONTROL_DATA_BACKEND?.trim().toLowerCase() || "dynamodb";
  if (backend === "dynamodb" || backend === "turso" || backend === "sql") return backend;
  throw new Error(
    `Unknown CONTROL_DATA_BACKEND="${env.CONTROL_DATA_BACKEND}" ` +
      "(expected one of: dynamodb, turso, sql).",
  );
}

/**
 * Builds a cold-start runtime. The returned runtime caches the decrypted token
 * and libSQL client as a SqlExecutor; warm invocations do not call SSM or rerun
 * schema DDL, while aggregate repository objects remain request-scoped.
 */
export function createControlDataRuntime(deps: RuntimeDependencies): ControlDataRuntime {
  let cachedSql: Promise<SqlExecutor> | undefined;

  function acquireSqlExecutor(): Promise<SqlExecutor> {
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
  }

  async function resolveEventsRepository(input: {
    readonly ddb: DynamoDBDocumentClient;
    readonly eventsTableName: string;
    readonly teamsTableName?: string;
  }): Promise<EventsRepository> {
    const backend = selectBackend(deps.env);
    if (backend === "dynamodb") {
      return createEventsRepository(backend, {
        ddb: input.ddb,
        eventsTableName: input.eventsTableName,
        // #2437: createEventWithTeams (atomic event+teams transaction) writes
        // the Teams table through the Events repository.
        teamsTableName: input.teamsTableName,
      });
    }
    const sql = await acquireSqlExecutor();
    return new MirroredEventsRepository(
      createEventsRepository("dynamodb", {
        ddb: input.ddb,
        eventsTableName: input.eventsTableName,
        teamsTableName: input.teamsTableName,
      }),
      createEventsRepository(backend, { sql }),
    );
  }

  async function resolveTeamsRepository(input: {
    readonly ddb: DynamoDBDocumentClient;
    readonly teamsTableName: string;
  }): Promise<TeamsRepository> {
    const backend = selectBackend(deps.env);
    if (backend === "dynamodb") {
      return createTeamsRepository(backend, {
        ddb: input.ddb,
        teamsTableName: input.teamsTableName,
      });
    }
    const sql = await acquireSqlExecutor();
    return new MirroredTeamsRepository(
      createTeamsRepository("dynamodb", {
        ddb: input.ddb,
        teamsTableName: input.teamsTableName,
      }),
      createTeamsRepository(backend, { sql }),
    );
  }

  async function resolveNotificationsRepository(input: {
    readonly ddb: DynamoDBDocumentClient;
    readonly eventsTableName: string;
  }): Promise<NotificationsRepository> {
    const backend = selectBackend(deps.env);
    if (backend === "dynamodb") {
      return createNotificationsRepository(backend, {
        ddb: input.ddb,
        eventsTableName: input.eventsTableName,
      });
    }
    const sql = await acquireSqlExecutor();
    return new MirroredNotificationsRepository(
      createNotificationsRepository("dynamodb", {
        ddb: input.ddb,
        eventsTableName: input.eventsTableName,
      }),
      createNotificationsRepository(backend, { sql }),
    );
  }

  async function resolveFeatureFlagsRepository(input: {
    readonly ddb: DynamoDBDocumentClient;
    readonly eventsTableName: string;
  }): Promise<FeatureFlagsRepository> {
    const backend = selectBackend(deps.env);
    if (backend === "dynamodb") {
      return createFeatureFlagsRepository(backend, {
        ddb: input.ddb,
        eventsTableName: input.eventsTableName,
      });
    }
    const sql = await acquireSqlExecutor();
    return new MirroredFeatureFlagsRepository(
      createFeatureFlagsRepository("dynamodb", {
        ddb: input.ddb,
        eventsTableName: input.eventsTableName,
      }),
      createFeatureFlagsRepository(backend, { sql }),
    );
  }

  return {
    resolveRepositories: async (input) => {
      const [events, teams, notifications, featureFlags] = await Promise.all([
        resolveEventsRepository(input),
        resolveTeamsRepository(input),
        resolveNotificationsRepository(input),
        resolveFeatureFlagsRepository(input),
      ]);
      return { events, teams, notifications, featureFlags };
    },
    resolveEventsRepository,
    resolveTeamsRepository,
    resolveNotificationsRepository,
    resolveFeatureFlagsRepository,
  };
}

/**
 * Backward-compatible full resolver factory. Prefer {@link createControlDataRuntime}
 * for aggregate-scoped resolution.
 */
export function createControlDataRepositoryResolver(
  deps: RuntimeDependencies,
): (input: ControlDataRuntimeInput) => Promise<ControlDataRepositories> {
  const runtime = createControlDataRuntime(deps);
  return (input) => runtime.resolveRepositories(input);
}

/** Module singleton backed by process.env, real SSM, and the real libSQL client. */
export const controlDataRuntime = createControlDataRuntime({
  env: process.env,
  ssm: new SSMClient({}),
  createClient,
});

export const resolveControlDataRepositories =
  controlDataRuntime.resolveRepositories.bind(controlDataRuntime);
