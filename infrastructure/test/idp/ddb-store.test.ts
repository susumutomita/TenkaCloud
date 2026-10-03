import {
  DeleteCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import type { SamlIdpConfig } from "@tenkacloud/saml-utils";
import { describe, expect, it } from "vitest";
import { createSeamIdpStore } from "../../lib/shared/idp/ddb-store";
import { makeTestControlDataRuntime } from "../problem-deploy/control-data/runtime.test-helpers";

/**
 * The retained cloud IdP handler selects its repository through the injected runtime.
 * Exercise the actual DynamoDB backend with a local DocumentClient fake. SQL backend
 * parity is covered by problem-deploy/control-data/saml-idps-repository-parity.test.ts.
 */

const TABLE = "SamlIdps";

/** Lower-case-keyed fake DocumentClient (pk/sk) — mirrors the control-data test suite's fake. */
function makeFakeIdpDdb(): DynamoDBDocumentClient {
  const store = new Map<string, Record<string, unknown>>();
  const keyOf = (pk: unknown, sk: unknown): string => `${String(pk)} ${String(sk)}`;
  const send = async (cmd: unknown): Promise<unknown> => {
    if (cmd instanceof PutCommand) {
      const item = cmd.input.Item as Record<string, unknown>;
      store.set(keyOf(item.pk, item.sk), item);
      return {};
    }
    if (cmd instanceof GetCommand) {
      const key = cmd.input.Key as Record<string, unknown>;
      return { Item: store.get(keyOf(key.pk, key.sk)) };
    }
    if (cmd instanceof DeleteCommand) {
      const key = cmd.input.Key as Record<string, unknown>;
      store.delete(keyOf(key.pk, key.sk));
      return {};
    }
    if (cmd instanceof QueryCommand) {
      const pk = cmd.input.ExpressionAttributeValues?.[":pk"];
      return { Items: [...store.values()].filter((it) => it.pk === pk) };
    }
    throw new Error("FakeIdpDdb: unsupported command");
  };
  return { send } as unknown as DynamoDBDocumentClient;
}

function record(over: Partial<SamlIdpConfig> = {}): SamlIdpConfig {
  return {
    idpId: "okta",
    displayName: "Okta",
    metadataXml: "<EntityDescriptor/>",
    attributeMapping: { email: "email" },
    groupToRole: { admins: "TenantAdmin" },
    tenantId: "tenant-a",
    createdAt: "2026-07-08T12:00:00.000Z",
    updatedAt: "2026-07-08T12:00:00.000Z",
    ...over,
  };
}

describe("createSeamIdpStore (default dynamodb backend)", () => {
  it("should round-trip put/get/list/delete via the resolved DynamoDB backend", async () => {
    const store = createSeamIdpStore({
      runtime: makeTestControlDataRuntime(),
      ddb: makeFakeIdpDdb(),
      tableName: TABLE,
    });
    const scope = { kind: "tenant" as const, tenantId: "tenant-a" };

    await store.put(scope, record());
    expect(await store.get(scope, "okta")).toEqual(record());
    expect(await store.list(scope)).toEqual([record()]);

    await store.delete(scope, "okta");
    expect(await store.get(scope, "okta")).toBeNull();
  });

  it("should normalize an empty tableName ('' — pure SQL cold start default) to undefined and fail loud under the dynamodb backend", async () => {
    const store = createSeamIdpStore({
      runtime: makeTestControlDataRuntime(),
      ddb: makeFakeIdpDdb(),
      tableName: "",
    });
    const scope = { kind: "tenant" as const, tenantId: "tenant-a" };

    await expect(store.list(scope)).rejects.toThrow(/dynamodb backend requires/);
  });
});
