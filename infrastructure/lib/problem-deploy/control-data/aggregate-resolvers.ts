import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createAdminAuditLogRepository } from "./admin-audit-log-repository.js";
import { type RuntimeEnvironment, selectBackend } from "./backend-config.js";
import { createCompetitorAccountsRepository } from "./competitor-accounts-repository.js";
import { createDeploymentsRepository } from "./deployments-repository.js";
import { createDisruptionsRepository } from "./disruptions-repository.js";
import { createEventsRepository } from "./events-repository.js";
import { createFeatureFlagsRepository } from "./feature-flags-repository.js";
import {
  MirroredAdminAuditLogRepository,
  MirroredCompetitorAccountsRepository,
  MirroredDeploymentsRepository,
  MirroredDisruptionsRepository,
  MirroredEventsRepository,
  MirroredFeatureFlagsRepository,
  MirroredNotificationsRepository,
  MirroredProblemEndpointsRepository,
  MirroredSamlConfigRepository,
  MirroredSamlIdpsRepository,
  MirroredTeamsRepository,
} from "./mirrored-repositories.js";
import { createNotificationsRepository } from "./notifications-repository.js";
import { createProblemEndpointsRepository } from "./problem-endpoints-repository.js";
import { createSamlConfigRepository } from "./saml-config-repository.js";
import { createSamlIdpsRepository } from "./saml-idps-repository.js";
import { createTeamsRepository } from "./teams-repository.js";
import type {
  AdminAuditLogRepository,
  CompetitorAccountsRepository,
  DeploymentsRepository,
  DisruptionsRepository,
  EventsRepository,
  FeatureFlagsRepository,
  NotificationsRepository,
  ProblemEndpointsRepository,
  SamlConfigRepository,
  SamlIdpsRepository,
  SqlExecutor,
  TeamsRepository,
} from "./types.js";

/**
 * [#2527 Slice 4] The per-aggregate cold-start resolvers, extracted verbatim
 * from `runtime-repositories.ts`. Each resolver applies the same three-branch
 * policy — `pure` returns the SQL adapter, `dynamodb` returns the DDB adapter,
 * `mirror` composes DDB-canonical + SQL-replica — kept explicit per aggregate
 * (the epic prefers searchable domain semantics over a generic combinator).
 * Backend selection lives in `backend-config.ts`; the shared SQL executor is
 * injected as `acquireSqlExecutor` from `sql-executor-cache.ts`.
 */

function requireDdbAndTableName(
  ddb: DynamoDBDocumentClient | undefined,
  tableName: string | undefined,
  tableNameLabel:
    | "eventsTableName"
    | "teamsTableName"
    | "deploymentsTableName"
    | "endpointsTableName"
    | "competitorAccountsTableName"
    | "disruptionsTableName"
    | "adminAuditLogTableName"
    | "samlIdpsTableName",
  backendKind: "dynamodb" | "mirror",
): { readonly ddb: DynamoDBDocumentClient; readonly tableName: string } {
  if (!ddb || !tableName) {
    throw new Error(`${backendKind} backend requires ddb/${tableNameLabel}.`);
  }
  return { ddb, tableName };
}

export interface AggregateResolvers {
  readonly resolveEventsRepository: (input: {
    readonly ddb?: DynamoDBDocumentClient;
    readonly eventsTableName?: string;
    readonly teamsTableName?: string;
  }) => Promise<EventsRepository>;
  readonly resolveTeamsRepository: (input: {
    readonly ddb?: DynamoDBDocumentClient;
    readonly teamsTableName?: string;
    readonly deploymentsTableName?: string;
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
  /**
   * [Issue #2442 / Phase C3] Cold-start resolver for the Disruptions seam. Participates in all
   * five `CONTROL_DATA_BACKEND` values like ProblemEndpoints/CompetitorAccounts: `dynamodb`
   * returns DDB, `turso` / `sql` return pure SQL, and mirror modes write through DDB then SQL
   * while serving reads from canonical DDB.
   */
  readonly resolveDisruptionsRepository: (input: {
    readonly ddb?: DynamoDBDocumentClient;
    readonly disruptionsTableName?: string;
  }) => Promise<DisruptionsRepository>;
  /**
   * [Issue #2442 / Phase C4] Cold-start resolver for the AdminAuditLog seam. Participates in all
   * five `CONTROL_DATA_BACKEND` values like Disruptions/CompetitorAccounts: `dynamodb` returns
   * DDB, `turso` / `sql` return pure SQL, and mirror modes write through DDB then SQL while
   * serving reads from canonical DDB.
   */
  readonly resolveAdminAuditLogRepository: (input: {
    readonly ddb?: DynamoDBDocumentClient;
    readonly adminAuditLogTableName?: string;
  }) => Promise<AdminAuditLogRepository>;
  /**
   * [Issue #2442 / Phase C5] Cold-start resolver for the SamlIdps seam. Participates in all five
   * `CONTROL_DATA_BACKEND` values like AdminAuditLog/Disruptions/CompetitorAccounts: `dynamodb`
   * returns DDB, `turso` / `sql` return pure SQL, and mirror modes write through DDB then SQL
   * while serving reads from canonical DDB. Unlike every other resolver here, the caller is
   * **Lite-mode only** (`tenant-template/handlers/idp-handler/index.ts` via
   * `control-plane/handlers/idp-handler/ddb-store.ts`'s `createSeamIdpStore`) — SaaS/Full mode
   * never wires the SamlIdps table or Lambda at all.
   */
  readonly resolveSamlIdpsRepository: (input: {
    readonly ddb?: DynamoDBDocumentClient;
    readonly samlIdpsTableName?: string;
  }) => Promise<SamlIdpsRepository>;
}

export function createAggregateResolvers(
  env: RuntimeEnvironment,
  acquireSqlExecutor: () => Promise<SqlExecutor>,
): AggregateResolvers {
  async function resolveEventsRepository(input: {
    readonly ddb?: DynamoDBDocumentClient;
    readonly eventsTableName?: string;
    readonly teamsTableName?: string;
  }): Promise<EventsRepository> {
    const backend = selectBackend(env);
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
    readonly deploymentsTableName?: string;
  }): Promise<TeamsRepository> {
    const backend = selectBackend(env);
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
        deploymentsTableName: input.deploymentsTableName,
      });
    }
    const sql = await acquireSqlExecutor();
    return new MirroredTeamsRepository(
      createTeamsRepository("dynamodb", {
        ddb: requiredInput.ddb,
        teamsTableName: requiredInput.tableName,
        deploymentsTableName: input.deploymentsTableName,
      }),
      createTeamsRepository(backend.dialect, { sql }),
    );
  }

  async function resolveNotificationsRepository(input: {
    readonly ddb?: DynamoDBDocumentClient;
    readonly eventsTableName?: string;
  }): Promise<NotificationsRepository> {
    const backend = selectBackend(env);
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
    const backend = selectBackend(env);
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

  /** Deployments is not part of `resolveRepositories` (runtime-repositories.ts) — callers resolve it individually. */
  async function resolveDeploymentsRepository(input: {
    readonly ddb?: DynamoDBDocumentClient;
    readonly deploymentsTableName?: string;
  }): Promise<DeploymentsRepository> {
    const backend = selectBackend(env);
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
    const backend = selectBackend(env);
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
    const backend = selectBackend(env);
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
    const backend = selectBackend(env);
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

  /** [Issue #2442 / Phase C3] Resolver for the Disruptions seam (mirrors resolveCompetitorAccountsRepository). */
  async function resolveDisruptionsRepository(input: {
    readonly ddb?: DynamoDBDocumentClient;
    readonly disruptionsTableName?: string;
  }): Promise<DisruptionsRepository> {
    const backend = selectBackend(env);
    if (backend.kind === "pure") {
      const sql = await acquireSqlExecutor();
      return createDisruptionsRepository(backend.dialect, { sql });
    }

    const requiredInput = requireDdbAndTableName(
      input.ddb,
      input.disruptionsTableName,
      "disruptionsTableName",
      backend.kind,
    );
    if (backend.kind === "dynamodb") {
      return createDisruptionsRepository("dynamodb", {
        ddb: requiredInput.ddb,
        disruptionsTableName: requiredInput.tableName,
      });
    }
    const sql = await acquireSqlExecutor();
    return new MirroredDisruptionsRepository(
      createDisruptionsRepository("dynamodb", {
        ddb: requiredInput.ddb,
        disruptionsTableName: requiredInput.tableName,
      }),
      createDisruptionsRepository(backend.dialect, { sql }),
    );
  }

  /** [Issue #2442 / Phase C4] Resolver for the AdminAuditLog seam (mirrors resolveDisruptionsRepository). */
  async function resolveAdminAuditLogRepository(input: {
    readonly ddb?: DynamoDBDocumentClient;
    readonly adminAuditLogTableName?: string;
  }): Promise<AdminAuditLogRepository> {
    const backend = selectBackend(env);
    if (backend.kind === "pure") {
      const sql = await acquireSqlExecutor();
      return createAdminAuditLogRepository(backend.dialect, { sql });
    }

    const requiredInput = requireDdbAndTableName(
      input.ddb,
      input.adminAuditLogTableName,
      "adminAuditLogTableName",
      backend.kind,
    );
    if (backend.kind === "dynamodb") {
      return createAdminAuditLogRepository("dynamodb", {
        ddb: requiredInput.ddb,
        adminAuditLogTableName: requiredInput.tableName,
      });
    }
    const sql = await acquireSqlExecutor();
    return new MirroredAdminAuditLogRepository(
      createAdminAuditLogRepository("dynamodb", {
        ddb: requiredInput.ddb,
        adminAuditLogTableName: requiredInput.tableName,
      }),
      createAdminAuditLogRepository(backend.dialect, { sql }),
    );
  }

  /** [Issue #2442 / Phase C5] Resolver for the SamlIdps seam (mirrors resolveAdminAuditLogRepository). */
  async function resolveSamlIdpsRepository(input: {
    readonly ddb?: DynamoDBDocumentClient;
    readonly samlIdpsTableName?: string;
  }): Promise<SamlIdpsRepository> {
    const backend = selectBackend(env);
    if (backend.kind === "pure") {
      const sql = await acquireSqlExecutor();
      return createSamlIdpsRepository(backend.dialect, { sql });
    }

    const requiredInput = requireDdbAndTableName(
      input.ddb,
      input.samlIdpsTableName,
      "samlIdpsTableName",
      backend.kind,
    );
    if (backend.kind === "dynamodb") {
      return createSamlIdpsRepository("dynamodb", {
        ddb: requiredInput.ddb,
        samlIdpsTableName: requiredInput.tableName,
      });
    }
    const sql = await acquireSqlExecutor();
    return new MirroredSamlIdpsRepository(
      createSamlIdpsRepository("dynamodb", {
        ddb: requiredInput.ddb,
        samlIdpsTableName: requiredInput.tableName,
      }),
      createSamlIdpsRepository(backend.dialect, { sql }),
    );
  }

  return {
    resolveEventsRepository,
    resolveTeamsRepository,
    resolveNotificationsRepository,
    resolveFeatureFlagsRepository,
    resolveDeploymentsRepository,
    resolveProblemEndpointsRepository,
    resolveCompetitorAccountsRepository,
    resolveSamlConfigRepository,
    resolveDisruptionsRepository,
    resolveAdminAuditLogRepository,
    resolveSamlIdpsRepository,
  };
}
