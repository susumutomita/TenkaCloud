import { GetParameterCommand } from "@aws-sdk/client-ssm";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { Client, ResultSet } from "@libsql/client/http";
import { describe, expect, it, vi } from "vitest";
import { DynamoDbEventsRepository } from "../../../lib/problem-deploy/control-data/events-repository.js";
import {
  MirroredEventsRepository,
  MirroredFeatureFlagsRepository,
  MirroredNotificationsRepository,
  MirroredTeamsRepository,
} from "../../../lib/problem-deploy/control-data/mirrored-repositories.js";
import { createControlDataRepositoryResolver } from "../../../lib/problem-deploy/control-data/runtime-repositories.js";

const input = {
  ddb: { send: vi.fn() } as unknown as DynamoDBDocumentClient,
  eventsTableName: "Events",
  teamsTableName: "Teams",
};

describe("control-data runtime repository resolver", () => {
  it("should keep DynamoDB as the no-config default without touching SSM", async () => {
    const send = vi.fn();
    const createClient = vi.fn();
    const resolve = createControlDataRepositoryResolver({
      env: {},
      ssm: { send },
      createClient,
    });

    const repositories = await resolve(input);

    expect(repositories.events).toBeInstanceOf(DynamoDbEventsRepository);
    expect(send).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("should decrypt the token once, initialize with batch, and cache mirrored Turso repositories", async () => {
    const send = vi.fn().mockResolvedValue({ Parameter: { Value: "secret-token" } });
    const batch = vi.fn().mockResolvedValue([]);
    const execute = vi.fn().mockResolvedValue({
      rows: [],
      rowsAffected: 0,
    } as unknown as ResultSet);
    const client = { batch, execute } as unknown as Client;
    const createClient = vi.fn().mockReturnValue(client);
    const resolve = createControlDataRepositoryResolver({
      env: {
        CONTROL_DATA_BACKEND: "turso",
        TURSO_DATABASE_URL: "libsql://example.turso.io",
        TURSO_AUTH_TOKEN_PARAMETER_NAME: "/tenkacloud/dev/turso-token",
      },
      ssm: { send },
      createClient,
    });

    const first = await resolve(input);
    const second = await resolve(input);

    expect(first).toBe(second);
    expect(first.events).toBeInstanceOf(MirroredEventsRepository);
    expect(first.teams).toBeInstanceOf(MirroredTeamsRepository);
    expect(first.notifications).toBeInstanceOf(MirroredNotificationsRepository);
    expect(first.featureFlags).toBeInstanceOf(MirroredFeatureFlagsRepository);
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

  it("should fail before network access when remote configuration is incomplete", async () => {
    const send = vi.fn();
    const resolve = createControlDataRepositoryResolver({
      env: { CONTROL_DATA_BACKEND: "turso" },
      ssm: { send },
      createClient: vi.fn(),
    });

    await expect(resolve(input)).rejects.toThrow(/TURSO_DATABASE_URL is required/);
    expect(send).not.toHaveBeenCalled();
  });

  it("should reject an unknown runtime backend before network access", async () => {
    const send = vi.fn();
    const resolve = createControlDataRepositoryResolver({
      env: { CONTROL_DATA_BACKEND: "postgres" },
      ssm: { send },
      createClient: vi.fn(),
    });

    await expect(resolve(input)).rejects.toThrow(/Unknown CONTROL_DATA_BACKEND/);
    expect(send).not.toHaveBeenCalled();
  });

  it("should fail closed when the SecureString is absent or empty", async () => {
    const resolve = createControlDataRepositoryResolver({
      env: {
        CONTROL_DATA_BACKEND: "turso",
        TURSO_DATABASE_URL: "libsql://example.turso.io",
        TURSO_AUTH_TOKEN_PARAMETER_NAME: "/tenkacloud/dev/turso-token",
      },
      ssm: { send: vi.fn().mockResolvedValue({ Parameter: { Value: " " } }) },
      createClient: vi.fn(),
    });

    await expect(resolve(input)).rejects.toThrow(/auth token not found in SSM SecureString/);
  });
});
