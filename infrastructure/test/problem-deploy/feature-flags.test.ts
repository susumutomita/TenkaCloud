import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import {
  FeatureFlagsPatchSchema,
  getFeatureFlags,
  putFeatureFlags,
} from "../../lib/problem-deploy/handlers/event-handler/feature-flags";
import type { EventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared";

const NOW_MS = 1_700_000_000_000;
const NOW_ISO = new Date(NOW_MS).toISOString();

function buildShared(): { shared: EventSharedResources; ddbSend: ReturnType<typeof vi.fn> } {
  const ddbSend = vi.fn();
  const shared: EventSharedResources = {
    eventsTableName: "TestEvents",
    teamsTableName: "TestTeams",
    deploymentsTableName: "TestDeployments",
    eventBusName: "TestBus",
    ddb: { send: ddbSend } as unknown as EventSharedResources["ddb"],
    events: {} as EventSharedResources["events"],
    problemsCatalog: {},
  };
  return { shared, ddbSend };
}

describe("getFeatureFlags", () => {
  it("should return the stored flags map for a tenant with a saved row", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: { flags: { samlSso: true, redTeam: false } } });

    const flags = await getFeatureFlags(shared, "t1");

    expect(flags).toEqual({ samlSso: true, redTeam: false });
    const cmd = ddbSend.mock.calls[0]?.[0] as GetCommand;
    expect(cmd).toBeInstanceOf(GetCommand);
    expect(cmd.input.TableName).toBe("TestEvents");
    expect(cmd.input.Key).toEqual({ PK: "TENANT#t1", SK: "FLAGS" });
  });

  it("should return {} when the tenant has never saved an override (registry defaults apply)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: undefined });

    const flags = await getFeatureFlags(shared, "t1");

    expect(flags).toEqual({});
  });
});

describe("putFeatureFlags", () => {
  it("should Put a full-replace item keyed by tenant and return the saved flags", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({});

    const flags = await putFeatureFlags(
      shared,
      "t1",
      { samlSso: true, nonAwsRuntime: false },
      "sub-admin",
      NOW_MS,
    );

    expect(flags).toEqual({ samlSso: true, nonAwsRuntime: false });
    const cmd = ddbSend.mock.calls[0]?.[0] as PutCommand;
    expect(cmd).toBeInstanceOf(PutCommand);
    expect(cmd.input.TableName).toBe("TestEvents");
    expect(cmd.input.Item).toEqual({
      PK: "TENANT#t1",
      SK: "FLAGS",
      tenantId: "t1",
      flags: { samlSso: true, nonAwsRuntime: false },
      updatedAt: NOW_ISO,
      updatedBy: "sub-admin",
    });
  });

  it("should overwrite a previously saved flag set (full-replace, not merge)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({});

    await putFeatureFlags(shared, "t1", { samlSso: false }, "sub-admin", NOW_MS);

    const cmd = ddbSend.mock.calls[0]?.[0] as PutCommand;
    // No ConditionExpression / merge semantics — the new Item replaces whatever was there,
    // so a stale client can't resurrect a flag another admin just turned off via UpdateExpression ADD.
    expect(cmd.input.ConditionExpression).toBeUndefined();
    expect((cmd.input.Item as { flags: unknown }).flags).toEqual({ samlSso: false });
  });
});

describe("FeatureFlagsPatchSchema", () => {
  it("should accept an object of identifier keys to boolean values", () => {
    const result = FeatureFlagsPatchSchema.safeParse({ samlSso: true, redTeam: false });
    expect(result.success).toBe(true);
  });

  it("should accept an empty object (clearing all overrides)", () => {
    expect(FeatureFlagsPatchSchema.safeParse({}).success).toBe(true);
  });

  it("should reject a non-boolean value", () => {
    const result = FeatureFlagsPatchSchema.safeParse({ samlSso: "true" });
    expect(result.success).toBe(false);
  });

  it("should reject a key that does not look like an identifier", () => {
    const result = FeatureFlagsPatchSchema.safeParse({ "saml-sso": true });
    expect(result.success).toBe(false);
  });

  it("should reject more than the max allowed keys", () => {
    const tooMany = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`flag${i}`, true]));
    const result = FeatureFlagsPatchSchema.safeParse(tooMany);
    expect(result.success).toBe(false);
  });
});
