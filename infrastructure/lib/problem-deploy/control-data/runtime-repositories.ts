import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { type Client, createClient } from "@libsql/client/http";
import { createCompetitorAccountsRepository } from "./competitor-accounts-repository.js";
import { createDeploymentsRepository } from "./deployments-repository.js";
import { createEventsRepository } from "./events-repository.js";
import { createFeatureFlagsRepository } from "./feature-flags-repository.js";
import { initializeControlDataSchema, LibsqlExecutor } from "./libsql-executor.js";
import {
  MirroredCompetitorAccountsRepository,
  MirroredDeploymentsRepository,
  MirroredEventsRepository,
  MirroredFeatureFlagsRepository,
  MirroredNotificationsRepository,
  MirroredProblemEndpointsRepository,
  MirroredSamlConfigRepository,
  MirroredTeamsRepository,
} from "./mirrored-repositories.js";
import { createNotificationsRepository } from "./notifications-repository.js";
import { createProblemEndpointsRepository } from "./problem-endpoints-repository.js";
import { createSamlConfigRepository } from "./saml-config-repository.js";
import { createTeamsRepository } from "./teams-repository.js";
import type {
  CompetitorAccountsRepository,
  ControlDataBackend,
  DeploymentsRepository,
  EventsRepository,
  FeatureFlagsRepository,
  NotificationsRepository,
  ProblemEndpointsRepository,
  SamlConfigRepository,
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
  readonly ddb?: DynamoDBDocumentClient;
  readonly eventsTableName?: string;
  readonly teamsTableName?: string;
}

export interface ControlDataRuntime {
  /**
   * DDB native TTL が無い backend では generic-scoring reconciler tick が
   * Events / Teams / Notifications の prune を駆動する。
   */
  readonly needsManualPrune: () => boolean;
  readonly resolveRepositories: (
    input: ControlDataRuntimeInput,
  ) => Promise<ControlDataRepositories>;
  readonly resolveEventsRepository: (input: {
    readonly ddb?: DynamoDBDocumentClient;
    readonly eventsTableName?: string;
    readonly teamsTableName?: string;
  }) => Promise<EventsRepository>;
  readonly resolveTeamsRepository: (input: {
    readonly ddb?: DynamoDBDocumentClient;
    readonly teamsTableName?: string;
  }) => Promise<TeamsRepository>;
  readonly resolveNotificationsRepository: (input: {
    readonly ddb?: DynamoDBDocumentClient;
    readonly eventsTableName?: string;
  }) => Promise<NotificationsRepository>;
  readonly resolveFeatureFlagsRepository: (input: {
    readonly ddb?: DynamoDBDocumentClient;
    readonly eventsTableName?: string;
  }) => Promise<FeatureFlagsRepository>;
  /**
   * [Issue #2441 / Phase B4] Cold-start resolver for the Deployments seam.
   * Deployments now participates in all five `CONTROL_DATA_BACKEND` values:
   * `dynamodb` returns DDB, `turso` / `sql` return pure SQL, and mirror modes
   * write through DDB then SQL while serving reads/scans from canonical DDB.
   */
  readonly resolveDeploymentsRepository: (input: {
    readonly ddb?: DynamoDBDocumentClient;
    readonly deploymentsTableName?: string;
  }) => Promise<DeploymentsRepository>;
  /**
   * [Issue #2442 / Phase C1] Cold-start resolver for the ProblemEndpoints seam.
   * Participates in all five `CONTROL_DATA_BACKEND` values like Deployments:
   * `dynamodb` returns DDB, `turso` / `sql` return pure SQL, and mirror modes
   * write through DDB then SQL while serving reads from canonical DDB.
   */
  readonly resolveProblemEndpointsRepository: (input: {
    readonly ddb?: DynamoDBDocumentClient;
    readonly endpointsTableName?: string;
  }) => Promise<ProblemEndpointsRepository>;
  /**
   * [Issue #2442 / Phase C2] Cold-start resolver for the CompetitorAccounts
   * seam. Participates in all five `CONTROL_DATA_BACKEND` values like
   * ProblemEndpoints: `dynamodb` returns DDB, `turso` / `sql` return pure SQL,
   * and mirror modes write through DDB then SQL while serving reads/scans
   * from canonical DDB.
   */
  readonly resolveCompetitorAccountsRepository: (input: {
    readonly ddb?: DynamoDBDocumentClient;
    readonly competitorAccountsTableName?: string;
  }) => Promise<CompetitorAccountsRepository>;
  /**
   * [Issue #2442 / Phase C2] Cold-start resolver for the SamlConfig
   * sub-aggregate (co-habits the CompetitorAccounts DynamoDB table's
   * partition; same five-value participation as {@link resolveCompetitorAccountsRepository}).
   */
  readonly resolveSamlConfigRepository: (input: {
    readonly ddb?: DynamoDBDocumentClient;
    readonly competitorAccountsTableName?: string;
  }) => Promise<SamlConfigRepository>;
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

type SqlDialect = Extract<ControlDataBackend, "turso" | "sql">;
type SelectedBackend =
  | { readonly kind: "dynamodb" }
  | { readonly kind: "pure"; readonly dialect: SqlDialect }
  | { readonly kind: "mirror"; readonly dialect: SqlDialect };

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(
      `${name} is required when CONTROL_DATA_BACKEND is turso/sql/turso-mirror/sql-mirror.`,
    );
  }
  return normalized;
}

function selectBackend(env: RuntimeEnvironment): SelectedBackend {
  const backend = env.CONTROL_DATA_BACKEND?.trim().toLowerCase() || "dynamodb";
  if (backend === "dynamodb") return { kind: "dynamodb" };
  if (backend === "turso" || backend === "sql") return { kind: "pure", dialect: backend };
  if (backend === "turso-mirror") return { kind: "mirror", dialect: "turso" };
  if (backend === "sql-mirror") return { kind: "mirror", dialect: "sql" };
  throw new Error(
    `Unknown CONTROL_DATA_BACKEND="${env.CONTROL_DATA_BACKEND}" ` +
      "(expected one of: dynamodb, turso, sql, turso-mirror, sql-mirror).",
  );
}

function requireDdbAndTableName(
  ddb: DynamoDBDocumentClient | undefined,
  tableName: string | undefined,
  tableNameLabel:
    | "eventsTableName"
    | "teamsTableName"
    | "deploymentsTableName"
    | "endpointsTableName"
    | "competitorAccountsTableName",
  backendKind: "dynamodb" | "mirror",
): { readonly ddb: DynamoDBDocumentClient; readonly tableName: string } {
  if (!ddb || !tableName) {
    throw new Error(`${backendKind} backend requires ddb/${tableNameLabel}.`);
  }
  return { ddb, tableName };
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
    readonly ddb?: DynamoDBDocumentClient;
    readonly eventsTableName?: string;
    readonly teamsTableName?: string;
  }): Promise<EventsRepository> {
    const backend = selectBackend(deps.env);
    if (backend.kind === "pure") {
      const sql = await acquireSqlExecutor();
      return createEventsRepository(backend.dialect, { sql });
    }

    const requiredInput = requireDdbAndTableName(
      input.ddb,
      input.eventsTableName,
      "eventsTableName",
      backend.kind,
    );
    if (backend.kind === "dynamodb") {
      return createEventsRepository("dynamodb", {
        ddb: requiredInput.ddb,
        eventsTableName: requiredInput.tableName,
        // #2437: createEventWithTeams (atomic event+teams transaction) writes
        // the Teams table through the Events repository.
        teamsTableName: input.teamsTableName,
      });
    }
    const sql = await acquireSqlExecutor();
    return new MirroredEventsRepository(
      createEventsRepository("dynamodb", {
        ddb: requiredInput.ddb,
        eventsTableName: requiredInput.tableName,
        teamsTableName: input.teamsTableName,
      }),
      createEventsRepository(backend.dialect, { sql }),
    );
  }

  async function resolveTeamsRepository(input: {
    readonly ddb?: DynamoDBDocumentClient;
    readonly teamsTableName?: string;
  }): Promise<TeamsRepository> {
    const backend = selectBackend(deps.env);
    if (backend.kind === "pure") {
      const sql = await acquireSqlExecutor();
      return createTeamsRepository(backend.dialect, { sql });
    }

    const requiredInput = requireDdbAndTableName(
      input.ddb,
      input.teamsTableName,
      "teamsTableName",
      backend.kind,
    );
    if (backend.kind === "dynamodb") {
      return createTeamsRepository("dynamodb", {
        ddb: requiredInput.ddb,
        teamsTableName: requiredInput.tableName,
      });
    }
    const sql = await acquireSqlExecutor();
    return new MirroredTeamsRepository(
      createTeamsRepository("dynamodb", {
        ddb: requiredInput.ddb,
        teamsTableName: requiredInput.tableName,
      }),
      createTeamsRepository(backend.dialect, { sql }),
    );
  }

  async function resolveNotificationsRepository(input: {
    readonly ddb?: DynamoDBDocumentClient;
    readonly eventsTableName?: string;
  }): Promise<NotificationsRepository> {
    const backend = selectBackend(deps.env);
    if (backend.kind === "pure") {
      const sql = await acquireSqlExecutor();
      return createNotificationsRepository(backend.dialect, { sql });
    }

    const requiredInput = requireDdbAndTableName(
      input.ddb,
      input.eventsTableName,
      "eventsTableName",
      backend.kind,
    );
    if (backend.kind === "dynamodb") {
      return createNotificationsRepository("dynamodb", {
        ddb: requiredInput.ddb,
        eventsTableName: requiredInput.tableName,
      });
    }
    const sql = await acquireSqlExecutor();
    return new MirroredNotificationsRepository(
      createNotificationsRepository("dynamodb", {
        ddb: requiredInput.ddb,
        eventsTableName: requiredInput.tableName,
      }),
      createNotificationsRepository(backend.dialect, { sql }),
    );
  }

  async function resolveFeatureFlagsRepository(input: {
    readonly ddb?: DynamoDBDocumentClient;
    readonly eventsTableName?: string;
  }): Promise<FeatureFlagsRepository> {
    const backend = selectBackend(deps.env);
    if (backend.kind === "pure") {
      const sql = await acquireSqlExecutor();
      return createFeatureFlagsRepository(backend.dialect, { sql });
    }

    const requiredInput = requireDdbAndTableName(
      input.ddb,
      input.eventsTableName,
      "eventsTableName",
      backend.kind,
    );
    if (backend.kind === "dynamodb") {
      return createFeatureFlagsRepository("dynamodb", {
        ddb: requiredInput.ddb,
        eventsTableName: requiredInput.tableName,
      });
    }
    const sql = await acquireSqlExecutor();
    return new MirroredFeatureFlagsRepository(
      createFeatureFlagsRepository("dynamodb", {
        ddb: requiredInput.ddb,
        eventsTableName: requiredInput.tableName,
      }),
      createFeatureFlagsRepository(backend.dialect, { sql }),
    );
  }

  /** Deployments remains separately resolved because legacy full resolver shape is unchanged. */
  async function resolveDeploymentsRepository(input: {
    readonly ddb?: DynamoDBDocumentClient;
    readonly deploymentsTableName?: string;
  }): Promise<DeploymentsRepository> {
    const backend = selectBackend(deps.env);
    if (backend.kind === "pure") {
      const sql = await acquireSqlExecutor();
      return createDeploymentsRepository(backend.dialect, { sql });
    }

    const requiredInput = requireDdbAndTableName(
      input.ddb,
      input.deploymentsTableName,
      "deploymentsTableName",
      backend.kind,
    );
    if (backend.kind === "dynamodb") {
      return createDeploymentsRepository("dynamodb", {
        ddb: requiredInput.ddb,
        deploymentsTableName: requiredInput.tableName,
      });
    }
    const sql = await acquireSqlExecutor();
    return new MirroredDeploymentsRepository(
      createDeploymentsRepository("dynamodb", {
        ddb: requiredInput.ddb,
        deploymentsTableName: requiredInput.tableName,
      }),
      createDeploymentsRepository(backend.dialect, { sql }),
    );
  }

  /** [Issue #2442 / Phase C1] Resolver for the ProblemEndpoints seam (mirrors resolveDeploymentsRepository). */
  async function resolveProblemEndpointsRepository(input: {
    readonly ddb?: DynamoDBDocumentClient;
    readonly endpointsTableName?: string;
  }): Promise<ProblemEndpointsRepository> {
    const backend = selectBackend(deps.env);
    if (backend.kind === "pure") {
      const sql = await acquireSqlExecutor();
      return createProblemEndpointsRepository(backend.dialect, { sql });
    }

    const requiredInput = requireDdbAndTableName(
      input.ddb,
      input.endpointsTableName,
      "endpointsTableName",
      backend.kind,
    );
    if (backend.kind === "dynamodb") {
      return createProblemEndpointsRepository("dynamodb", {
        ddb: requiredInput.ddb,
        endpointsTableName: requiredInput.tableName,
      });
    }
    const sql = await acquireSqlExecutor();
    return new MirroredProblemEndpointsRepository(
      createProblemEndpointsRepository("dynamodb", {
        ddb: requiredInput.ddb,
        endpointsTableName: requiredInput.tableName,
      }),
      createProblemEndpointsRepository(backend.dialect, { sql }),
    );
  }

  /** [Issue #2442 / Phase C2] Resolver for the CompetitorAccounts seam (mirrors resolveProblemEndpointsRepository). */
  async function resolveCompetitorAccountsRepository(input: {
    readonly ddb?: DynamoDBDocumentClient;
    readonly competitorAccountsTableName?: string;
  }): Promise<CompetitorAccountsRepository> {
    const backend = selectBackend(deps.env);
    if (backend.kind === "pure") {
      const sql = await acquireSqlExecutor();
      return createCompetitorAccountsRepository(backend.dialect, { sql });
    }

    const requiredInput = requireDdbAndTableName(
      input.ddb,
      input.competitorAccountsTableName,
      "competitorAccountsTableName",
      backend.kind,
    );
    if (backend.kind === "dynamodb") {
      return createCompetitorAccountsRepository("dynamodb", {
        ddb: requiredInput.ddb,
        competitorAccountsTableName: requiredInput.tableName,
      });
    }
    const sql = await acquireSqlExecutor();
    return new MirroredCompetitorAccountsRepository(
      createCompetitorAccountsRepository("dynamodb", {
        ddb: requiredInput.ddb,
        competitorAccountsTableName: requiredInput.tableName,
      }),
      createCompetitorAccountsRepository(backend.dialect, { sql }),
    );
  }

  /** [Issue #2442 / Phase C2] Resolver for the SamlConfig sub-aggregate (mirrors resolveCompetitorAccountsRepository). */
  async function resolveSamlConfigRepository(input: {
    readonly ddb?: DynamoDBDocumentClient;
    readonly competitorAccountsTableName?: string;
  }): Promise<SamlConfigRepository> {
    const backend = selectBackend(deps.env);
    if (backend.kind === "pure") {
      const sql = await acquireSqlExecutor();
      return createSamlConfigRepository(backend.dialect, { sql });
    }

    const requiredInput = requireDdbAndTableName(
      input.ddb,
      input.competitorAccountsTableName,
      "competitorAccountsTableName",
      backend.kind,
    );
    if (backend.kind === "dynamodb") {
      return createSamlConfigRepository("dynamodb", {
        ddb: requiredInput.ddb,
        competitorAccountsTableName: requiredInput.tableName,
      });
    }
    const sql = await acquireSqlExecutor();
    return new MirroredSamlConfigRepository(
      createSamlConfigRepository("dynamodb", {
        ddb: requiredInput.ddb,
        competitorAccountsTableName: requiredInput.tableName,
      }),
      createSamlConfigRepository(backend.dialect, { sql }),
    );
  }

  return {
    needsManualPrune: () => selectBackend(deps.env).kind === "pure",
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
    resolveDeploymentsRepository,
    resolveProblemEndpointsRepository,
    resolveCompetitorAccountsRepository,
    resolveSamlConfigRepository,
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
