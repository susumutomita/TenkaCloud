import {
  DeleteCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import type { SamlIdpConfig } from "@tenkacloud/saml-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDdbIdpStore,
  createSeamIdpStore,
} from "../../lib/control-plane/handlers/idp-handler/ddb-store";
import { DynamoDbSamlIdpsRepository } from "../../lib/problem-deploy/control-data/dynamodb-saml-idps-repository";

/**
 * [Issue #2442 / Phase C5] `createDdbIdpStore` / `createSeamIdpStore` coverage.
 *
 * `createDdbIdpStore` is the backward-compatible wrapper that always forces the
 * DynamoDB backend (existing tests / callers that want DDB regardless of
 * `CONTROL_DATA_BACKEND`) — pinned here to be backed by the canonical
 * {@link DynamoDbSamlIdpsRepository}.
 *
 * `createSeamIdpStore` is what both Lambda entry points actually wire. It is
 * exercised here only against the **default (dynamodb) backend** — the deeper
 * five-value `CONTROL_DATA_BACKEND` selection logic is already fully covered by
 * `resolveSamlIdpsRepository (runtime)` in
 * `test/problem-deploy/control-data/saml-idps-repository.test.ts` against a
 * locally constructed `createControlDataRuntime`, not the process-wide
 * singleton this file delegates to — hitting `turso`/`sql` through the real
 * singleton here would require live SSM / libSQL network calls.
 */

const TABLE = "SamlIdps";

/** Lower-case-keyed fake DocumentClient (pk/sk) — mirrors the control-data test suite's fake. */
function makeFakeIdpDdb(): DynamoDBDocumentClient {
  const store = new Map<string, Record<string, unknown>>();
  const keyOf = (pk: unknown, sk: unknown): string => `${String(pk)} ${String(sk)}`;
  // biome-ignore lint/suspicious/noExplicitAny: fake dispatches by command class.
  const send = async (cmd: any): Promise<unknown> => {
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
    throw new Error(`FakeIdpDdb: unsupported command ${cmd?.constructor?.name}`);
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

describe("createDdbIdpStore", () => {
  it("should be backed by DynamoDbSamlIdpsRepository", () => {
    const store = createDdbIdpStore({ ddb: makeFakeIdpDdb(), tableName: TABLE });
    expect(store).toBeInstanceOf(DynamoDbSamlIdpsRepository);
  });

  it("should put/get/delete through the DynamoDB backend", async () => {
    const store = createDdbIdpStore({ ddb: makeFakeIdpDdb(), tableName: TABLE });
    const scope = { kind: "tenant" as const, tenantId: "tenant-a" };

    await store.put(scope, record());
    expect(await store.get(scope, "okta")).toEqual(record());

    await store.delete(scope, "okta");
    expect(await store.get(scope, "okta")).toBeNull();
  });
});

describe("createSeamIdpStore (default dynamodb backend)", () => {
  const ORIGINAL_BACKEND = process.env.CONTROL_DATA_BACKEND;

  beforeEach(() => {
    delete process.env.CONTROL_DATA_BACKEND;
  });
  afterEach(() => {
    if (ORIGINAL_BACKEND === undefined) delete process.env.CONTROL_DATA_BACKEND;
    else process.env.CONTROL_DATA_BACKEND = ORIGINAL_BACKEND;
  });

  it("should round-trip put/get/list/delete via the resolved DynamoDB backend", async () => {
    const store = createSeamIdpStore({ ddb: makeFakeIdpDdb(), tableName: TABLE });
    const scope = { kind: "tenant" as const, tenantId: "tenant-a" };

    await store.put(scope, record());
    expect(await store.get(scope, "okta")).toEqual(record());
    expect(await store.list(scope)).toEqual([record()]);

    await store.delete(scope, "okta");
    expect(await store.get(scope, "okta")).toBeNull();
  });

  it("should normalize an empty tableName ('' — pure SQL cold start default) to undefined and fail loud under the dynamodb backend", async () => {
    const store = createSeamIdpStore({ ddb: makeFakeIdpDdb(), tableName: "" });
    const scope = { kind: "tenant" as const, tenantId: "tenant-a" };

    await expect(store.list(scope)).rejects.toThrow(/dynamodb backend requires/);
  });
});
