import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

export type TenantInventoryRow = Readonly<Record<string, unknown>>;

export interface TenantRegistrationBackfillEntry {
  readonly tenantId: string;
  readonly tenantRegistrationId: string;
  readonly tenantRegistrationData: {
    readonly registrationStatus: string;
  };
  readonly active: boolean;
  readonly expectedTenantStatus: string;
  readonly expectedActiveAttribute: "sbtaws_active" | "isActive";
}

export interface TenantRegistrationBackfillPlan {
  readonly registrations: readonly TenantRegistrationBackfillEntry[];
  readonly skipped: readonly string[];
  readonly blockers: readonly string[];
}

interface MutableTenantRegistrationBackfillPlan {
  registrations: TenantRegistrationBackfillEntry[];
  skipped: string[];
  blockers: string[];
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function resolveActive(
  row: TenantInventoryRow,
): { readonly attribute: "sbtaws_active" | "isActive"; readonly value: boolean } | undefined {
  if (typeof row.sbtaws_active === "boolean") {
    return { attribute: "sbtaws_active", value: row.sbtaws_active };
  }
  if (typeof row.isActive === "boolean") {
    return { attribute: "isActive", value: row.isActive };
  }
  return undefined;
}

interface RegistrationIndexes {
  readonly byRegistrationId: Map<string, TenantInventoryRow>;
  readonly registrationIdsByTenantId: Map<string, string[]>;
}

interface TenantLifecycleSnapshot {
  readonly tenantStatus: string;
  readonly active: {
    readonly attribute: "sbtaws_active" | "isActive";
    readonly value: boolean;
  };
}

function indexRegistrationInventory(
  inventory: readonly TenantInventoryRow[],
  blockers: string[],
): RegistrationIndexes {
  const byRegistrationId = new Map<string, TenantInventoryRow>();
  const registrationIdsByTenantId = new Map<string, string[]>();
  for (const [index, row] of inventory.entries()) {
    const registrationId = nonEmptyString(row.tenantRegistrationId);
    if (!registrationId) {
      blockers.push(`registration row ${index} has no tenantRegistrationId`);
      continue;
    }
    if (byRegistrationId.has(registrationId)) {
      blockers.push(`duplicate tenantRegistrationId ${registrationId}`);
      continue;
    }
    byRegistrationId.set(registrationId, row);
    const tenantId = nonEmptyString(row.tenantId);
    if (!tenantId) continue;
    const registrationIds = registrationIdsByTenantId.get(tenantId) ?? [];
    registrationIds.push(registrationId);
    registrationIdsByTenantId.set(tenantId, registrationIds);
  }
  return { byRegistrationId, registrationIdsByTenantId };
}

function resolveLifecycleSnapshot(
  row: TenantInventoryRow,
  tenantId: string,
  blockers: string[],
): TenantLifecycleSnapshot | undefined {
  const tenantStatus = nonEmptyString(row.tenantStatus);
  const active = resolveActive(row);
  if (!tenantStatus) blockers.push(`tenant ${tenantId} has no tenantStatus`);
  if (!active) blockers.push(`tenant ${tenantId} has no boolean sbtaws_active or isActive`);
  return tenantStatus && active ? { tenantStatus, active } : undefined;
}

function planUnlinkedTenant(
  tenantId: string,
  snapshot: TenantLifecycleSnapshot,
  reverseRegistrationIds: readonly string[],
  registrationIndexes: RegistrationIndexes,
  plan: MutableTenantRegistrationBackfillPlan,
): void {
  const backfillRegistrationId = `legacy-${tenantId}`;
  if (registrationIndexes.byRegistrationId.has(backfillRegistrationId)) {
    plan.blockers.push(`tenant ${tenantId} backfill id ${backfillRegistrationId} already exists`);
    return;
  }
  if (reverseRegistrationIds.length === 1) {
    plan.blockers.push(
      `tenant ${tenantId} has registration link ${reverseRegistrationIds[0]} but no tenantRegistrationId`,
    );
    return;
  }
  if (reverseRegistrationIds.length > 1) {
    plan.blockers.push(
      `tenant ${tenantId} has multiple registration links: ${reverseRegistrationIds.join(", ")}`,
    );
    return;
  }
  plan.registrations.push({
    tenantId,
    tenantRegistrationId: backfillRegistrationId,
    tenantRegistrationData: {
      registrationStatus: snapshot.tenantStatus,
    },
    active: snapshot.active.value,
    expectedTenantStatus: snapshot.tenantStatus,
    expectedActiveAttribute: snapshot.active.attribute,
  });
}

function validateExistingRegistration(
  tenantId: string,
  currentRegistrationId: string,
  reverseRegistrationIds: readonly string[],
  registrationIndexes: RegistrationIndexes,
  verifyRegistrationInventory: boolean,
  plan: MutableTenantRegistrationBackfillPlan,
): void {
  const currentRegistration = registrationIndexes.byRegistrationId.get(currentRegistrationId);
  if (verifyRegistrationInventory && !currentRegistration) {
    plan.blockers.push(
      `tenant ${tenantId} references missing registration ${currentRegistrationId}`,
    );
    return;
  }
  const linkedTenantId = nonEmptyString(currentRegistration?.tenantId);
  if (linkedTenantId && linkedTenantId !== tenantId) {
    plan.blockers.push(
      `registration ${currentRegistrationId} links ${linkedTenantId}, not ${tenantId}`,
    );
    return;
  }
  if (
    verifyRegistrationInventory &&
    (reverseRegistrationIds.length !== 1 || reverseRegistrationIds[0] !== currentRegistrationId)
  ) {
    plan.blockers.push(
      `tenant ${tenantId} has multiple registration links: ${reverseRegistrationIds.join(", ")}`,
    );
    return;
  }
  plan.skipped.push(tenantId);
}

function planTenantRow(
  row: TenantInventoryRow,
  index: number,
  tenantIds: Set<string>,
  registrationIndexes: RegistrationIndexes,
  verifyRegistrationInventory: boolean,
  plan: MutableTenantRegistrationBackfillPlan,
): void {
  const tenantId = nonEmptyString(row.tenantId);
  if (!tenantId) {
    plan.blockers.push(`tenant row ${index} has no tenantId`);
    return;
  }
  if (tenantIds.has(tenantId)) {
    plan.blockers.push(`duplicate tenantId ${tenantId}`);
    return;
  }
  tenantIds.add(tenantId);

  const snapshot = resolveLifecycleSnapshot(row, tenantId, plan.blockers);
  if (!snapshot) return;

  const currentRegistrationId = nonEmptyString(row.tenantRegistrationId);
  const reverseRegistrationIds = registrationIndexes.registrationIdsByTenantId.get(tenantId) ?? [];
  if (!currentRegistrationId) {
    planUnlinkedTenant(tenantId, snapshot, reverseRegistrationIds, registrationIndexes, plan);
    return;
  }

  validateExistingRegistration(
    tenantId,
    currentRegistrationId,
    reverseRegistrationIds,
    registrationIndexes,
    verifyRegistrationInventory,
    plan,
  );
}

function reportOrphanRegistrations(
  existingRegistrations: ReadonlyMap<string, TenantInventoryRow>,
  tenantIds: ReadonlySet<string>,
  blockers: string[],
): void {
  for (const [registrationId, row] of existingRegistrations) {
    const tenantId = nonEmptyString(row.tenantId);
    if (!tenantId) blockers.push(`registration ${registrationId} has no tenantId`);
    else if (!tenantIds.has(tenantId)) {
      blockers.push(`registration ${registrationId} references missing tenant ${tenantId}`);
    }
  }
}

/**
 * Builds a deterministic, reviewable migration plan. Passing registrationInventory enables
 * cross-table integrity checks; the operator CLI always supplies it.
 */
export function planTenantRegistrationBackfill(
  tenantInventory: readonly TenantInventoryRow[],
  registrationInventory?: readonly TenantInventoryRow[],
): TenantRegistrationBackfillPlan {
  const plan: MutableTenantRegistrationBackfillPlan = {
    registrations: [],
    skipped: [],
    blockers: [],
  };
  const registrationIndexes = indexRegistrationInventory(
    registrationInventory ?? [],
    plan.blockers,
  );
  const tenantIds = new Set<string>();
  for (const [index, row] of tenantInventory.entries()) {
    planTenantRow(
      row,
      index,
      tenantIds,
      registrationIndexes,
      registrationInventory !== undefined,
      plan,
    );
  }
  if (registrationInventory) {
    reportOrphanRegistrations(registrationIndexes.byRegistrationId, tenantIds, plan.blockers);
  }
  return plan;
}

export interface TenantRegistrationBackfillSender {
  send(command: TransactWriteCommand): Promise<unknown>;
}

export async function applyTenantRegistrationBackfill(
  client: TenantRegistrationBackfillSender,
  input: {
    readonly tenantDetailsTableName: string;
    readonly tenantRegistrationTableName: string;
    readonly plan: TenantRegistrationBackfillPlan;
    readonly apply: boolean;
  },
): Promise<{ readonly applied: number }> {
  if (!input.apply) return { applied: 0 };
  if (input.plan.blockers.length > 0) {
    throw new Error(`backfill blocked by ${input.plan.blockers.length} inventory error(s)`);
  }

  let applied = 0;
  for (const entry of input.plan.registrations) {
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: input.tenantRegistrationTableName,
              Item: {
                tenantRegistrationId: entry.tenantRegistrationId,
                tenantId: entry.tenantId,
                sbtaws_active: entry.active,
                ...entry.tenantRegistrationData,
              },
              ConditionExpression: "attribute_not_exists(tenantRegistrationId)",
            },
          },
          {
            Update: {
              TableName: input.tenantDetailsTableName,
              Key: { tenantId: entry.tenantId },
              UpdateExpression:
                "SET tenantRegistrationId = :registrationId, sbtaws_active = :active",
              ExpressionAttributeValues: {
                ":registrationId": entry.tenantRegistrationId,
                ":active": entry.active,
                ":expectedTenantStatus": entry.expectedTenantStatus,
                ":expectedActive": entry.active,
              },
              ExpressionAttributeNames: {
                "#active": entry.expectedActiveAttribute,
              },
              ConditionExpression:
                "attribute_exists(tenantId) AND attribute_not_exists(tenantRegistrationId) AND tenantStatus = :expectedTenantStatus AND #active = :expectedActive",
            },
          },
        ],
      }),
    );
    applied += 1;
  }
  return { applied };
}
