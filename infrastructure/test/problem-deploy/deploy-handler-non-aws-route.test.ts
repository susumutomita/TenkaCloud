import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * [Issue #2561] Route-level regression: `POST /problems/:problemId/deploy` for
 * a non-AWS single-provider problem (gcp/azure/sakura) must accept a body
 * without `awsAccountId`/`region` instead of 400-ing at schema parse — and the
 * two new gate errors (`AwsAccountRequiredError` /
 * `NonAwsCredentialUnregisteredError`) must map to the documented status
 * codes. `startDeployment` itself is mocked; the gate LOGIC is covered by
 * `deploy-handler-non-aws-gate.test.ts`, this file is scoped to routing +
 * schema selection + error-to-HTTP mapping.
 */
beforeAll(() => {
  process.env.DEFAULT_TENANT_ID = "tenant-test";
  process.env.DEFAULT_USER_ROLE = "TenantAdmin";
});

const mocks = vi.hoisted(() => ({
  startDeployment: vi.fn(),
  listDeployments: vi.fn(),
  getDeployment: vi.fn(),
  requestTeardown: vi.fn(),
  getStackProgress: vi.fn(),
  resolveProblemRuntime: vi.fn(),
}));

vi.mock("../../lib/problem-deploy/handlers/deploy-handler/deploy", async () => {
  const actual = await vi.importActual<
    typeof import("../../lib/problem-deploy/handlers/deploy-handler/deploy")
  >("../../lib/problem-deploy/handlers/deploy-handler/deploy");
  return {
    buildSharedResources: () => ({
      tableName: "TestDeployments",
      competitorAccountsTableName: "TestCompetitorAccounts",
      env: "development",
      eventBusName: "test-bus",
      ddb: { send: vi.fn() },
      events: { send: vi.fn() },
    }),
    buildContext: (shared: unknown, tenantId: string) => ({
      ...(shared as object),
      tenantId,
      resolveProblemRuntime: mocks.resolveProblemRuntime,
    }),
    startDeployment: mocks.startDeployment,
    UnknownProblemError: actual.UnknownProblemError,
    UnverifiedCompetitorAccountError: actual.UnverifiedCompetitorAccountError,
    AwsAccountRequiredError: actual.AwsAccountRequiredError,
    NonAwsCredentialUnregisteredError: actual.NonAwsCredentialUnregisteredError,
  };
});

vi.mock("../../lib/problem-deploy/handlers/deploy-handler/list", () => ({
  listDeployments: mocks.listDeployments,
  getDeployment: mocks.getDeployment,
}));

vi.mock("../../lib/problem-deploy/handlers/deploy-handler/delete", () => ({
  requestTeardown: mocks.requestTeardown,
}));

vi.mock("../../lib/problem-deploy/handlers/deploy-handler/stack-progress", () => ({
  getStackProgress: mocks.getStackProgress,
  defaultCfnClient: vi.fn(),
  defaultCfnClientForCompetitor: vi.fn(),
}));

const { app } = await import("../../lib/problem-deploy/handlers/deploy-handler/index");
const { AwsAccountRequiredError, NonAwsCredentialUnregisteredError } = await import(
  "../../lib/problem-deploy/handlers/deploy-handler/deploy"
);

describe("POST /problems/:problemId/deploy for a non-AWS single-provider problem", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveProblemRuntime.mockReturnValue({
      provider: "gcp",
      engine: "infra-manager",
      entry: "gcp/x",
    });
    mocks.startDeployment.mockResolvedValue({
      jobId: "01H8XGJWBWBAQ4N6RZHM4S2KMV",
      status: "PENDING",
      namePrefix: "tc-alpha-gcp-only",
      teamLoginKey: "KEY-A",
      expiresAt: 4_102_444_800,
    });
  });

  it("should accept a body without awsAccountId/region (no 400 at schema parse)", async () => {
    const res = await app.request("/problems/gcp-only-problem/deploy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamName: "Alpha Team" }),
    });
    expect(res.status).toBe(202);
    expect(mocks.startDeployment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ teamName: "Alpha Team", problemId: "gcp-only-problem" }),
    );
  });

  it("should map NonAwsCredentialUnregisteredError to 422", async () => {
    mocks.startDeployment.mockRejectedValueOnce(
      new NonAwsCredentialUnregisteredError("gcp", "alpha-team"),
    );
    const res = await app.request("/problems/gcp-only-problem/deploy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamName: "Alpha Team" }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("non_aws_credential_unregistered");
    expect(body.provider).toBe("gcp");
    expect(body.teamSlug).toBe("alpha-team");
  });

  it("should map AwsAccountRequiredError to 400", async () => {
    mocks.resolveProblemRuntime.mockReturnValue({
      provider: "aws",
      engine: "cloudformation",
      entry: "template.yaml",
    });
    mocks.startDeployment.mockRejectedValueOnce(new AwsAccountRequiredError());
    const res = await app.request("/problems/security-battle-royale/deploy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        region: "ap-northeast-1",
        awsAccountId: "123456789012",
        teamName: "Alpha Team",
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("aws_input_required");
  });
});
