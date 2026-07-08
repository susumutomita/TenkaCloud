import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { type Client, createClient } from "@libsql/client/http";
import { createEventsRepository } from "./events-repository.js";
import { initializeControlDataSchema, LibsqlExecutor } from "./libsql-executor.js";
import { MirroredEventsRepository, MirroredTeamsRepository } from "./mirrored-repositories.js";
import { createTeamsRepository } from "./teams-repository.js";
import type { EventsRepository, TeamsRepository } from "./types.js";

export interface ControlDataRepositories {
  readonly events: EventsRepository;
  readonly teams: TeamsRepository;
}

export interface ControlDataRuntimeInput {
  readonly ddb: DynamoDBDocumentClient;
  readonly eventsTableName: string;
  readonly teamsTableName: string;
}

interface RuntimeEnvironment {
  readonly CONTROL_DATA_BACKEND?: string;
  readonly TURSO_DATABASE_URL?: string;
  readonly TURSO_AUTH_TOKEN_PARAMETER_NAME?: string;
}

interface RuntimeDependencies {
  readonly env: RuntimeEnvironment;
  readonly ssm: Pick<SSMClient, "send">;
  readonly createClient: (config: { readonly url: string; readonly authToken: string }) => Client;
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${name} is required when CONTROL_DATA_BACKEND is turso/sql.`);
  }
  return normalized;
}

/**
 * Builds a cold-start resolver. The returned closure caches both the decrypted
 * token and libSQL client; warm invocations do not call SSM or rerun schema DDL.
 */
export function createControlDataRepositoryResolver(
  deps: RuntimeDependencies,
): (input: ControlDataRuntimeInput) => Promise<ControlDataRepositories> {
  let cached: Promise<ControlDataRepositories> | undefined;

  return async (input) => {
    const backend = deps.env.CONTROL_DATA_BACKEND?.trim().toLowerCase() || "dynamodb";
    if (backend === "dynamodb") {
      return {
        events: createEventsRepository(backend, {
          ddb: input.ddb,
          eventsTableName: input.eventsTableName,
          // #2437: createEventWithTeams (atomic event+teams transaction) writes
          // the Teams table through the Events repository.
          teamsTableName: input.teamsTableName,
        }),
        teams: createTeamsRepository(backend, {
          ddb: input.ddb,
          teamsTableName: input.teamsTableName,
        }),
      };
    }
    if (backend !== "turso" && backend !== "sql") {
      throw new Error(
        `Unknown CONTROL_DATA_BACKEND="${deps.env.CONTROL_DATA_BACKEND}" ` +
          "(expected one of: dynamodb, turso, sql).",
      );
    }

    cached ??= (async () => {
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
      const sql = new LibsqlExecutor(client);
      const canonicalEvents = createEventsRepository("dynamodb", {
        ddb: input.ddb,
        eventsTableName: input.eventsTableName,
        teamsTableName: input.teamsTableName,
      });
      const canonicalTeams = createTeamsRepository("dynamodb", {
        ddb: input.ddb,
        teamsTableName: input.teamsTableName,
      });
      return {
        events: new MirroredEventsRepository(
          canonicalEvents,
          createEventsRepository(backend, { sql }),
        ),
        teams: new MirroredTeamsRepository(canonicalTeams, createTeamsRepository(backend, { sql })),
      };
    })();
    return cached;
  };
}

export const resolveControlDataRepositories = createControlDataRepositoryResolver({
  env: process.env,
  ssm: new SSMClient({}),
  createClient,
});
