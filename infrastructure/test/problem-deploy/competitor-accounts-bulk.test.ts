import { PutParameterCommand } from "@aws-sdk/client-ssm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompetitorAccountsSharedResources } from "../../lib/problem-deploy/handlers/competitor-accounts-handler/shared";
import { bulkCreateCompetitorAccounts } from "../../lib/problem-deploy/handlers/competitor-accounts-handler/store";
import {
  BULK_COMPETITOR_ACCOUNTS_MAX_ENTRIES,
  BulkCreateCompetitorAccountsRequestSchema,
} from "../../lib/problem-deploy/handlers/competitor-accounts-handler/types";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

/**
 * Bulk registration exists because an Organizations-scale event registers
 * dozens of accounts, and doing that one row at a time is the reported pain.
 * The two properties that make it usable at that scale are the ones pinned
 * here: one ExternalId per request (not per row), and one bad row never
 * costing the operator the good ones.
 */

const NOW_MS = 1_700_000_000_000;
const CTX = { tenantId: "tenant-acme", nowMs: NOW_MS, createdBy: "user-sub-1" };

function buildShared(): {
  shared: CompetitorAccountsSharedResources;
  ddbSend: ReturnType<typeof vi.fn>;
  ssmSend: ReturnType<typeof vi.fn>;
} {
  const ddbSend = vi.fn();
  const ssmSend = vi.fn();
  const shared: CompetitorAccountsSharedResources = {
    runtime: makeTestControlDataRuntime(),
    tableName: "TestCompetitorAccounts",
    env: "development",
    tenkaCloudAccountId: "111111111111",
    ddb: { send: ddbSend } as unknown as CompetitorAccountsSharedResources["ddb"],
    ssm: { send: ssmSend } as unknown as CompetitorAccountsSharedResources["ssm"],
    sts: { send: vi.fn() } as unknown as CompetitorAccountsSharedResources["sts"],
  };
  return { shared, ddbSend, ssmSend };
}

/** An SSM double that already holds the tenant's ExternalId. */
function withExistingExternalId(ssmSend: ReturnType<typeof vi.fn>): void {
  ssmSend.mockResolvedValue({ Parameter: { Value: "ext-id-existing" } });
}

const conflict = () =>
  Object.assign(new Error("conflict"), { name: "ConditionalCheckFailedException" });

describe("bulkCreateCompetitorAccounts", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should resolve the tenant ExternalId once for the whole request, not once per row", async () => {
    // Per-row `ensureExternalId` would race on PutParameter(Overwrite:false) the
    // first time a tenant is populated: the first row wins and the rest get
    // ParameterAlreadyExists. Resolving once is what makes a cold tenant's
    // first bulk import work at all.
    const { shared, ddbSend, ssmSend } = buildShared();
    ssmSend
      .mockRejectedValueOnce(Object.assign(new Error("nope"), { name: "ParameterNotFound" }))
      .mockResolvedValueOnce({});
    ddbSend.mockResolvedValue({});

    const out = await bulkCreateCompetitorAccounts(shared, CTX, {
      defaults: { competitorRoleName: "TenkaCloud-acme-deploy-Role" },
      accounts: [
        { awsAccountId: "222222222222" },
        { awsAccountId: "333333333333" },
        { awsAccountId: "444444444444" },
      ],
    });

    const puts = ssmSend.mock.calls.filter(([cmd]) => cmd instanceof PutParameterCommand);
    expect(puts.length).toBe(1);
    expect(out.created).toBe(3);
    expect(ddbSend.mock.calls.length).toBe(3);
    // The one value is handed back once for all three rows.
    const putCommand = puts[0]?.[0] as PutParameterCommand | undefined;
    expect(putCommand).toBeInstanceOf(PutParameterCommand);
    expect(out.externalId).toBe(putCommand?.input.Value);
  });

  it("should keep the good rows when one row is already registered", async () => {
    const { shared, ddbSend, ssmSend } = buildShared();
    withExistingExternalId(ssmSend);
    ddbSend.mockResolvedValueOnce({}).mockRejectedValueOnce(conflict()).mockResolvedValueOnce({});

    const out = await bulkCreateCompetitorAccounts(shared, CTX, {
      defaults: { competitorRoleName: "TenkaCloud-acme-deploy-Role" },
      accounts: [
        { awsAccountId: "222222222222" },
        { awsAccountId: "333333333333" },
        { awsAccountId: "444444444444" },
      ],
    });

    expect(out.created).toBe(2);
    expect(out.duplicate).toBe(1);
    expect(out.results.map((r) => [r.awsAccountId, r.outcome])).toEqual([
      ["222222222222", "created"],
      ["333333333333", "duplicate"],
      ["444444444444", "created"],
    ]);
  });

  it("should keep going after a row whose write throws, reporting it as failed", async () => {
    // A throttled or otherwise failing write is a per-row fact. Abandoning the
    // remaining rows would leave the operator reconciling by hand.
    const { shared, ddbSend, ssmSend } = buildShared();
    withExistingExternalId(ssmSend);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    ddbSend
      .mockRejectedValueOnce(
        Object.assign(new Error("throughput exceeded"), {
          name: "ProvisionedThroughputExceededException",
        }),
      )
      .mockResolvedValueOnce({});

    const out = await bulkCreateCompetitorAccounts(shared, CTX, {
      defaults: { competitorRoleName: "TenkaCloud-acme-deploy-Role" },
      accounts: [{ awsAccountId: "222222222222" }, { awsAccountId: "333333333333" }],
    });

    expect(out.failed).toBe(1);
    expect(out.created).toBe(1);
    expect(out.results[0]?.message).toContain("ProvisionedThroughputExceededException");
    consoleError.mockRestore();
  });

  it("should reject a row with no role name anywhere rather than inventing one", async () => {
    // The single-create schema deliberately carries no zod default for
    // competitorRoleName: a caller that drops tenantId would otherwise collide
    // on a shared name. Bulk keeps that invariant per row.
    const { shared, ddbSend, ssmSend } = buildShared();
    withExistingExternalId(ssmSend);
    ddbSend.mockResolvedValue({});

    const out = await bulkCreateCompetitorAccounts(shared, CTX, {
      accounts: [
        { awsAccountId: "222222222222", competitorRoleName: "TenkaCloud-acme-deploy-Role" },
        { awsAccountId: "333333333333" },
      ],
    });

    expect(out.created).toBe(1);
    expect(out.invalid).toBe(1);
    expect(out.results[1]).toMatchObject({
      awsAccountId: "333333333333",
      outcome: "invalid",
    });
    expect(out.results[1]?.message).toContain("competitorRoleName");
    expect(ddbSend.mock.calls.length).toBe(1);
  });

  it("should name a repeated row in the same request as such, not as already registered", async () => {
    // "your JSON lists this twice" and "this was registered last week" need
    // different fixes from the operator.
    const { shared, ddbSend, ssmSend } = buildShared();
    withExistingExternalId(ssmSend);
    ddbSend.mockResolvedValue({});

    const out = await bulkCreateCompetitorAccounts(shared, CTX, {
      defaults: { competitorRoleName: "TenkaCloud-acme-deploy-Role" },
      accounts: [{ awsAccountId: "222222222222" }, { awsAccountId: "222222222222" }],
    });

    expect(out.created).toBe(1);
    expect(out.invalid).toBe(1);
    expect(out.results[1]?.message).toContain("within this request");
    // The repeat never reaches the repository.
    expect(ddbSend.mock.calls.length).toBe(1);
  });

  it("should apply per-entry region and role name over the request defaults", async () => {
    const { shared, ddbSend, ssmSend } = buildShared();
    withExistingExternalId(ssmSend);
    ddbSend.mockResolvedValue({});

    await bulkCreateCompetitorAccounts(shared, CTX, {
      defaults: { region: "ap-northeast-1", competitorRoleName: "TenkaCloud-acme-deploy-Role" },
      accounts: [
        { awsAccountId: "222222222222" },
        {
          awsAccountId: "333333333333",
          region: "us-east-1",
          competitorRoleName: "Other-Role",
          alias: "Team B",
        },
      ],
    });

    const items = ddbSend.mock.calls.map(
      ([cmd]) => (cmd as { input: { Item: unknown } }).input.Item,
    );
    expect(items[0]).toMatchObject({
      awsAccountId: "222222222222",
      region: "ap-northeast-1",
      competitorRoleName: "TenkaCloud-acme-deploy-Role",
      verified: false,
    });
    expect(items[1]).toMatchObject({
      awsAccountId: "333333333333",
      region: "us-east-1",
      competitorRoleName: "Other-Role",
      alias: "Team B",
    });
  });

  it("should fall back to ap-northeast-1 when neither the entry nor the defaults set a region", async () => {
    const { shared, ddbSend, ssmSend } = buildShared();
    withExistingExternalId(ssmSend);
    ddbSend.mockResolvedValue({});

    await bulkCreateCompetitorAccounts(shared, CTX, {
      accounts: [
        { awsAccountId: "222222222222", competitorRoleName: "TenkaCloud-acme-deploy-Role" },
      ],
    });

    const put = ddbSend.mock.calls[0]?.[0] as { input: { Item: { region: string } } } | undefined;
    expect(put?.input.Item.region).toBe("ap-northeast-1");
  });

  it("should withhold the ExternalId when nothing was created", async () => {
    // The ExternalId is a tenant secret. A request that created no row has no
    // new bootstrap to hand out, so there is nothing to reveal it for.
    const { shared, ddbSend, ssmSend } = buildShared();
    withExistingExternalId(ssmSend);
    ddbSend.mockRejectedValue(conflict());

    const out = await bulkCreateCompetitorAccounts(shared, CTX, {
      defaults: { competitorRoleName: "TenkaCloud-acme-deploy-Role" },
      accounts: [{ awsAccountId: "222222222222" }],
    });

    expect(out.created).toBe(0);
    expect(out.duplicate).toBe(1);
    expect(out.externalId).toBeUndefined();
    expect(out.tenkaCloudAccountId).toBe("111111111111");
  });

  it("should report each created and rejected row to the caller's audit hooks", async () => {
    const { shared, ddbSend, ssmSend } = buildShared();
    withExistingExternalId(ssmSend);
    ddbSend.mockResolvedValueOnce({}).mockRejectedValueOnce(conflict());
    const onCreated = vi.fn();
    const onRejected = vi.fn();

    await bulkCreateCompetitorAccounts(
      shared,
      CTX,
      {
        // No request-level defaults, so the third row has no role name to fall
        // back to and the store rejects it without reaching the repository.
        accounts: [
          { awsAccountId: "222222222222", competitorRoleName: "TenkaCloud-acme-deploy-Role" },
          { awsAccountId: "333333333333", competitorRoleName: "TenkaCloud-acme-deploy-Role" },
          { awsAccountId: "444444444444" },
        ],
      },
      onCreated,
      onRejected,
    );

    expect(onCreated.mock.calls).toEqual([["222222222222"]]);
    expect(onRejected.mock.calls).toEqual([
      ["333333333333", "duplicate"],
      ["444444444444", "invalid"],
    ]);
  });
});

describe("BulkCreateCompetitorAccountsRequestSchema", () => {
  it("should reject an empty account list", () => {
    expect(BulkCreateCompetitorAccountsRequestSchema.safeParse({ accounts: [] }).success).toBe(
      false,
    );
  });

  it("should reject more entries than one request may carry", () => {
    // Bounded so a single request cannot outrun the Lambda; splitting is the
    // operator's job and is readable, a half-written request is not.
    const accounts = Array.from({ length: BULK_COMPETITOR_ACCOUNTS_MAX_ENTRIES + 1 }, (_, i) => ({
      awsAccountId: String(100000000000 + i),
    }));
    expect(BulkCreateCompetitorAccountsRequestSchema.safeParse({ accounts }).success).toBe(false);
  });

  it("should accept exactly the maximum number of entries", () => {
    const accounts = Array.from({ length: BULK_COMPETITOR_ACCOUNTS_MAX_ENTRIES }, (_, i) => ({
      awsAccountId: String(100000000000 + i),
    }));
    expect(BulkCreateCompetitorAccountsRequestSchema.safeParse({ accounts }).success).toBe(true);
  });

  it("should reject an unknown key rather than silently dropping it", () => {
    const parsed = BulkCreateCompetitorAccountsRequestSchema.safeParse({
      accounts: [{ awsAccountId: "222222222222", roleName: "typo-for-competitorRoleName" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("should reject a malformed account id, region, and role name", () => {
    for (const entry of [
      { awsAccountId: "12345" },
      { awsAccountId: "222222222222", region: "not-a-region" },
      { awsAccountId: "222222222222", competitorRoleName: "bad role name!" },
    ]) {
      expect(
        BulkCreateCompetitorAccountsRequestSchema.safeParse({ accounts: [entry] }).success,
      ).toBe(false);
    }
  });
});
