import { GetParameterCommand } from "@aws-sdk/client-ssm";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { Client, ResultSet } from "@libsql/client/http";
import { describe, expect, it, vi } from "vitest";
import { DynamoDbEventsRepository } from "../../../lib/problem-deploy/control-data/events-repository.js";
import { DynamoDbFeatureFlagsRepository } from "../../../lib/problem-deploy/control-data/feature-flags-repository.js";
import {
  MirroredEventsRepository,
  MirroredFeatureFlagsRepository,
  MirroredNotificationsRepository,
  MirroredTeamsRepository,
} from "../../../lib/problem-deploy/control-data/mirrored-repositories.js";
import { DynamoDbNotificationsRepository } from "../../../lib/problem-deploy/control-data/notifications-repository.js";
import {
  createControlDataRepositoryResolver,
  createControlDataRuntime,
} from "../../../lib/problem-deploy/control-data/runtime-repositories.js";
import { DynamoDbTeamsRepository } from "../../../lib/problem-deploy/control-data/teams-repository.js";

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

  it("should return Mirrored implementations on turso for every aggregate resolver", async () => {
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
    ).resolves.toBeInstanceOf(MirroredEventsRepository);

    expect(send).toHaveBeenCalledTimes(2);
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it("should keep teams-only resolution free of any events-table requirement", async () => {
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

    await expect(
      runtime.resolveTeamsRepository({
        ddb: input.ddb,
        teamsTableName: input.teamsTableName,
      }),
    ).resolves.toBeInstanceOf(MirroredTeamsRepository);
  });
});
