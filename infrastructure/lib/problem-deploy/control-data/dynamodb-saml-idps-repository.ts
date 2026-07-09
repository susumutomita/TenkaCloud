import {
  DeleteCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import type { IdpScope } from "../../control-plane/handlers/idp-handler/core.js";
import type { SamlIdpRecord, SamlIdpsRepository } from "./types.js";

/**
 * [Issue #2442 / Phase C5] DynamoDB implementation of {@link SamlIdpsRepository}.
 * Verbatim relocation of `control-plane/handlers/idp-handler/ddb-store.ts`'s
 * `createDdbIdpStore` — same table, same **lower-case** `pk`/`sk` keys, same
 * marshalling. It is the default backend — flipping to SQLite is a one-flag
 * rollback (`CONTROL_DATA_BACKEND`).
 *
 * Physical shape (unchanged, `saml-idps-table.ts`):
 *   pk = `SYSTEM` | tenantId / sk = idpId
 *
 * No GSI — `list` is a single base-table Query per scope.
 */
const SYSTEM_SCOPE_KEY = "SYSTEM";

function scopePkPrefix(scope: IdpScope): string {
  return scope.kind === "system" ? SYSTEM_SCOPE_KEY : scope.tenantId;
}

/** Strip the two lower-case physical DDB keys, yielding the domain {@link SamlIdpRecord}. */
function hydrate(item: Record<string, unknown>): SamlIdpRecord {
  const { pk: _pk, sk: _sk, ...rest } = item;
  return rest as unknown as SamlIdpRecord;
}

export class DynamoDbSamlIdpsRepository implements SamlIdpsRepository {
  constructor(
    private readonly ddb: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async list(scope: IdpScope): Promise<readonly SamlIdpRecord[]> {
    const res = await this.ddb.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": scopePkPrefix(scope) },
      }),
    );
    const items = (res.Items ?? []) as Array<Record<string, unknown>>;
    return items.map(hydrate);
  }

  async get(scope: IdpScope, idpId: string): Promise<SamlIdpRecord | null> {
    const res = await this.ddb.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: scopePkPrefix(scope), sk: idpId },
      }),
    );
    if (!res.Item) return null;
    return hydrate(res.Item as Record<string, unknown>);
  }

  async put(scope: IdpScope, config: SamlIdpRecord): Promise<void> {
    await this.ddb.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: scopePkPrefix(scope),
          sk: config.idpId,
          ...config,
        },
      }),
    );
  }

  async delete(scope: IdpScope, idpId: string): Promise<void> {
    await this.ddb.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { pk: scopePkPrefix(scope), sk: idpId },
      }),
    );
  }
}
