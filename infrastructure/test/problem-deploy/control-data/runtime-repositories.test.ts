import { GetParameterCommand } from "@aws-sdk/client-ssm";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { Client, ResultSet } from "@libsql/client/http";
import { describe, expect, it, vi } from "vitest";
import {
  DynamoDbEventsRepository,
  SqlEventsRepository,
} from "../../../lib/problem-deploy/control-data/events-repository.js";
import {
  DynamoDbFeatureFlagsRepository,
  SqlFeatureFlagsRepository,
} from "../../../lib/problem-deploy/control-data/feature-flags-repository.js";
import {
  MirroredEventsRepository,
  MirroredFeatureFlagsRepository,
  MirroredNotificationsRepository,
  MirroredTeamsRepository,
} from "../../../lib/problem-deploy/control-data/mirrored-repositories.js";
import {
  DynamoDbNotificationsRepository,
  SqlNotificationsRepository,
} from "../../../lib/problem-deploy/control-data/notifications-repository.js";
import {
  createControlDataRepositoryResolver,
  createControlDataRuntime,
} from "../../../lib/problem-deploy/control-data/runtime-repositories.js";
import {
  DynamoDbTeamsRepository,
  SqlTeamsRepository,
} from "../../../lib/problem-deploy/control-data/teams-repository.js";

const input = {
  ddb: { send: vi.fn() } as unknown as DynamoDBDocumentClient,
  eventsTableName: "Events",
  teamsTableName: "Teams",
};

function mockLibsqlClient() {
  const batch = vi.fn().mockResolvedValue([]);
  const execute = vi.fn().mockResolvedValue({
    rows: [],
    rowsAffected: 0,
  } as unknown as ResultSet);
  const client = { batch, execute } as unknown as Client;
  return { batch, execute, client };
}

describe("control-data runtime repository resolver", () => {
  it("should build DynamoDB-only repositories without touching SSM on the default backend", async () => {
    const send = vi.fn();
    const createClient = vi.fn();
    const runtime = createControlDataRuntime({
      env: {},
      ssm: { send },
      createClient,
    });

    const events = await runtime.resolveEventsRepository({
      ddb: input.ddb,
      eventsTableName: input.eventsTableName,
    });
    const teams = await runtime.resolveTeamsRepository({
      ddb: input.ddb,
      teamsTableName: input.teamsTableName,
    });
    const notifications = await runtime.resolveNotificationsRepository({
      ddb: input.ddb,
      eventsTableName: input.eventsTableName,
    });
    const featureFlags = await runtime.resolveFeatureFlagsRepository({
      ddb: input.ddb,
      eventsTableName: input.eventsTableName,
    });
    const repositories = await runtime.resolveRepositories(input);

    expect(events).toBeInstanceOf(DynamoDbEventsRepository);
    expect(teams).toBeInstanceOf(DynamoDbTeamsRepository);
    expect(notifications).toBeInstanceOf(DynamoDbNotificationsRepository);
    expect(featureFlags).toBeInstanceOf(DynamoDbFeatureFlagsRepository);
    expect(repositories.events).toBeInstanceOf(DynamoDbEventsRepository);
    expect(repositories.teams).toBeInstanceOf(DynamoDbTeamsRepository);
    expect(repositories.notifications).toBeInstanceOf(DynamoDbNotificationsRepository);
    expect(repositories.featureFlags).toBeInstanceOf(DynamoDbFeatureFlagsRepository);
    expect(send).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("should report manual prune only for pure SQL backends", () => {
    const makeRuntime = (backend: string | undefined) =>
      createControlDataRuntime({
        env: backend === undefined ? {} : { CONTROL_DATA_BACKEND: backend },
        ssm: { send: vi.fn() },
        createClient: vi.fn(),
      });

    expect(makeRuntime(undefined).needsManualPrune()).toBe(false);
    expect(makeRuntime("dynamodb").needsManualPrune()).toBe(false);
    expect(makeRuntime("turso").needsManualPrune()).toBe(true);
    expect(makeRuntime("sql").needsManualPrune()).toBe(true);
    expect(makeRuntime("turso-mirror").needsManualPrune()).toBe(false);
    expect(makeRuntime("sql-mirror").needsManualPrune()).toBe(false);
  });

  it("should keep createControlDataRepositoryResolver as a full resolver wrapper", async () => {
    const resolve = createControlDataRepositoryResolver({
      env: {},
      ssm: { send: vi.fn() },
      createClient: vi.fn(),
    });

    const repositories = await resolve(input);

    expect(repositories.events).toBeInstanceOf(DynamoDbEventsRepository);
    expect(repositories.teams).toBeInstanceOf(DynamoDbTeamsRepository);
    expect(repositories.notifications).toBeInstanceOf(DynamoDbNotificationsRepository);
    expect(repositories.featureFlags).toBeInstanceOf(DynamoDbFeatureFlagsRepository);
  });

  it("should share one SSM fetch and libsql client across all aggregate resolvers on turso", async () => {
    const send = vi.fn().mockResolvedValue({ Parameter: { Value: "secret-token" } });
    const { batch, client } = mockLibsqlClient();
    const createClient = vi.fn().mockReturnValue(client);
    const runtime = createControlDataRuntime({
      env: {
        CONTROL_DATA_BACKEND: "turso",
        TURSO_DATABASE_URL: "libsql://example.turso.io",
        TURSO_AUTH_TOKEN_PARAMETER_NAME: "/tenkacloud/dev/turso-token",
      },
      ssm: { send },
      createClient,
    });

    await runtime.resolveEventsRepository({
      ddb: input.ddb,
      eventsTableName: input.eventsTableName,
      teamsTableName: input.teamsTableName,
    });
    await runtime.resolveTeamsRepository({
      ddb: input.ddb,
      teamsTableName: input.teamsTableName,
    });
    await runtime.resolveNotificationsRepository({
      ddb: input.ddb,
      eventsTableName: input.eventsTableName,
    });
    await runtime.resolveFeatureFlagsRepository({
      ddb: input.ddb,
      eventsTableName: input.eventsTableName,
    });

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(GetParameterCommand);
    expect((command as GetParameterCommand).input).toEqual({
      Name: "/tenkacloud/dev/turso-token",
      WithDecryption: true,
    });
    expect(createClient).toHaveBeenCalledWith({
      url: "libsql://example.turso.io",
      authToken: "secret-token",
    });
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it("should return pure SQL implementations on turso without ddb or table names", async () => {
    const send = vi.fn().mockResolvedValue({ Parameter: { Value: "secret-token" } });
    const { client } = mockLibsqlClient();
    const runtime = createControlDataRuntime({
      env: {
        CONTROL_DATA_BACKEND: "turso",
        TURSO_DATABASE_URL: "libsql://example.turso.io",
        TURSO_AUTH_TOKEN_PARAMETER_NAME: "/tenkacloud/dev/turso-token",
      },
      ssm: { send },
      createClient: vi.fn().mockReturnValue(client),
    });

    const repositories = await runtime.resolveRepositories({});

    expect(repositories.events).toBeInstanceOf(SqlEventsRepository);
    expect(repositories.teams).toBeInstanceOf(SqlTeamsRepository);
    expect(repositories.notifications).toBeInstanceOf(SqlNotificationsRepository);
    expect(repositories.featureFlags).toBeInstanceOf(SqlFeatureFlagsRepository);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("should return Mirrored implementations on turso-mirror for every aggregate resolver", async () => {
    const send = vi.fn().mockResolvedValue({ Parameter: { Value: "secret-token" } });
    const { client } = mockLibsqlClient();
    const runtime = createControlDataRuntime({
      env: {
        CONTROL_DATA_BACKEND: "turso-mirror",
        TURSO_DATABASE_URL: "libsql://example.turso.io",
        TURSO_AUTH_TOKEN_PARAMETER_NAME: "/tenkacloud/dev/turso-token",
      },
      ssm: { send },
      createClient: vi.fn().mockReturnValue(client),
    });

    const events = await runtime.resolveEventsRepository({
      ddb: input.ddb,
      eventsTableName: input.eventsTableName,
      teamsTableName: input.teamsTableName,
    });
    const teams = await runtime.resolveTeamsRepository({
      ddb: input.ddb,
      teamsTableName: input.teamsTableName,
    });
    const notifications = await runtime.resolveNotificationsRepository({
      ddb: input.ddb,
      eventsTableName: input.eventsTableName,
    });
    const featureFlags = await runtime.resolveFeatureFlagsRepository({
      ddb: input.ddb,
      eventsTableName: input.eventsTableName,
    });

    expect(events).toBeInstanceOf(MirroredEventsRepository);
    expect(teams).toBeInstanceOf(MirroredTeamsRepository);
    expect(notifications).toBeInstanceOf(MirroredNotificationsRepository);
    expect(featureFlags).toBeInstanceOf(MirroredFeatureFlagsRepository);
  });

  it("should normalize sql-mirror to the SQL replica dialect while keeping DynamoDB canonical", async () => {
    const send = vi.fn().mockResolvedValue({ Parameter: { Value: "secret-token" } });
    const { client } = mockLibsqlClient();
    const runtime = createControlDataRuntime({
      env: {
        CONTROL_DATA_BACKEND: "sql-mirror",
        TURSO_DATABASE_URL: "file:local.db",
        TURSO_AUTH_TOKEN_PARAMETER_NAME: "/tenkacloud/dev/sql-token",
      },
      ssm: { send },
      createClient: vi.fn().mockReturnValue(client),
    });

    await expect(runtime.resolveEventsRepository(input)).resolves.toBeInstanceOf(
      MirroredEventsRepository,
    );
  });

  it("should fail loudly before SSM access when mirror backend is missing DDB inputs", async () => {
    const send = vi.fn();
    const runtime = createControlDataRuntime({
      env: {
        CONTROL_DATA_BACKEND: "turso-mirror",
        TURSO_DATABASE_URL: "libsql://example.turso.io",
        TURSO_AUTH_TOKEN_PARAMETER_NAME: "/tenkacloud/dev/turso-token",
      },
      ssm: { send },
      createClient: vi.fn(),
    });

    await expect(
      runtime.resolveEventsRepository({ eventsTableName: input.eventsTableName }),
    ).rejects.toThrow(/mirror backend requires ddb\/eventsTableName/);
    await expect(runtime.resolveTeamsRepository({ ddb: input.ddb })).rejects.toThrow(
      /mirror backend requires ddb\/teamsTableName/,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("should throw fail-loud when turso env vars are missing via the events-only resolver", async () => {
    const send = vi.fn();
    const runtime = createControlDataRuntime({
      env: { CONTROL_DATA_BACKEND: "turso" },
      ssm: { send },
      createClient: vi.fn(),
    });

    await expect(
      runtime.resolveEventsRepository({
        ddb: input.ddb,
        eventsTableName: input.eventsTableName,
      }),
    ).rejects.toThrow(/TURSO_DATABASE_URL is required/);
    expect(send).not.toHaveBeenCalled();
  });

  it("should reject an unknown runtime backend before network access", async () => {
    const send = vi.fn();
    const runtime = createControlDataRuntime({
      env: { CONTROL_DATA_BACKEND: "postgres" },
      ssm: { send },
      createClient: vi.fn(),
    });

    await expect(runtime.resolveRepositories(input)).rejects.toThrow(
      /Unknown CONTROL_DATA_BACKEND/,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("should fail closed when the SecureString is absent or empty", async () => {
    const runtime = createControlDataRuntime({
      env: {
        CONTROL_DATA_BACKEND: "turso",
        TURSO_DATABASE_URL: "libsql://example.turso.io",
        TURSO_AUTH_TOKEN_PARAMETER_NAME: "/tenkacloud/dev/turso-token",
      },
      ssm: { send: vi.fn().mockResolvedValue({ Parameter: { Value: " " } }) },
      createClient: vi.fn(),
    });

    await expect(runtime.resolveRepositories(input)).rejects.toThrow(
      /auth token not found in SSM SecureString/,
    );
  });

  it("should not cache a failed SSM acquisition", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary SSM outage"))
      .mockResolvedValueOnce({ Parameter: { Value: "secret-token" } });
    const { batch, client } = mockLibsqlClient();
    const createClient = vi.fn().mockReturnValue(client);
    const runtime = createControlDataRuntime({
      env: {
        CONTROL_DATA_BACKEND: "turso",
        TURSO_DATABASE_URL: "libsql://example.turso.io",
        TURSO_AUTH_TOKEN_PARAMETER_NAME: "/tenkacloud/dev/turso-token",
      },
      ssm: { send },
      createClient,
    });

    await expect(
      runtime.resolveEventsRepository({
        ddb: input.ddb,
        eventsTableName: input.eventsTableName,
      }),
    ).rejects.toThrow(/temporary SSM outage/);
    await expect(
      runtime.resolveEventsRepository({
        ddb: input.ddb,
        eventsTableName: input.eventsTableName,
      }),
    ).resolves.toBeInstanceOf(SqlEventsRepository);

    expect(send).toHaveBeenCalledTimes(2);
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it("should keep teams-only pure SQL resolution free of any DDB or events-table requirement", async () => {
    const send = vi.fn().mockResolvedValue({ Parameter: { Value: "secret-token" } });
    const { client } = mockLibsqlClient();
    const runtime = createControlDataRuntime({
      env: {
        CONTROL_DATA_BACKEND: "turso",
        TURSO_DATABASE_URL: "libsql://example.turso.io",
        TURSO_AUTH_TOKEN_PARAMETER_NAME: "/tenkacloud/dev/turso-token",
      },
      ssm: { send },
      createClient: vi.fn().mockReturnValue(client),
    });

    await expect(runtime.resolveTeamsRepository({})).resolves.toBeInstanceOf(SqlTeamsRepository);
  });
});
