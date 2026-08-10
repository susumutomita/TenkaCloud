import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createAdminAuditLogRepository } from "./admin-audit-log-repository.js";
import { type RuntimeEnvironment, selectBackend } from "./backend-config.js";
import { createCompetitorAccountsRepository } from "./competitor-accounts-repository.js";
import { createDeploymentsRepository } from "./deployments-repository.js";
import { createDisruptionsRepository } from "./disruptions-repository.js";
import { createEventsRepository } from "./events-repository.js";
import { createFeatureFlagsRepository } from "./feature-flags-repository.js";
import {
  DynamoDbIdempotencyRepository,
  IDEMPOTENCY_TABLE_SQL,
  type IdempotencyPort,
  SqlIdempotencyRepository,
} from "./idempotency-repository.js";
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
 * from `runtime-repositories.ts`. Each resolver applies the same two-branch
 * policy — `pure` (turso) returns the SQL adapter, `dynamodb` returns the DDB
 * adapter — kept explicit per aggregate (the epic prefers searchable domain
 * semantics over a generic combinator). [#2677] The former mirror branch
 * (DDB-canonical + SQL-replica dual write) was deleted along with its
 * dual-write repository implementations; the backend is a two-way choice. Backend
 * selection lives in `backend-config.ts`; the shared SQL executor is injected
 * as `acquireSqlExecutor` from `sql-executor-cache.ts`.
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
): { readonly ddb: DynamoDBDocumentClient; readonly tableName: string } {
  if (!ddb || !tableName) {
    throw new Error(`dynamodb backend requires ddb/${tableNameLabel}.`);
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
   * [Issue #2441 / Phase B4] Cold-start resolver for the Deployments seam:
   * `dynamodb` returns DDB, `turso` returns pure SQL.
   */
  readonly resolveDeploymentsRepository: (input: {
    readonly ddb?: DynamoDBDocumentClient;
    readonly deploymentsTableName?: string;
  }) => Promise<DeploymentsRepository>;
  /**
   * [Issue #3002] Cold-start resolver for the Idempotency seam (same two-branch
   * policy as Deployments). `/deploy` runs on both backends, so a DynamoDB-only
   * store would leave Turso environments silently unprotected against the
   * duplicate-stack retry this exists to stop.
   */
  readonly resolveIdempotencyRepository: (input: {
    readonly ddb?: DynamoDBDocumentClient;
    readonly deploymentsTableName?: string;
  }) => Promise<IdempotencyPort>;
  /**
   * [Issue #2442 / Phase C1] Cold-start resolver for the ProblemEndpoints seam
   * (same two-branch policy as Deployments).
   */
  readonly resolveProblemEndpointsRepository: (input: {
    readonly ddb?: DynamoDBDocumentClient;
    readonly endpointsTableName?: string;
  }) => Promise<ProblemEndpointsRepository>;
  /**
   * [Issue #2442 / Phase C2] Cold-start resolver for the CompetitorAccounts
   * seam (same two-branch policy as ProblemEndpoints).
   */
  readonly resolveCompetitorAccountsRepository: (input: {
    readonly ddb?: DynamoDBDocumentClient;
    readonly competitorAccountsTableName?: string;
  }) => Promise<CompetitorAccountsRepository>;
  /**
   * [Issue #2442 / Phase C2] Cold-start resolver for the SamlConfig
   * sub-aggregate (co-habits the CompetitorAccounts DynamoDB table's
   * partition; same two-branch policy as {@link resolveCompetitorAccountsRepository}).
   */
  readonly resolveSamlConfigRepository: (input: {
    readonly ddb?: DynamoDBDocumentClient;
    readonly competitorAccountsTableName?: string;
  }) => Promise<SamlConfigRepository>;
  /**
   * [Issue #2442 / Phase C3] Cold-start resolver for the Disruptions seam
   * (same two-branch policy as CompetitorAccounts).
   */
  readonly resolveDisruptionsRepository: (input: {
    readonly ddb?: DynamoDBDocumentClient;
    readonly disruptionsTableName?: string;
  }) => Promise<DisruptionsRepository>;
  /**
   * [Issue #2442 / Phase C4] Cold-start resolver for the AdminAuditLog seam
   * (same two-branch policy as Disruptions).
   */
  readonly resolveAdminAuditLogRepository: (input: {
    readonly ddb?: DynamoDBDocumentClient;
    readonly adminAuditLogTableName?: string;
  }) => Promise<AdminAuditLogRepository>;
  /**
   * [Issue #2442 / Phase C5] Cold-start resolver for the SamlIdps seam (same
   * two-branch policy as AdminAuditLog). Unlike every other resolver here, the
   * caller is **Lite-mode only** (`tenant-template/handlers/idp-handler/index.ts`
   * via `control-plane/handlers/idp-handler/ddb-store.ts`'s `createSeamIdpStore`)
   * — SaaS/Full mode never wires the SamlIdps table or Lambda at all.
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
    if (selectBackend(env).kind === "pure") {
      const sql = await acquireSqlExecutor();
      return createEventsRepository("turso", { sql });
    }
    const requiredInput = requireDdbAndTableName(
      input.ddb,
      input.eventsTableName,
      "eventsTableName",
    );
    return createEventsRepository("dynamodb", {
      ddb: requiredInput.ddb,
      eventsTableName: requiredInput.tableName,
      // #2437: createEventWithTeams (atomic event+teams transaction) writes
      // the Teams table through the Events repository.
      teamsTableName: input.teamsTableName,
    });
  }

  async function resolveTeamsRepository(input: {
    readonly ddb?: DynamoDBDocumentClient;
    readonly teamsTableName?: string;
    readonly deploymentsTableName?: string;
  }): Promise<TeamsRepository> {
    if (selectBackend(env).kind === "pure") {
      const sql = await acquireSqlExecutor();
      return createTeamsRepository("turso", { sql });
    }
    const requiredInput = requireDdbAndTableName(input.ddb, input.teamsTableName, "teamsTableName");
    return createTeamsRepository("dynamodb", {
      ddb: requiredInput.ddb,
      teamsTableName: requiredInput.tableName,
      deploymentsTableName: input.deploymentsTableName,
    });
  }

  async function resolveNotificationsRepository(input: {
    readonly ddb?: DynamoDBDocumentClient;
    readonly eventsTableName?: string;
  }): Promise<NotificationsRepository> {
    if (selectBackend(env).kind === "pure") {
      const sql = await acquireSqlExecutor();
      return createNotificationsRepository("turso", { sql });
    }
    const requiredInput = requireDdbAndTableName(
      input.ddb,
      input.eventsTableName,
      "eventsTableName",
    );
    return createNotificationsRepository("dynamodb", {
      ddb: requiredInput.ddb,
      eventsTableName: requiredInput.tableName,
    });
  }

  async function resolveFeatureFlagsRepository(input: {
    readonly ddb?: DynamoDBDocumentClient;
    readonly eventsTableName?: string;
  }): Promise<FeatureFlagsRepository> {
    if (selectBackend(env).kind === "pure") {
      const sql = await acquireSqlExecutor();
      return createFeatureFlagsRepository("turso", { sql });
    }
    const requiredInput = requireDdbAndTableName(
      input.ddb,
      input.eventsTableName,
      "eventsTableName",
    );
    return createFeatureFlagsRepository("dynamodb", {
      ddb: requiredInput.ddb,
      eventsTableName: requiredInput.tableName,
    });
  }

  /** Deployments is not part of `resolveRepositories` (runtime-repositories.ts) — callers resolve it individually. */
  async function resolveDeploymentsRepository(input: {
    readonly ddb?: DynamoDBDocumentClient;
    readonly deploymentsTableName?: string;
  }): Promise<DeploymentsRepository> {
    if (selectBackend(env).kind === "pure") {
      const sql = await acquireSqlExecutor();
      return createDeploymentsRepository("turso", { sql });
    }
    const requiredInput = requireDdbAndTableName(
      input.ddb,
      input.deploymentsTableName,
      "deploymentsTableName",
    );
    return createDeploymentsRepository("dynamodb", {
      ddb: requiredInput.ddb,
      deploymentsTableName: requiredInput.tableName,
    });
  }

  /** [Issue #3002] Resolver for the Idempotency seam (mirrors resolveDeploymentsRepository). */
  async function resolveIdempotencyRepository(input: {
    readonly ddb?: DynamoDBDocumentClient;
    readonly deploymentsTableName?: string;
  }): Promise<IdempotencyPort> {
    if (selectBackend(env).kind === "pure") {
      const sql = await acquireSqlExecutor();
      // 冪等レコードは deployments と同じ database に置く。 SQLite に TTL は無いので
      // table は CREATE TABLE IF NOT EXISTS で確保する (deployments 系と同じやり方)。
      await sql.run(IDEMPOTENCY_TABLE_SQL);
      return new SqlIdempotencyRepository(sql);
    }
    const requiredInput = requireDdbAndTableName(
      input.ddb,
      input.deploymentsTableName,
      "deploymentsTableName",
    );
    // 新しい table は作らない。 deployments table が既に TTL 属性 (expiresAt) を持つので、
    // IDEM# prefix で相乗りする (CloudFormation の変更なし)。
    return new DynamoDbIdempotencyRepository(requiredInput.ddb, requiredInput.tableName);
  }

  /** [Issue #2442 / Phase C1] Resolver for the ProblemEndpoints seam (mirrors resolveDeploymentsRepository). */
  async function resolveProblemEndpointsRepository(input: {
    readonly ddb?: DynamoDBDocumentClient;
    readonly endpointsTableName?: string;
  }): Promise<ProblemEndpointsRepository> {
    if (selectBackend(env).kind === "pure") {
      const sql = await acquireSqlExecutor();
      return createProblemEndpointsRepository("turso", { sql });
    }
    const requiredInput = requireDdbAndTableName(
      input.ddb,
      input.endpointsTableName,
      "endpointsTableName",
    );
    return createProblemEndpointsRepository("dynamodb", {
      ddb: requiredInput.ddb,
      endpointsTableName: requiredInput.tableName,
    });
  }

  /** [Issue #2442 / Phase C2] Resolver for the CompetitorAccounts seam (mirrors resolveProblemEndpointsRepository). */
  async function resolveCompetitorAccountsRepository(input: {
    readonly ddb?: DynamoDBDocumentClient;
    readonly competitorAccountsTableName?: string;
  }): Promise<CompetitorAccountsRepository> {
    if (selectBackend(env).kind === "pure") {
      const sql = await acquireSqlExecutor();
      return createCompetitorAccountsRepository("turso", { sql });
    }
    const requiredInput = requireDdbAndTableName(
      input.ddb,
      input.competitorAccountsTableName,
      "competitorAccountsTableName",
    );
    return createCompetitorAccountsRepository("dynamodb", {
      ddb: requiredInput.ddb,
      competitorAccountsTableName: requiredInput.tableName,
    });
  }

  /** [Issue #2442 / Phase C2] Resolver for the SamlConfig sub-aggregate (mirrors resolveCompetitorAccountsRepository). */
  async function resolveSamlConfigRepository(input: {
    readonly ddb?: DynamoDBDocumentClient;
    readonly competitorAccountsTableName?: string;
  }): Promise<SamlConfigRepository> {
    if (selectBackend(env).kind === "pure") {
      const sql = await acquireSqlExecutor();
      return createSamlConfigRepository("turso", { sql });
    }
    const requiredInput = requireDdbAndTableName(
      input.ddb,
      input.competitorAccountsTableName,
      "competitorAccountsTableName",
    );
    return createSamlConfigRepository("dynamodb", {
      ddb: requiredInput.ddb,
      competitorAccountsTableName: requiredInput.tableName,
    });
  }

  /** [Issue #2442 / Phase C3] Resolver for the Disruptions seam (mirrors resolveCompetitorAccountsRepository). */
  async function resolveDisruptionsRepository(input: {
    readonly ddb?: DynamoDBDocumentClient;
    readonly disruptionsTableName?: string;
  }): Promise<DisruptionsRepository> {
    if (selectBackend(env).kind === "pure") {
      const sql = await acquireSqlExecutor();
      return createDisruptionsRepository("turso", { sql });
    }
    const requiredInput = requireDdbAndTableName(
      input.ddb,
      input.disruptionsTableName,
      "disruptionsTableName",
    );
    return createDisruptionsRepository("dynamodb", {
      ddb: requiredInput.ddb,
      disruptionsTableName: requiredInput.tableName,
    });
  }

  /** [Issue #2442 / Phase C4] Resolver for the AdminAuditLog seam (mirrors resolveDisruptionsRepository). */
  async function resolveAdminAuditLogRepository(input: {
    readonly ddb?: DynamoDBDocumentClient;
    readonly adminAuditLogTableName?: string;
  }): Promise<AdminAuditLogRepository> {
    if (selectBackend(env).kind === "pure") {
      const sql = await acquireSqlExecutor();
      return createAdminAuditLogRepository("turso", { sql });
    }
    const requiredInput = requireDdbAndTableName(
      input.ddb,
      input.adminAuditLogTableName,
      "adminAuditLogTableName",
    );
    return createAdminAuditLogRepository("dynamodb", {
      ddb: requiredInput.ddb,
      adminAuditLogTableName: requiredInput.tableName,
    });
  }

  /** [Issue #2442 / Phase C5] Resolver for the SamlIdps seam (mirrors resolveAdminAuditLogRepository). */
  async function resolveSamlIdpsRepository(input: {
    readonly ddb?: DynamoDBDocumentClient;
    readonly samlIdpsTableName?: string;
  }): Promise<SamlIdpsRepository> {
    if (selectBackend(env).kind === "pure") {
      const sql = await acquireSqlExecutor();
      return createSamlIdpsRepository("turso", { sql });
    }
    const requiredInput = requireDdbAndTableName(
      input.ddb,
      input.samlIdpsTableName,
      "samlIdpsTableName",
    );
    return createSamlIdpsRepository("dynamodb", {
      ddb: requiredInput.ddb,
      samlIdpsTableName: requiredInput.tableName,
    });
  }

  return {
    resolveEventsRepository,
    resolveTeamsRepository,
    resolveNotificationsRepository,
    resolveFeatureFlagsRepository,
    resolveDeploymentsRepository,
    resolveIdempotencyRepository,
    resolveProblemEndpointsRepository,
    resolveCompetitorAccountsRepository,
    resolveSamlConfigRepository,
    resolveDisruptionsRepository,
    resolveAdminAuditLogRepository,
    resolveSamlIdpsRepository,
  };
}
