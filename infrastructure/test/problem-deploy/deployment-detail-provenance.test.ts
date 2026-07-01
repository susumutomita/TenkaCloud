/**
 * [Problem Packs / Issue #2096] Pack provenance on the deployment-detail API.
 *
 * Covers the additive `provenance` object on the deployment-detail response:
 *   - a core (non-pack) deployment row and detail response are UNCHANGED,
 *   - a pack deployment surfaces immutable provenance (id / version / digest /
 *     catalogSnapshotId) in the detail response,
 *   - the list summary never exposes provenance (single-row scope only),
 *   - a cross-tenant caller cannot infer pack activation (indistinguishable
 *     from not-found).
 */

import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeploySharedResources } from "../../lib/problem-deploy/handlers/deploy-handler/deploy";
import { getDeployment, toSummary } from "../../lib/problem-deploy/handlers/deploy-handler/list";
import type {
  DeploymentItem,
  DeploymentProvenance,
} from "../../lib/problem-deploy/handlers/deploy-handler/types";

const JOB_ID = "01HJOBxxxxxxxxxxxxxxxxxxxx";
const TENANT = "tenant-acme";

const PACK_PROVENANCE: DeploymentProvenance = {
  packId: "com.example.cloud-pack",
  packVersion: "1.2.0",
  contentDigest: "sha256-abc",
  catalogSnapshotId: "snap-123",
};

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

const baseRow = (over: Partial<DeploymentItem> = {}): Partial<DeploymentItem> => ({
  PK: `DEPLOYMENT#${JOB_ID}`,
  SK: "META",
  jobId: JOB_ID,
  tenantId: TENANT,
  problemId: "hello-world",
  awsAccountId: "999999999999",
  region: "ap-northeast-1",
  teamName: "Alpha",
  namePrefix: "tc-hello-world-alpha",
  teamLoginKey: "SECRET_LOGIN_KEY",
  status: "COMPLETE",
  createdAt: "2026-06-29T00:00:00.000Z",
  updatedAt: "2026-06-29T00:00:03.000Z",
  expiresAt: 1_800_000_000,
  ...over,
});

describe("getDeployment provenance", () => {
  let ddbSend: ReturnType<typeof vi.fn>;
  let shared: DeploySharedResources;

  beforeEach(() => {
    ({ shared, ddbSend } = buildShared());
  });

  it("should leave a core deployment detail response unchanged with no provenance field", async () => {
    ddbSend.mockResolvedValueOnce({ Item: baseRow() });

    const detail = await getDeployment(shared, TENANT, JOB_ID);

    expect(detail).toBeDefined();
    expect(detail).not.toHaveProperty("provenance");
    expect(ddbSend.mock.calls[0][0]).toBeInstanceOf(GetCommand);
  });

  it("should surface immutable provenance for a pack-sourced deployment", async () => {
    ddbSend.mockResolvedValueOnce({ Item: baseRow({ provenance: PACK_PROVENANCE }) });

    const detail = await getDeployment(shared, TENANT, JOB_ID);

    expect(detail?.provenance).toEqual(PACK_PROVENANCE);
  });

  it("should not expose provenance in the list summary even for a pack deployment", () => {
    const summary = toSummary(baseRow({ provenance: PACK_PROVENANCE }));

    expect(summary).not.toHaveProperty("provenance");
  });

  it("should hide pack activation from a cross-tenant caller (indistinguishable from not-found)", async () => {
    ddbSend.mockResolvedValueOnce({
      Item: baseRow({ tenantId: "tenant-other", provenance: PACK_PROVENANCE }),
    });

    const detail = await getDeployment(shared, TENANT, JOB_ID);

    expect(detail).toBeUndefined();
  });
});
