import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import {
  applyTenantRegistrationBackfill,
  planTenantRegistrationBackfill,
} from "../../../scripts/lib/tenant-registration-backfill";
import {
  parseTenantRegistrationBackfillArgs,
  validateTenantRegistrationBackfillTargets,
} from "../../../scripts/ops/backfill-tenant-registrations";

describe("tenant-registration backfill", () => {
  it("should plan deterministic registration rows for legacy tenants only", () => {
    const plan = planTenantRegistrationBackfill([
      {
        tenantId: "tenant-a",
        tenantName: "A",
        tenantStatus: "Complete",
        isActive: true,
      },
      {
        tenantId: "tenant-b",
        tenantRegistrationId: "registration-b",
        tenantStatus: "Complete",
        isActive: true,
      },
    ]);

    expect(plan.blockers).toEqual([]);
    expect(plan.skipped).toEqual(["tenant-b"]);
    expect(plan.registrations).toEqual([
      {
        tenantId: "tenant-a",
        tenantRegistrationId: "legacy-tenant-a",
        tenantRegistrationData: {
          registrationStatus: "Complete",
        },
        active: true,
        expectedTenantStatus: "Complete",
        expectedActiveAttribute: "isActive",
      },
    ]);
  });

  it("should report malformed source rows as blockers instead of hiding them", () => {
    const plan = planTenantRegistrationBackfill([
      { tenantName: "missing id" },
      { tenantId: "", tenantName: "blank id" },
    ]);

    expect(plan.registrations).toEqual([]);
    expect(plan.blockers).toHaveLength(2);
  });

  it("should block duplicate tenants and inconsistent cross-table links", () => {
    const plan = planTenantRegistrationBackfill(
      [
        { tenantId: "duplicate", tenantStatus: "Complete", isActive: true },
        { tenantId: "duplicate", tenantStatus: "Complete", isActive: true },
        {
          tenantId: "missing-registration",
          tenantRegistrationId: "r-missing",
          tenantStatus: "Complete",
          isActive: true,
        },
        {
          tenantId: "wrong-link",
          tenantRegistrationId: "r-wrong",
          tenantStatus: "Complete",
          isActive: true,
        },
      ],
      [
        { tenantRegistrationId: "r-wrong", tenantId: "someone-else" },
        { tenantRegistrationId: "r-orphan", tenantId: "orphan" },
        { tenantId: "malformed-registration" },
      ],
    );

    expect(plan.blockers).toEqual(
      expect.arrayContaining([
        "registration row 2 has no tenantRegistrationId",
        "duplicate tenantId duplicate",
        "tenant missing-registration references missing registration r-missing",
        "registration r-wrong links someone-else, not wrong-link",
        "registration r-wrong references missing tenant someone-else",
        "registration r-orphan references missing tenant orphan",
      ]),
    );
  });

  it("should preserve lifecycle activity flags and deleted status", () => {
    const plan = planTenantRegistrationBackfill([
      { tenantId: "sbt-inactive", tenantStatus: "Complete", sbtaws_active: false },
      { tenantId: "legacy-inactive", tenantStatus: "Complete", isActive: false },
      { tenantId: "deleted", tenantStatus: "Deleted", isActive: false },
      { tenantId: "deprovisioned", tenantStatus: "deprovisioned", isActive: false },
      { tenantId: "active", tenantStatus: "Complete", isActive: true },
    ]);

    expect(plan.registrations.map(({ tenantId, active }) => [tenantId, active])).toEqual([
      ["sbt-inactive", false],
      ["legacy-inactive", false],
      ["deleted", false],
      ["deprovisioned", false],
      ["active", true],
    ]);
    expect(plan.registrations.at(-1)?.tenantRegistrationData.registrationStatus).toBe("Complete");
  });

  it("should block tenants whose scanned status or activity is missing", () => {
    const plan = planTenantRegistrationBackfill([
      { tenantId: "missing-status", isActive: true },
      { tenantId: "missing-active", tenantStatus: "Complete" },
    ]);

    expect(plan.registrations).toEqual([]);
    expect(plan.blockers).toEqual(
      expect.arrayContaining([
        "tenant missing-status has no tenantStatus",
        "tenant missing-active has no boolean sbtaws_active or isActive",
      ]),
    );
  });

  it("should skip a tenant whose registration inventory has the matching link", () => {
    const plan = planTenantRegistrationBackfill(
      [
        {
          tenantId: "tenant-a",
          tenantRegistrationId: "registration-a",
          tenantStatus: "Complete",
          sbtaws_active: true,
        },
      ],
      [{ tenantRegistrationId: "registration-a", tenantId: "tenant-a" }],
    );

    expect(plan).toEqual({
      registrations: [],
      skipped: ["tenant-a"],
      blockers: [],
    });
  });

  it("should block a deterministic registration id that already exists", () => {
    const plan = planTenantRegistrationBackfill(
      [{ tenantId: "tenant-a", tenantStatus: "Complete", sbtaws_active: true }],
      [{ tenantRegistrationId: "legacy-tenant-a", tenantId: "tenant-a" }],
    );

    expect(plan.registrations).toEqual([]);
    expect(plan.blockers).toContain("tenant tenant-a backfill id legacy-tenant-a already exists");
  });

  it("should block reverse links and multiple registrations for one tenant", () => {
    const plan = planTenantRegistrationBackfill(
      [
        { tenantId: "unlinked", tenantStatus: "Complete", sbtaws_active: true },
        {
          tenantId: "multiple",
          tenantRegistrationId: "registration-a",
          tenantStatus: "Complete",
          sbtaws_active: true,
        },
      ],
      [
        { tenantRegistrationId: "unlinked-registration", tenantId: "unlinked" },
        { tenantRegistrationId: "registration-a", tenantId: "multiple" },
        { tenantRegistrationId: "registration-b", tenantId: "multiple" },
      ],
    );

    expect(plan.registrations).toEqual([]);
    expect(plan.blockers).toEqual(
      expect.arrayContaining([
        "tenant unlinked has registration link unlinked-registration but no tenantRegistrationId",
        "tenant multiple has multiple registration links: registration-a, registration-b",
      ]),
    );
  });

  it("should default to no writes in dry-run mode", async () => {
    const send = vi.fn();
    const plan = planTenantRegistrationBackfill([
      { tenantId: "tenant-a", tenantStatus: "Complete", isActive: true },
    ]);

    await applyTenantRegistrationBackfill(
      { send },
      {
        tenantDetailsTableName: "tenant-details",
        tenantRegistrationTableName: "tenant-registrations",
        plan,
        apply: false,
      },
    );

    expect(send).not.toHaveBeenCalled();
  });

  it("should atomically create registration and link source tenant in apply mode", async () => {
    const send = vi.fn().mockResolvedValue({});
    const plan = planTenantRegistrationBackfill([
      { tenantId: "tenant-a", tenantStatus: "Complete", sbtaws_active: true },
    ]);

    await applyTenantRegistrationBackfill(
      { send },
      {
        tenantDetailsTableName: "tenant-details",
        tenantRegistrationTableName: "tenant-registrations",
        plan,
        apply: true,
      },
    );

    expect(send).toHaveBeenCalledOnce();
    const command = send.mock.calls[0][0];
    expect(command).toBeInstanceOf(TransactWriteCommand);
    expect(command.input.TransactItems).toEqual([
      expect.objectContaining({
        Put: expect.objectContaining({
          TableName: "tenant-registrations",
          ConditionExpression: "attribute_not_exists(tenantRegistrationId)",
        }),
      }),
      expect.objectContaining({
        Update: expect.objectContaining({
          TableName: "tenant-details",
          ConditionExpression:
            "attribute_exists(tenantId) AND attribute_not_exists(tenantRegistrationId) AND tenantStatus = :expectedTenantStatus AND #active = :expectedActive",
          ExpressionAttributeNames: { "#active": "sbtaws_active" },
          ExpressionAttributeValues: expect.objectContaining({
            ":expectedTenantStatus": "Complete",
            ":expectedActive": true,
          }),
        }),
      }),
    ]);
  });

  it("should refuse apply when the dry-run plan contains blockers", async () => {
    const send = vi.fn();
    const plan = planTenantRegistrationBackfill([{ tenantName: "missing id" }]);

    await expect(
      applyTenantRegistrationBackfill(
        { send },
        {
          tenantDetailsTableName: "tenant-details",
          tenantRegistrationTableName: "tenant-registrations",
          plan,
          apply: true,
        },
      ),
    ).rejects.toThrow("backfill blocked");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("tenant-registration backfill CLI arguments", () => {
  it("should default to dry-run for two distinct exact table names", () => {
    expect(
      parseTenantRegistrationBackfillArgs([
        "--tenant-details-table=tenant-details",
        "--tenant-registration-table=tenant-registrations",
        "--expected-account=123456789012",
        "--expected-region=ap-northeast-1",
        "--environment=production",
      ]),
    ).toEqual({
      tenantDetailsTableName: "tenant-details",
      tenantRegistrationTableName: "tenant-registrations",
      expectedAccountId: "123456789012",
      expectedRegion: "ap-northeast-1",
      environment: "production",
      apply: false,
    });
  });

  it("should reject unknown flags and using the same table twice", () => {
    expect(() =>
      parseTenantRegistrationBackfillArgs([
        "--tenant-details-table=tenant-details",
        "--tenant-registration-table=tenant-registrations",
        "--expected-account=123456789012",
        "--expected-region=ap-northeast-1",
        "--environment=production",
        "--appl",
      ]),
    ).toThrow("Unknown argument");
    expect(() =>
      parseTenantRegistrationBackfillArgs([
        "--tenant-details-table=same-table",
        "--tenant-registration-table=same-table",
        "--expected-account=123456789012",
        "--expected-region=ap-northeast-1",
        "--environment=production",
      ]),
    ).toThrow("must be different");
  });

  it("should require a valid explicit account, region, and environment", () => {
    expect(() =>
      parseTenantRegistrationBackfillArgs([
        "--tenant-details-table=tenant-details",
        "--tenant-registration-table=tenant-registrations",
      ]),
    ).toThrow("--expected-account");
    expect(() =>
      parseTenantRegistrationBackfillArgs([
        "--tenant-details-table=tenant-details",
        "--tenant-registration-table=tenant-registrations",
        "--expected-account=not-an-account",
        "--expected-region=ap-northeast-1",
        "--environment=production",
      ]),
    ).toThrow("12 digit");
  });
});

describe("tenant-registration backfill target guard", () => {
  const args = {
    tenantDetailsTableName: "tenant-details",
    tenantRegistrationTableName: "tenant-registrations",
    expectedAccountId: "123456789012",
    expectedRegion: "ap-northeast-1",
    environment: "production",
    apply: false,
  } as const;
  const metadata = {
    callerAccountId: "123456789012",
    tenantDetails: {
      tableName: "tenant-details",
      tableArn: "arn:aws:dynamodb:ap-northeast-1:123456789012:table/tenant-details",
      partitionKey: "tenantId",
      tags: { Environment: "production", Project: "TenkaCloud" },
    },
    tenantRegistrations: {
      tableName: "tenant-registrations",
      tableArn: "arn:aws:dynamodb:ap-northeast-1:123456789012:table/tenant-registrations",
      partitionKey: "tenantRegistrationId",
      tags: { Environment: "production", Project: "TenkaCloud" },
    },
  } as const;

  it("should accept only the expected account, region, environment, project, and table keys", () => {
    expect(() => validateTenantRegistrationBackfillTargets(args, metadata)).not.toThrow();
  });

  it("should reject a caller-account, environment, or table-key mismatch", () => {
    expect(() =>
      validateTenantRegistrationBackfillTargets(args, {
        ...metadata,
        callerAccountId: "999999999999",
      }),
    ).toThrow("caller account");
    expect(() =>
      validateTenantRegistrationBackfillTargets(args, {
        ...metadata,
        tenantDetails: {
          ...metadata.tenantDetails,
          tags: { ...metadata.tenantDetails.tags, Environment: "staging" },
        },
      }),
    ).toThrow("Environment");
    expect(() =>
      validateTenantRegistrationBackfillTargets(args, {
        ...metadata,
        tenantRegistrations: {
          ...metadata.tenantRegistrations,
          partitionKey: "tenantId",
        },
      }),
    ).toThrow("partition key");
  });
});
