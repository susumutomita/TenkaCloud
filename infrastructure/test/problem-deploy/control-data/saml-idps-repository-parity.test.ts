import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { SamlIdpConfig } from "@tenkacloud/saml-utils";
import { describe, expect, it } from "vitest";
import type { IdpScope } from "../../../lib/control-plane/handlers/idp-handler/core";
import {
  DynamoDbSamlIdpsRepository,
  SqlSamlIdpsRepository,
} from "../../../lib/problem-deploy/control-data/saml-idps-repository";
import type { SamlIdpsRepository } from "../../../lib/problem-deploy/control-data/types";
import { makeSqliteExecutor } from "./control-data-write.test-helpers";

/**
 * [Issue #2442 / Phase C5] Cross-backend parity suite for the SamlIdps seam: the
 * same test body runs against both {@link DynamoDbSamlIdpsRepository} and
 * {@link SqlSamlIdpsRepository}, pinning that a caller sees identical domain
 * behavior regardless of `CONTROL_DATA_BACKEND` (mirrors
 * `problem-endpoints-repository-parity.test.ts`).
 */

const TABLE = "SamlIdps";

/** Lower-case-keyed fake DocumentClient (pk/sk) — see saml-idps-repository.test.ts for rationale. */
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

interface Backend {
  readonly name: string;
  readonly repo: SamlIdpsRepository;
}

const backends: ReadonlyArray<readonly [string, () => Backend]> = [
  [
    "DynamoDbSamlIdpsRepository",
    () => ({
      name: "DynamoDbSamlIdpsRepository",
      repo: new DynamoDbSamlIdpsRepository(makeFakeIdpDdb(), TABLE),
    }),
  ],
  [
    "SqlSamlIdpsRepository",
    () => ({
      name: "SqlSamlIdpsRepository",
      repo: new SqlSamlIdpsRepository(makeSqliteExecutor()),
    }),
  ],
];

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

const tenantScope = (tenantId = "tenant-a"): IdpScope => ({ kind: "tenant", tenantId });
const systemScope: IdpScope = { kind: "system" };

describe.each(backends)("SamlIdpsRepository parity: %s", (_label, makeBackend) => {
  it("should round-trip a put through get", async () => {
    const { repo } = makeBackend();
    await repo.put(tenantScope(), record());

    expect(await repo.get(tenantScope(), "okta")).toEqual(record());
  });

  it("should return null for a scope/idpId with no row", async () => {
    const { repo } = makeBackend();
    expect(await repo.get(tenantScope(), "missing")).toBeNull();
  });

  it("should upsert on a repeat put for the same (scope, idpId)", async () => {
    const { repo } = makeBackend();
    await repo.put(tenantScope(), record({ displayName: "Old" }));
    await repo.put(tenantScope(), record({ displayName: "New" }));

    expect(await repo.get(tenantScope(), "okta")).toEqual(record({ displayName: "New" }));
  });

  it("should scope rows to the exact tenant — no cross-tenant leakage", async () => {
    const { repo } = makeBackend();
    await repo.put(tenantScope(), record({ idpId: "okta" }));
    await repo.put(tenantScope("tenant-b"), record({ idpId: "okta", tenantId: "tenant-b" }));

    const rows = await repo.list(tenantScope());
    expect(rows).toEqual([record({ idpId: "okta" })]);
  });

  it("should keep system and tenant scopes disjoint", async () => {
    const { repo } = makeBackend();
    await repo.put(systemScope, record({ idpId: "okta", tenantId: undefined }));
    await repo.put(tenantScope(), record({ idpId: "okta" }));

    expect(await repo.list(systemScope)).toEqual([record({ idpId: "okta", tenantId: undefined })]);
    expect(await repo.get(systemScope, "okta")).toEqual(
      record({ idpId: "okta", tenantId: undefined }),
    );
  });

  it("should return every idpId for the same scope", async () => {
    const { repo } = makeBackend();
    await repo.put(tenantScope(), record({ idpId: "okta" }));
    await repo.put(tenantScope(), record({ idpId: "azure" }));

    const rows = await repo.list(tenantScope());
    expect(rows.map((r) => r.idpId).sort()).toEqual(["azure", "okta"]);
  });

  it("should delete a row idempotently (delete-then-delete is a no-op)", async () => {
    const { repo } = makeBackend();
    await repo.put(tenantScope(), record());

    await repo.delete(tenantScope(), "okta");
    expect(await repo.get(tenantScope(), "okta")).toBeNull();

    await expect(repo.delete(tenantScope(), "okta")).resolves.toBeUndefined();
  });

  it("should delete only the targeted idpId, leaving sibling IdPs intact", async () => {
    const { repo } = makeBackend();
    await repo.put(tenantScope(), record({ idpId: "okta" }));
    await repo.put(tenantScope(), record({ idpId: "azure" }));

    await repo.delete(tenantScope(), "okta");

    const rows = await repo.list(tenantScope());
    expect(rows).toEqual([record({ idpId: "azure" })]);
  });

  it("should round-trip optional fields (description) without dropping them", async () => {
    const { repo } = makeBackend();
    await repo.put(tenantScope(), record({ description: "Corporate Okta tenant" }));

    expect(await repo.get(tenantScope(), "okta")).toEqual(
      record({ description: "Corporate Okta tenant" }),
    );
  });
});
