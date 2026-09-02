import { SSMClient } from "@aws-sdk/client-ssm";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createClient } from "@libsql/client/http";
import { type AggregateResolvers, createAggregateResolvers } from "./aggregate-resolvers.js";
import { selectBackend } from "./backend-config.js";
import {
  type CoordinationStateBudget,
  coordinationStateBudget,
} from "./domain/coordination-budget.js";
import { createSqlExecutorCache, type RuntimeDependencies } from "./sql-executor-cache.js";
import type {
  EventsRepository,
  FeatureFlagsRepository,
  NotificationsRepository,
  TeamsRepository,
} from "./types.js";

/**
 * [#2527 Slice 4] Composition seam for the control-data runtime. The three
 * concerns this file used to hold inline now live in cohesive modules —
 * `backend-config.ts` (CONTROL_DATA_BACKEND parsing), `sql-executor-cache.ts`
 * (SSM + libSQL cold-start cache), and `aggregate-resolvers.ts` (the eleven
 * per-aggregate backend resolvers) — and this file only composes them into the
 * {@link ControlDataRuntime} shape. There is no module singleton: every Lambda
 * entrypoint creates its own runtime via {@link createDefaultControlDataRuntime}
 * and injects it into its handler family's shared resources.
 */

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
  readonly deploymentsTableName?: string;
}

export interface ControlDataRuntime extends AggregateResolvers {
  /**
   * DDB native TTL が無い backend では generic-scoring reconciler tick が
   * Events / Teams / Notifications の prune を駆動する。
   */
  readonly needsManualPrune: () => boolean;
  /**
   * [Issue #3151] How large one coordination state row may get on the backend
   * this runtime selected, and when to warn about it.
   *
   * It hangs off the runtime rather than being read from `process.env` at the
   * call site because the runtime is the one object that already knows which
   * backend is in play. A handler that resolved the budget itself would have to
   * re-derive that, and the two answers could then disagree — which is exactly
   * the failure this budget exists to prevent, arrived at from the other side.
   */
  readonly coordinationStateBudget: () => CoordinationStateBudget;
  readonly resolveRepositories: (
    input: ControlDataRuntimeInput,
  ) => Promise<ControlDataRepositories>;
}

/**
 * Builds a cold-start runtime. The returned runtime caches the decrypted token
 * and libSQL client as a SqlExecutor; warm invocations do not call SSM or rerun
 * schema DDL, while aggregate repository objects remain request-scoped.
 */
export function createControlDataRuntime(deps: RuntimeDependencies): ControlDataRuntime {
  const acquireSqlExecutor = createSqlExecutorCache(deps);
  const resolvers = createAggregateResolvers(deps.env, acquireSqlExecutor);

  return {
    ...resolvers,
    needsManualPrune: () => selectBackend(deps.env).kind === "pure",
    coordinationStateBudget: () => coordinationStateBudget(selectBackend(deps.env), deps.env),
    resolveRepositories: async (input) => {
      const [events, teams, notifications, featureFlags] = await Promise.all([
        resolvers.resolveEventsRepository(input),
        resolvers.resolveTeamsRepository(input),
        resolvers.resolveNotificationsRepository(input),
        resolvers.resolveFeatureFlagsRepository(input),
      ]);
      return { events, teams, notifications, featureFlags };
    },
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

/**
 * [#2527 Slice 4] Production composition-root factory: a runtime backed by
 * process.env, real SSM, and the real libSQL client. Lambda entrypoints call
 * this once at module scope (one cold-start cache per Lambda instance) and
 * inject the result into their handler shared-resources — handler modules
 * receive the runtime through their deps and never compose one themselves
 * (the sole exception is the fire-and-forget audit side-channel's documented
 * default in `handlers/shared/audit-log.ts`).
 */
export function createDefaultControlDataRuntime(): ControlDataRuntime {
  return createControlDataRuntime({
    env: process.env,
    ssm: new SSMClient({}),
    createClient,
  });
}
