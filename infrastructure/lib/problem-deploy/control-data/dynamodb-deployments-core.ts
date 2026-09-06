import {
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  type QueryCommandInput,
  ScanCommand,
  type ScanCommandInput,
  TransactWriteCommand,
  type TransactWriteCommandInput,
  UpdateCommand,
  type UpdateCommandInput,
} from "@aws-sdk/lib-dynamodb";
import {
  compositeTargetGsi3Pk,
  compositeTargetGsi3Sk,
} from "../handlers/deploy-handler/composite-deployment.js";
import { createCursorCodec } from "../handlers/shared/cursor-codec.js";
import type { CoordinationStateScope } from "./domain/coordination-scope.js";
import type {
  CompositeParentDeploymentRecord,
  CompositeTargetDeploymentRecord,
  DeploymentMutationOutcome,
  DeploymentRecord,
  InboxEventRecord,
  ScoreEventRecord,
} from "./types.js";

/**
 * [Issue #2441 / Phase B1] DynamoDB implementation of the Deployments READ seam.
 * A behavior-preserving extraction of the DDB reads the six handler groups
 * already perform (`deploy-handler` / `participant-handler` / `generic-scoring`
 * / `event-handler` / `disruption-executor`): the SAME table, keys, GSIs, and
 * marshalling. It is the default backend — flipping to the SQL backend (B4) is a
 * one-flag rollback (`CONTROL_DATA_BACKEND`).
 *
 * Physical shape (unchanged, `problem-deploy/deployments-table.ts`):
 *   Base:  PK = `DEPLOYMENT#<jobId>`  / SK = `META`
 *            | `EVENT#<isoTs>#<ulid>`   (sparse score events)
 *            | `INBOX#<isoTs>#<ulid>`   (sparse inter-team cast/inbox)
 *          PK = `COORD#<tenantId>#<eventId>` / SK = `STATE` (coordination state)
 *   GSI1:  `TENANT#<tenantId>` / `createdAt`  — tenant listing
 *   GSI2:  `TEAMKEY#<teamLoginKey>` / `createdAt` — sparse, participant login
 *   GSI3:  `PARENT_DEPLOYMENT#<id>` / `ORDINAL#…#TARGET#…` — sparse, composite
 *
 * Every request below is a verbatim relocation of the named pre-seam site — do
 * NOT "improve" an expression here without a dedicated migration issue.
 */

export const DEPLOYMENT_PK_PREFIX = "DEPLOYMENT#" as const;
export const META_SK = "META" as const;
export const EVENT_SK_PREFIX = "EVENT#" as const;
export const INBOX_SK_PREFIX = "INBOX#" as const;
export const COORD_STATE_SK = "STATE" as const;
/**
 * [Issue #3133] The match secret's own sort key, under the same coordination
 * partition as `STATE`.
 *
 * A separate item, not an attribute on the state item, so the secret cannot
 * ride along into a `CoordinationStateRecord`: `readCoordinationState` fetches
 * `STATE` by key and never sees this one.
 */
export const COORD_SECRET_SK = "MATCHSECRET" as const;

/** Base PK for a deployment partition. */
export function deploymentPk(jobId: string): string {
  return `${DEPLOYMENT_PK_PREFIX}${jobId}`;
}

/**
 * [Issue #3123] Rejects a key component that is empty or carries the `#`
 * delimiter.
 *
 * With two components a smuggled `#` was merely ambiguous; with four it aliases
 * namespaces across the tenant boundary — `{tenant: "a#b", event: "c"}` and
 * `{tenant: "a", event: "b#c"}` build the same partition key, so one tenant's
 * coordination state would be served to another. Every id that reaches here is
 * already constrained upstream (`PROBLEM_ID_RE` / `ULID_RE` /
 * `TENANT_ID_RE` in `handlers/shared/constants.ts`) and cannot contain `#`, so
 * this never fires in practice. It is here because "the callers all validate"
 * is an invariant no type carries: this makes the key builder itself fail
 * closed rather than compute a colliding key, the same way `isContextConsistent`
 * guards the dispatcher.
 */
function assertKeyComponent(value: string, field: string): string {
  if (!value) throw new RangeError(`coordination key component ${field} must not be empty`);
  if (value.includes(KEY_DELIMITER)) {
    throw new RangeError(`coordination key component ${field} must not contain "${KEY_DELIMITER}"`);
  }
  return value;
}

const KEY_DELIMITER = "#" as const;

/** COORD# partition key prefix — shared by the scoped and pre-scope key builders. */
export const COORD_PK_PREFIX = "COORD#" as const;

/**
 * COORD# partition key for one {@link CoordinationStateScope} (`coordination-store.ts` `pk`).
 *
 * [Issue #3123] Was `COORD#<tenant>#<event>`, which collided across problems
 * and runs sharing one event.
 */
export function coordinationPk(scope: CoordinationStateScope): string {
  return [
    COORD_PK_PREFIX + assertKeyComponent(scope.tenantId, "tenantId"),
    assertKeyComponent(scope.eventId, "eventId"),
    assertKeyComponent(scope.problemId, "problemId"),
    assertKeyComponent(scope.runId, "runId"),
  ].join(KEY_DELIMITER);
}

/**
 * [Issue #3153] Partition key for a `(tenant, event, problem)` run pointer.
 *
 * A DIFFERENT prefix from {@link coordinationPk}, not a fifth segment under it.
 * The pointer is one level above the runs it names — deleting a run's state must
 * never be able to address the pointer, and `deleteCoordinationState` works by
 * partition key. Sharing a prefix would put the two one typo apart.
 */
export function coordinationRunPk(key: {
  readonly tenantId: string;
  readonly eventId: string;
  readonly problemId: string;
}): string {
  return [
    COORD_RUN_PK_PREFIX + assertKeyComponent(key.tenantId, "tenantId"),
    assertKeyComponent(key.eventId, "eventId"),
    assertKeyComponent(key.problemId, "problemId"),
  ].join(KEY_DELIMITER);
}

/** COORDRUN# partition key prefix. See {@link coordinationRunPk}. */
export const COORD_RUN_PK_PREFIX = "COORDRUN#" as const;

/** Sort key of the run pointer row. */
export const COORD_RUN_SK = "CURRENT" as const;

/**
 * The pre-#3123 two-part key for the same `(tenant, event)`.
 *
 * Only `deleteCoordinationState` uses it, so a torn-down event takes its
 * orphaned pre-scope row with it. Nothing reads through to it — see
 * `DeploymentsCoordinationPort.readCoordinationState`.
 */
export function preScopeCoordinationPk(tenantId: string, eventId: string): string {
  return `${COORD_PK_PREFIX + assertKeyComponent(tenantId, "tenantId")}${KEY_DELIMITER}${assertKeyComponent(eventId, "eventId")}`;
}

/** The physical DDB keys stripped from every returned domain record. */
export const DDB_KEY_ATTRS: ReadonlySet<string> = new Set([
  "PK",
  "SK",
  "GSI1PK",
  "GSI1SK",
  "GSI2PK",
  "GSI2SK",
  "GSI3PK",
  "GSI3SK",
]);

/** Strip the physical DDB keys, yielding a domain record. */
export function stripKeys<T>(item: Record<string, unknown>): T {
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    if (DDB_KEY_ATTRS.has(key)) continue;
    record[key] = value;
  }
  return record as unknown as T;
}

export const itemToRecord = (item: Record<string, unknown>): DeploymentRecord =>
  stripKeys<DeploymentRecord>(item);
export const itemToScoreEvent = (item: Record<string, unknown>): ScoreEventRecord =>
  stripKeys<ScoreEventRecord>(item);
export const itemToInboxEvent = (item: Record<string, unknown>): InboxEventRecord =>
  stripKeys<InboxEventRecord>(item);

export type DeploymentWriteRecord =
  | DeploymentRecord
  | CompositeParentDeploymentRecord
  | CompositeTargetDeploymentRecord;

export function isCompositeParentRecord(
  record: DeploymentWriteRecord,
): record is CompositeParentDeploymentRecord {
  return (record as { runtimeKind?: unknown }).runtimeKind === "composite";
}

export function isCompositeTargetRecord(
  record: DeploymentWriteRecord,
): record is CompositeTargetDeploymentRecord {
  return typeof (record as { parentDeploymentId?: unknown }).parentDeploymentId === "string";
}

/**
 * Re-derive physical keys for META rows from the domain record. Normal
 * deployments get GSI1 plus sparse GSI2 exactly like `deploy.ts`; composite
 * parents stay unindexed, and composite targets get only GSI3 exactly like
 * `composite-repository.ts`.
 */
export function recordToItem(record: DeploymentWriteRecord): Record<string, unknown> {
  const item: Record<string, unknown> = {
    PK: deploymentPk(record.jobId),
    SK: META_SK,
    ...record,
  };
  if (isCompositeParentRecord(record)) return item;
  if (isCompositeTargetRecord(record)) {
    item.GSI3PK = compositeTargetGsi3Pk(record.parentDeploymentId);
    item.GSI3SK = compositeTargetGsi3Sk(record.targetOrdinal, record.targetId);
    return item;
  }
  if (record.teamLoginKeyHash !== undefined) {
    throw new Error("DynamoDB deployments require a plaintext login credential");
  }
  item.GSI1PK = `TENANT#${record.tenantId}`;
  item.GSI1SK = record.createdAt;
  if (record.teamLoginKey) {
    item.GSI2PK = `TEAMKEY#${record.teamLoginKey}`;
    item.GSI2SK = record.createdAt;
  }
  return item;
}

/** Domain `jobId` from a physical base PK (`DEPLOYMENT#<jobId>`). */
export function jobIdFromPk(pk: unknown): string {
  const raw = String(pk ?? "");
  return raw.startsWith(DEPLOYMENT_PK_PREFIX) ? raw.slice(DEPLOYMENT_PK_PREFIX.length) : raw;
}

export function isConditionalCheckFailed(err: unknown): boolean {
  return err instanceof Error && err.name === "ConditionalCheckFailedException";
}

export function isTransactConditionalCheckFailed(err: unknown): boolean {
  if (!(err instanceof Error) || err.name !== "TransactionCanceledException") return false;
  const reasons = (err as { CancellationReasons?: ReadonlyArray<{ Code?: string }> })
    .CancellationReasons;
  return (reasons ?? []).some((reason) => reason?.Code === "ConditionalCheckFailed");
}

/**
 * [#862 / list.ts] The exact allowlist + wire format of the pre-seam
 * `deploy-handler/list.ts` cursor codec (moved here verbatim). Moving the Query
 * into this seam must not invalidate cursors already handed to a UI mid-page.
 */
export const LIST_PAGE_CURSOR_CODEC = createCursorCodec(
  new Set(["PK", "SK", "GSI1PK", "GSI1SK", "GSI2PK", "GSI2SK"]),
);

/**
 * [#2527 Slice 3] Shared DynamoDB engine for the Deployments capability
 * adapters: the backend handle plus the conflict-probe / conditional-write /
 * row-mapping / pagination primitives every capability reuses. Extracted
 * verbatim from the pre-split `DynamoDbDeploymentsRepository`; the capability
 * classes hold one shared instance instead of re-implementing the engine.
 */
export class DynamoDbDeploymentsCore {
  constructor(
    readonly ddb: DynamoDBDocumentClient,
    readonly tableName: string,
  ) {}

  /** Key of the Deployments META row (same derivation as every read above). */
  deploymentKey(jobId: string): { PK: string; SK: string } {
    return { PK: deploymentPk(jobId), SK: META_SK };
  }

  async probeConflict(tenantId: string, jobId: string): Promise<DeploymentMutationOutcome> {
    const record = await this.getDeployment(jobId);
    if (!record || record.tenantId !== tenantId) return { outcome: "not_found" };
    return { outcome: "conflict", record };
  }

  static updatedFrom(attributes: Record<string, unknown> | undefined): DeploymentMutationOutcome {
    if (!attributes) return { outcome: "not_found" };
    return { outcome: "updated", record: itemToRecord(attributes) };
  }

  async conditionalUpdate(
    jobId: string,
    input: Omit<UpdateCommandInput, "TableName" | "Key">,
    onCcf: "conflict" | "not_found" | { readonly probeTenantId: string },
  ): Promise<DeploymentMutationOutcome> {
    try {
      const out = await this.ddb.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: this.deploymentKey(jobId),
          ...input,
        }),
      );
      if (input.ReturnValues === "ALL_NEW") {
        return DynamoDbDeploymentsCore.updatedFrom(out.Attributes);
      }
      return { outcome: "updated" };
    } catch (err) {
      if (!isConditionalCheckFailed(err)) throw err;
      if (onCcf === "conflict") return { outcome: "conflict" };
      if (onCcf === "not_found") return { outcome: "not_found" };
      return this.probeConflict(onCcf.probeTenantId, jobId);
    }
  }

  async conditionalPut(
    record: DeploymentWriteRecord,
    onCcf: "conflict" | { readonly probeTenantId: string },
  ): Promise<DeploymentMutationOutcome> {
    try {
      await this.ddb.send(
        new PutCommand({
          TableName: this.tableName,
          Item: recordToItem(record),
          ConditionExpression: "attribute_not_exists(PK)",
        }),
      );
      return { outcome: "updated", record: record as DeploymentRecord };
    } catch (err) {
      if (!isConditionalCheckFailed(err)) throw err;
      if (onCcf === "conflict") return { outcome: "conflict" };
      return this.probeConflict(onCcf.probeTenantId, record.jobId);
    }
  }

  async transactWrite(input: TransactWriteCommandInput): Promise<DeploymentMutationOutcome> {
    try {
      await this.ddb.send(new TransactWriteCommand(input));
      return { outcome: "updated" };
    } catch (err) {
      if (isTransactConditionalCheckFailed(err)) return { outcome: "conflict" };
      throw err;
    }
  }

  /**
   * Drain every page of a Query, up to `maxPages` (default: all). Mirrors
   * `handlers/shared/ddb-paginate.ts` — the caller must NOT pass
   * `ExclusiveStartKey` (this loop owns it). The per-page callers below hand in
   * the byte-verbatim request; pagination is the only thing added.
   */
  async queryAllPages(
    input: Omit<QueryCommandInput, "TableName" | "ExclusiveStartKey">,
    maxPages = Number.POSITIVE_INFINITY,
  ): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    let pages = 0;
    while (pages < maxPages) {
      const out = await this.ddb.send(
        new QueryCommand({
          TableName: this.tableName,
          ...input,
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }),
      );
      for (const item of (out.Items ?? []) as Record<string, unknown>[]) items.push(item);
      exclusiveStartKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
      pages += 1;
      if (!exclusiveStartKey) break;
    }
    return items;
  }

  /**
   * [Issue #2441 / Phase B3] Drain a full-table Scan, invoking `onPage` once per
   * physical page (mirrors `handlers/shared/ddb-paginate.ts`'s
   * `forEachScanPage`) instead of collecting every row into memory — the
   * per-page callers below depend on this to keep their per-page BatchGet /
   * bounded `Promise.all` fan-out unchanged. The caller must NOT pass
   * `ExclusiveStartKey` (this loop owns it).
   */
  async scanAllPages(
    input: Omit<ScanCommandInput, "TableName" | "ExclusiveStartKey">,
    onPage: (items: Record<string, unknown>[]) => Promise<void>,
  ): Promise<void> {
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const out = await this.ddb.send(
        new ScanCommand({
          TableName: this.tableName,
          ...input,
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }),
      );
      await onPage((out.Items ?? []) as Record<string, unknown>[]);
      exclusiveStartKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (exclusiveStartKey);
  }

  // -- Point reads ----------------------------------------------------------

  async getDeployment(
    jobId: string,
    options?: { readonly consistentRead?: boolean },
  ): Promise<DeploymentRecord | undefined> {
    const out = await this.ddb.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: deploymentPk(jobId), SK: META_SK },
        ...(options?.consistentRead ? { ConsistentRead: true } : {}),
      }),
    );
    const item = out.Item as Record<string, unknown> | undefined;
    if (!item) return undefined;
    return itemToRecord(item);
  }

  /**
   * The shared `SK BETWEEN` drain behind {@link listScoreEventsInRange} /
   * {@link listInboxEventsInRange} — byte-identical to `battle-attacks.ts` /
   * `cast-event.ts` `queryInboxRows` (`:sk_start` / `:sk_end` placeholders,
   * `ScanIndexForward=false`, full drain). The two callers differ only in the
   * `EVENT#` vs `INBOX#` bounds they pass and the record type they map to.
   */
  queryRange(jobId: string, fromSk: string, toSk: string): Promise<Record<string, unknown>[]> {
    return this.queryAllPages({
      KeyConditionExpression: "PK = :pk AND SK BETWEEN :sk_start AND :sk_end",
      ExpressionAttributeValues: {
        ":pk": deploymentPk(jobId),
        ":sk_start": fromSk,
        ":sk_end": toSk,
      },
      ScanIndexForward: false,
    });
  }
}
