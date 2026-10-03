import { describe, expect, it, vi } from "vitest";
import { buildCompositeDeployDeps } from "../../lib/problem-deploy/handlers/deploy-handler/composite-deploy-wiring";
import type { DeployContext } from "../../lib/problem-deploy/handlers/deploy-handler/deploy";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

/**
 * [#2527 Slice 4] `buildCompositeDeployDeps` は DeployContext (entrypoint 注入の
 * control-data runtime を含む) から composite deploy の依存束を閉包で組む。
 * ここでは注入 runtime が repo / quota deps に配線されること (= module-global
 * singleton に依存しないこと) を composition の単位で pin する。
 */
describe("buildCompositeDeployDeps", () => {
  function makeCtx(): DeployContext {
    return {
      runtime: makeTestControlDataRuntime(),
      tableName: "TestDeployments",
      competitorAccountsTableName: "TestCompetitorAccounts",
      ddb: { send: vi.fn() },
      tenantId: "tenant-1",
      env: "development",
      problemsCatalog: {},
      deployQuota: undefined,
      now: () => 1_700_000_000_000,
    } as unknown as DeployContext;
  }

  it("should expose the plan builder and tenantId from the context", () => {
    const deps = buildCompositeDeployDeps(makeCtx(), "Alpha Team");
    expect(typeof deps.buildPlan).toBe("function");
    expect(deps.tenantId).toBe("tenant-1");
    expect(typeof deps.materialize).toBe("function");
    expect(typeof deps.dispatch).toBe("function");
  });

  it("should build quota deps around the injected runtime (no-op when quota is unset)", async () => {
    const ctx = makeCtx();
    const deps = buildCompositeDeployDeps(ctx, "Alpha Team");
    // deployQuota undefined → enforceDeployQuota は即 return (= DDB を触らない)。
    await expect(deps.enforceQuota("tenant-1", "basic")).resolves.toBeUndefined();
    expect((ctx.ddb as unknown as { send: ReturnType<typeof vi.fn> }).send).not.toHaveBeenCalled();
  });
});
