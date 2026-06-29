/**
 * [Composite Runtime / Issue #2073] Composite target status in the deployment
 * detail API.
 *
 * Covers the additive `composite` block on the deployment-detail response:
 *   - ordered AWS/GCP/Azure/Sakura target summaries for a composite parent,
 *   - legacy single-provider detail keeps no `composite` field (byte compat),
 *   - no provider credential / role metadata leaks into a target summary,
 *   - cross-tenant composite request is indistinguishable from not-found,
 *   - malformed target output → a controlled error (caller maps to HTTP 500),
 *   - the OpenAPI-equivalent contract (Zod schema) gains only the optional field.
 */

import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCompositeDetail,
  CompositeDetailSchema,
} from "../../lib/problem-deploy/handlers/deploy-handler/composite-detail";
import { CompositeOutputsError } from "../../lib/problem-deploy/handlers/deploy-handler/composite-outputs";
import type { DeploySharedResources } from "../../lib/problem-deploy/handlers/deploy-handler/deploy";
import { getDeployment } from "../../lib/problem-deploy/handlers/deploy-handler/list";

const PARENT_ID = "01HPARENTAAAAAAAAAAAAAAAAA";
const TENANT = "tenant-acme";

function buildShared(): {
  shared: DeploySharedResources;
  ddbSend: ReturnType<typeof vi.fn>;
} {
  const ddbSend = vi.fn();
  const shared: DeploySharedResources = {
    tableName: "TestDeployments",
    competitorAccountsTableName: "TestCompetitorAccounts",
    env: "development",
    eventBusName: "test-bus",
    ddb: { send: ddbSend } as unknown as DeploySharedResources["ddb"],
    events: {} as unknown as DeploySharedResources["events"],
    problemsCatalog: {},
  };
  return { shared, ddbSend };
}

/** A composite parent META row, byte-shaped like the repository persists it. */
const parentRow = (over: Record<string, unknown> = {}) => ({
  PK: `DEPLOYMENT#${PARENT_ID}`,
  SK: "META",
  jobId: PARENT_ID,
  tenantId: TENANT,
  problemId: "multicloud-relay",
  runtimeKind: "composite",
  compositeVersion: 1,
  targetCount: 4,
  status: "IN_PROGRESS",
  createdAt: "2026-06-29T00:00:00.000Z",
  updatedAt: "2026-06-29T00:00:05.000Z",
  expiresAt: 1_800_000_000,
  ...over,
});

/**
 * A composite target row. Carries the full secret/identity surface a real row
 * has so the leak guard can assert none of it escapes into the summary.
 */
const targetRow = (over: Record<string, unknown> = {}) => ({
  PK: "DEPLOYMENT#01HTARGETxxxxxxxxxxxxxxxx",
  SK: "META",
  jobId: "01HTARGETxxxxxxxxxxxxxxxx",
  parentDeploymentId: PARENT_ID,
  targetId: "edge",
  targetOrdinal: 0,
  tenantId: TENANT,
  problemId: "multicloud-relay",
  runtimeProvider: "aws",
  runtimeEngine: "cloudformation",
  runtimeEntry: "template.yaml",
  awsAccountId: "999999999999",
  region: "ap-northeast-1",
  teamName: "Alpha",
  namePrefix: "tc-multicloud-relay-alpha",
  teamLoginKey: "SECRET_LOGIN_KEY_DO_NOT_LEAK",
  competitorRoleArn: "arn:aws:iam::999999999999:role/TenkaCloud-CompetitorDeploy-Role",
  externalIdParameterName: "/tenkacloud/tenant-acme/external-id",
  status: "COMPLETE",
  createdAt: "2026-06-29T00:00:00.000Z",
  updatedAt: "2026-06-29T00:00:03.000Z",
  expiresAt: 1_800_000_000,
  GSI3PK: `PARENT_DEPLOYMENT#${PARENT_ID}`,
  GSI3SK: "ORDINAL#00#TARGET#edge",
  ...over,
});

describe("buildCompositeDetail", () => {
  let ddbSend: ReturnType<typeof vi.fn>;
  let shared: DeploySharedResources;

  beforeEach(() => {
    ({ shared, ddbSend } = buildShared());
  });

  it("should return ordered AWS/GCP/Azure/Sakura target summaries for a composite parent", async () => {
    // GSI3 query returns targets already in ordinal order (ScanIndexForward).
    ddbSend.mockResolvedValueOnce({
      Items: [
        targetRow({
          jobId: "01HTARGETaws",
          targetId: "edge",
          targetOrdinal: 0,
          runtimeProvider: "aws",
          runtimeEngine: "cloudformation",
          stackOutputs: JSON.stringify({ Endpoint: "https://edge.example" }),
        }),
        targetRow({
          jobId: "01HTARGETgcp",
          targetId: "compute",
          targetOrdinal: 1,
          runtimeProvider: "gcp",
          runtimeEngine: "infra-manager",
          status: "IN_PROGRESS",
        }),
        targetRow({
          jobId: "01HTARGETazure",
          targetId: "store",
          targetOrdinal: 2,
          runtimeProvider: "azure",
          runtimeEngine: "bicep",
          status: "FAILED",
          failureReason: "quota exceeded",
        }),
        targetRow({
          jobId: "01HTARGETsakura",
          targetId: "relay",
          targetOrdinal: 3,
          runtimeProvider: "sakura",
          runtimeEngine: "apprun",
          status: "PENDING",
        }),
      ],
    });

    const detail = await buildCompositeDetail(shared, PARENT_ID);

    expect(detail.version).toBe(1);
    expect(detail.targets.map((t) => t.provider)).toEqual(["aws", "gcp", "azure", "sakura"]);
    expect(detail.targets.map((t) => t.ordinal)).toEqual([0, 1, 2, 3]);
    expect(detail.targets[0]).toEqual({
      targetId: "edge",
      targetDeploymentId: "01HTARGETaws",
      ordinal: 0,
      provider: "aws",
      engine: "cloudformation",
      status: "COMPLETE",
      updatedAt: "2026-06-29T00:00:03.000Z",
      outputs: { Endpoint: "https://edge.example" },
    });
    expect(detail.targets[2]).toMatchObject({
      provider: "azure",
      status: "FAILED",
      failureReason: "quota exceeded",
    });

    // The GSI3 parent->target query is what drives the order.
    const queryCmd = ddbSend.mock.calls
      .map((c) => c[0])
      .find((c): c is QueryCommand => c instanceof QueryCommand);
    expect(queryCmd?.input.IndexName).toBe("GSI3");
    expect(queryCmd?.input.ExpressionAttributeValues?.[":pk"]).toBe(
      `PARENT_DEPLOYMENT#${PARENT_ID}`,
    );
  });

  it("should not expose provider credentials or role metadata in a target summary", async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [
        targetRow({
          competitorRoleArn: "arn:aws:iam::999999999999:role/PLANTED-SECRET-ROLE",
          externalIdParameterName: "/planted/external-id",
          teamLoginKey: "PLANTED_LOGIN_KEY",
        }),
      ],
    });

    const detail = await buildCompositeDetail(shared, PARENT_ID);
    const serialized = JSON.stringify(detail);

    expect(serialized).not.toContain("PLANTED-SECRET-ROLE");
    expect(serialized).not.toContain("/planted/external-id");
    expect(serialized).not.toContain("PLANTED_LOGIN_KEY");
    expect(serialized).not.toContain("competitorRoleArn");
    expect(serialized).not.toContain("externalIdParameterName");
    expect(serialized).not.toContain("teamLoginKey");
    expect(serialized).not.toContain("awsAccountId");
    expect(serialized).not.toContain("namePrefix");
    // Only the whitelisted keys are present.
    expect(Object.keys(detail.targets[0]).sort()).toEqual(
      [
        "engine",
        "ordinal",
        "provider",
        "status",
        "targetDeploymentId",
        "targetId",
        "updatedAt",
      ].sort(),
    );
  });

  it("should return a controlled error for malformed target outputs", async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [targetRow({ status: "COMPLETE", stackOutputs: "{not-valid-json" })],
    });

    // No partial data — it throws the typed error the route maps to HTTP 500.
    await expect(buildCompositeDetail(shared, PARENT_ID)).rejects.toBeInstanceOf(
      CompositeOutputsError,
    );
  });
});

describe("getDeployment composite detail", () => {
  let ddbSend: ReturnType<typeof vi.fn>;
  let shared: DeploySharedResources;

  beforeEach(() => {
    ({ shared, ddbSend } = buildShared());
  });

  it("should expose the composite field only for a composite parent deployment", async () => {
    ddbSend
      .mockResolvedValueOnce({ Item: parentRow() }) // GetCommand → parent META
      .mockResolvedValueOnce({ Items: [targetRow()] }); // QueryCommand → targets

    const out = await getDeployment(shared, TENANT, PARENT_ID);
    expect(out?.composite?.version).toBe(1);
    expect(out?.composite?.targets).toHaveLength(1);
    // The first DDB read is the base-table Get of the parent META row.
    const getCmd = ddbSend.mock.calls
      .map((c) => c[0])
      .find((c): c is GetCommand => c instanceof GetCommand);
    expect(getCmd?.input.Key).toEqual({ PK: `DEPLOYMENT#${PARENT_ID}`, SK: "META" });
  });

  it("should not expose the composite field for a legacy single-provider deployment", async () => {
    const legacyRow = {
      PK: "DEPLOYMENT#01HLEGACY",
      SK: "META",
      jobId: "01HLEGACY",
      tenantId: TENANT,
      problemId: "hello-world",
      awsAccountId: "123456789012",
      region: "ap-northeast-1",
      teamName: "Alpha",
      namePrefix: "tc-hello-world-alpha",
      teamLoginKey: "LK",
      status: "COMPLETE",
      createdAt: "2026-06-29T00:00:00.000Z",
      updatedAt: "2026-06-29T00:00:01.000Z",
      expiresAt: 1_800_000_000,
    };
    ddbSend.mockResolvedValueOnce({ Item: legacyRow });

    const out = await getDeployment(shared, TENANT, "01HLEGACY");
    expect(out).toBeDefined();
    // Byte compatibility: a legacy row gains NO composite key at all (not null,
    // not an empty block). And no second (GSI3) query is ever issued.
    expect(out).not.toHaveProperty("composite");
    expect(ddbSend).toHaveBeenCalledOnce();
  });

  it("should return not-found for a cross-tenant composite request", async () => {
    ddbSend.mockResolvedValueOnce({ Item: parentRow({ tenantId: "tenant-other" }) });

    const out = await getDeployment(shared, TENANT, PARENT_ID);
    // Cross-tenant is indistinguishable from not-found and never fans out to GSI3.
    expect(out).toBeUndefined();
    expect(ddbSend).toHaveBeenCalledOnce();
  });
});

describe("composite detail OpenAPI-equivalent contract", () => {
  it("should accept a composite block as the only new optional field on the contract", () => {
    // The composite block validates against the schema (the OpenAPI-equivalent
    // contract for this repo). A response with no composite block (legacy detail)
    // is unaffected because the field is optional on DeploymentSummary.
    const parsed = CompositeDetailSchema.safeParse({
      version: 1,
      targets: [
        {
          targetId: "edge",
          targetDeploymentId: "01HTARGETaws",
          ordinal: 0,
          provider: "aws",
          engine: "cloudformation",
          status: "COMPLETE",
          updatedAt: "2026-06-29T00:00:03.000Z",
        },
      ],
    });
    expect(parsed.success).toBe(true);

    // The contract rejects any non-whitelisted provider or extra secret field —
    // it cannot silently widen to credentials.
    const wrongProvider = CompositeDetailSchema.safeParse({
      version: 1,
      targets: [
        {
          targetId: "edge",
          targetDeploymentId: "01HTARGETaws",
          ordinal: 0,
          provider: "oracle",
          engine: "x",
          status: "COMPLETE",
          updatedAt: "2026-06-29T00:00:03.000Z",
        },
      ],
    });
    expect(wrongProvider.success).toBe(false);
  });
});
