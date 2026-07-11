import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers.js";

/**
 * [Issue #2561] Regression tests: a single-provider non-AWS problem
 * (gcp/azure/sakura) must not require a verified AWS competitor account to
 * deploy — the AWS-account gate is orthogonal to a provider whose credential
 * lives in its own per-team SSM store. Before this fix, `startDeployment`
 * unconditionally called `resolveVerifiedCompetitorAccount`, so every
 * non-AWS single-provider deploy threw `UnverifiedCompetitorAccountError`
 * even when the team's gcp/azure/sakura credential was correctly registered.
 *
 * `dispatchPreparedDeployment` is mocked because exercising the real
 * sakura/gcp REST client wiring is a different concern (covered by the
 * adapter's own unit tests) — this suite is scoped to the pre-mutation gate
 * itself: does `startDeployment` reach a successful DDB/SQL write and
 * dispatch call, or does it reject before ever getting there.
 */
vi.mock("../../lib/problem-deploy/handlers/deploy-handler/prepared-dispatch.js", () => ({
  dispatchPreparedDeployment: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../lib/problem-deploy/handlers/shared/sakura-credential-store.js", () => ({
  getSakuraCredential: vi.fn(),
}));
vi.mock("../../lib/problem-deploy/handlers/shared/gcp-credential-store.js", () => ({
  getGcpCredential: vi.fn(),
}));
vi.mock("../../lib/problem-deploy/handlers/shared/azure-credential-store.js", () => ({
  getAzureCredential: vi.fn(),
}));

const { dispatchPreparedDeployment } = await import(
  "../../lib/problem-deploy/handlers/deploy-handler/prepared-dispatch.js"
);
const { getSakuraCredential } = await import(
  "../../lib/problem-deploy/handlers/shared/sakura-credential-store.js"
);
const { getGcpCredential } = await import(
  "../../lib/problem-deploy/handlers/shared/gcp-credential-store.js"
);
const { startDeployment, UnverifiedCompetitorAccountError, NonAwsCredentialUnregisteredError } =
  await import("../../lib/problem-deploy/handlers/deploy-handler/deploy.js");

type DeployContext = Parameters<typeof startDeployment>[0];
type DeployInvocation = Parameters<typeof startDeployment>[1];

function buildContext(overrides: Partial<DeployContext> = {}): {
  ctx: DeployContext;
  putSend: ReturnType<typeof vi.fn>;
  eventsSend: ReturnType<typeof vi.fn>;
} {
  const putSend = vi.fn().mockResolvedValue({});
  const eventsSend = vi.fn().mockResolvedValue({});
  const ddbSend = vi.fn(async (cmd: unknown) => putSend(cmd));
  const ctx: DeployContext = {
    runtime: makeTestControlDataRuntime(),
    tableName: "TestDeployments",
    competitorAccountsTableName: "TestCompetitorAccounts",
    env: "development",
    eventBusName: "test-bus",
    ddb: { send: ddbSend } as unknown as DeployContext["ddb"],
    events: { send: eventsSend } as unknown as DeployContext["events"],
    ssm: { send: vi.fn() } as unknown as DeployContext["ssm"],
    now: () => 1_700_000_000_000,
    ttlMs: 60_000,
    tenantId: "tenant-acme",
    problemsCatalog: { "gcp-only-problem": "problems/challenges/gcp-only-problem" },
    ...overrides,
  };
  return { ctx, putSend, eventsSend };
}

const sampleRequest = (overrides: Partial<DeployInvocation> = {}): DeployInvocation => ({
  problemId: "gcp-only-problem",
  teamName: "Alpha Team",
  ...overrides,
});

describe("startDeployment for a non-AWS single-provider problem (Issue #2561)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should deploy without an AWS account when the team's provider credential is registered", async () => {
    vi.mocked(getGcpCredential).mockResolvedValue({
      wifAudience: "aud",
      serviceAccountEmail: "sa@example.iam.gserviceaccount.com",
      projectId: "proj",
      location: "us-central1",
    } as never);
    const { ctx, putSend } = buildContext({
      resolveProblemRuntime: () => ({ provider: "gcp", engine: "infra-manager", entry: "gcp/x" }),
    });

    const response = await startDeployment(ctx, sampleRequest());

    expect(response.status).toBe("PENDING");
    expect(putSend).toHaveBeenCalledOnce();
    const item = (putSend.mock.calls[0]?.[0] as { input: { Item: Record<string, unknown> } }).input
      .Item;
    expect(item.awsAccountId).toBe("");
    expect(item.competitorRoleArn).toBeUndefined();
    expect(dispatchPreparedDeployment).toHaveBeenCalledOnce();
    expect(getGcpCredential).toHaveBeenCalledWith(
      expect.anything(),
      "tenant-acme",
      expect.any(String),
    );
  });

  it("should reject with NonAwsCredentialUnregisteredError before any write when the team has no credential", async () => {
    vi.mocked(getSakuraCredential).mockResolvedValue(undefined);
    const { ctx, putSend } = buildContext({
      resolveProblemRuntime: () => ({ provider: "sakura", engine: "apprun", entry: "sakura/x" }),
    });

    await expect(startDeployment(ctx, sampleRequest())).rejects.toBeInstanceOf(
      NonAwsCredentialUnregisteredError,
    );
    expect(putSend).not.toHaveBeenCalled();
    expect(dispatchPreparedDeployment).not.toHaveBeenCalled();
  });

  it("should still require a verified AWS competitor account for the default aws/cloudformation runtime", async () => {
    const { ctx } = buildContext();

    await expect(
      startDeployment(
        ctx,
        sampleRequest({ awsAccountId: "123456789012", region: "ap-northeast-1" }),
      ),
    ).rejects.toBeInstanceOf(UnverifiedCompetitorAccountError);
    // No deployment row is ever written (or dispatched) once the verified=true gate rejects.
    expect(dispatchPreparedDeployment).not.toHaveBeenCalled();
    expect(getSakuraCredential).not.toHaveBeenCalled();
    expect(getGcpCredential).not.toHaveBeenCalled();
  });
});
