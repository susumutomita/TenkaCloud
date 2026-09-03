import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * scheduled auto-deploy の fire 経路 (= reconciler が deployAt 経過の DRAFT event を
 * 検知して `bulkDeployEvent` を呼び `deployFiredAt` を stamp する) の DDB I/O 越し統合テスト。
 *
 * `bulkDeployEvent` は teams/catalog/CompetitorAccounts の orchestration を内包するため module mock し、
 * reconciler が「いつ呼ぶか / どう deployFiredAt を記録するか」だけを pin する。 fireScheduledTeardown の
 * 鏡像で、 status guard + deployFiredAt の二重発火防止と warn-swallow を検証する。
 */

const deploy = vi.hoisted(() => ({ bulkDeployEvent: vi.fn() }));
vi.mock("../../lib/problem-deploy/handlers/event-handler/bulk-deploy", () => deploy);

import type { EventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared";
import {
  type ReconcileEventStatusesContext,
  reconcileEventStatuses,
} from "../../lib/problem-deploy/handlers/generic-scoring-handler/event-reconciler";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

const NOW_ISO = "2026-05-11T00:00:00.000Z";
const PAST = "2026-05-10T23:00:00.000Z"; // NOW より前 (= deployAt 経過)
const FUTURE = "2026-05-11T01:00:00.000Z"; // NOW より後 (= 未到来)

// deployDeps は bulkDeployEvent が module mock 越しに呼ばれるので中身は参照されない placeholder。
const DEPLOY_DEPS = {} as unknown as EventSharedResources;

function buildCtx(over: Partial<ReconcileEventStatusesContext> = {}): {
  ctx: ReconcileEventStatusesContext;
  ddbSend: ReturnType<typeof vi.fn>;
} {
  const ddbSend = vi.fn();
  const ctx: ReconcileEventStatusesContext = {
    runtime: makeTestControlDataRuntime(),
    ddb: { send: ddbSend } as unknown as ReconcileEventStatusesContext["ddb"],
    eventsTableName: "TestEvents",
    deploymentsTableName: "TestDeployments",
    deployDeps: DEPLOY_DEPS,
    ...over,
  };
  return { ctx, ddbSend };
}

afterEach(() => {
  deploy.bulkDeployEvent.mockReset();
});

describe("reconcileEventStatuses scheduled auto-deploy", () => {
  let ctx: ReconcileEventStatusesContext;
  let ddbSend: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    const built = buildCtx();
    ctx = built.ctx;
    ddbSend = built.ddbSend;
  });

  it("should fire bulkDeployEvent and stamp deployFiredAt when DRAFT + deployAt has passed", async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [
        {
          PK: "EVENT#EVD",
          tenantId: "tenant-acme",
          eventId: "EVD",
          status: "DRAFT",
          deployAt: PAST,
        },
      ],
    });
    deploy.bulkDeployEvent.mockResolvedValue({
      kind: "ok",
      result: { eventId: "EVD", enqueued: 4, skipped: 0 },
    });
    ddbSend.mockResolvedValueOnce({}); // recordDeployFired Update

    await reconcileEventStatuses(ctx, NOW_ISO);

    // bulkDeployEvent は (deps, tenantId, eventId, nowMs) で 1 度だけ呼ばれる。
    expect(deploy.bulkDeployEvent).toHaveBeenCalledTimes(1);
    expect(deploy.bulkDeployEvent).toHaveBeenCalledWith(
      DEPLOY_DEPS,
      "tenant-acme",
      "EVD",
      Date.parse(NOW_ISO),
    );
    // 直後に deployFiredAt を conditional Update (二重発火防止 + 監査)。
    const updateCmd = ddbSend.mock.calls[1]?.[0] as UpdateCommand;
    expect(updateCmd).toBeInstanceOf(UpdateCommand);
    expect(updateCmd.input.UpdateExpression).toBe("SET deployFiredAt = :now");
    expect(updateCmd.input.ConditionExpression).toBe(
      "tenantId = :tenant AND attribute_not_exists(deployFiredAt)",
    );
    expect(updateCmd.input.ExpressionAttributeValues?.[":now"]).toBe(NOW_ISO);
  });

  it("should NOT fire when deployAt is still in the future", async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [
        {
          PK: "EVENT#EVD",
          tenantId: "tenant-acme",
          eventId: "EVD",
          status: "DRAFT",
          deployAt: FUTURE,
        },
      ],
    });
    await reconcileEventStatuses(ctx, NOW_ISO);
    expect(deploy.bulkDeployEvent).not.toHaveBeenCalled();
    expect(ddbSend).toHaveBeenCalledTimes(1); // Scan only
  });

  it("should NOT re-fire once deployFiredAt is recorded", async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [
        {
          PK: "EVENT#EVD",
          tenantId: "tenant-acme",
          eventId: "EVD",
          status: "DRAFT",
          deployAt: PAST,
          deployFiredAt: PAST,
        },
      ],
    });
    await reconcileEventStatuses(ctx, NOW_ISO);
    expect(deploy.bulkDeployEvent).not.toHaveBeenCalled();
    expect(ddbSend).toHaveBeenCalledTimes(1);
  });

  it("should stay dormant (no fire) when deployDeps is unwired", async () => {
    const dormant = buildCtx({ deployDeps: undefined });
    dormant.ddbSend.mockResolvedValueOnce({
      Items: [
        {
          PK: "EVENT#EVD",
          tenantId: "tenant-acme",
          eventId: "EVD",
          status: "DRAFT",
          deployAt: PAST,
        },
      ],
    });
    await reconcileEventStatuses(dormant.ctx, NOW_ISO);
    expect(deploy.bulkDeployEvent).not.toHaveBeenCalled();
    // DRAFT は deploy-due でも dormant なら子 deployment query 無しで早期 return → Scan のみ。
    expect(dormant.ddbSend).toHaveBeenCalledTimes(1);
  });

  it("should swallow a bulkDeployEvent failure (warn, no throw) and skip the deployFiredAt stamp", async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [
        {
          PK: "EVENT#EVD",
          tenantId: "tenant-acme",
          eventId: "EVD",
          status: "DRAFT",
          deployAt: PAST,
        },
      ],
    });
    deploy.bulkDeployEvent.mockRejectedValue(new Error("deploy boom"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(reconcileEventStatuses(ctx, NOW_ISO)).resolves.toBeUndefined();
    // fire は試みたが、 失敗で deployFiredAt Update は出さない (= Scan のみ)。
    expect(deploy.bulkDeployEvent).toHaveBeenCalledTimes(1);
    expect(ddbSend).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("should NOT stamp deployFiredAt when the deploy was refused for capacity (#3169)", async () => {
    // `capacity_exceeded` means the preflight wrote and published nothing. If
    // this were stamped as fired, `resolveScheduledDeployDue` would reject the
    // row forever and the DRAFT would stay abandoned even after the operator
    // shrinks the roster or moves the event to a backend that fits.
    ddbSend.mockResolvedValueOnce({
      Items: [
        {
          PK: "EVENT#EVD",
          tenantId: "tenant-acme",
          eventId: "EVD",
          status: "DRAFT",
          deployAt: PAST,
        },
      ],
    });
    deploy.bulkDeployEvent.mockResolvedValue({
      kind: "capacity_exceeded",
      refusals: ['problem "ac26-crypto-battle" needs 1700252 bytes'],
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(reconcileEventStatuses(ctx, NOW_ISO)).resolves.toBeUndefined();

    expect(deploy.bulkDeployEvent).toHaveBeenCalledTimes(1);
    // Scan only: no deployFiredAt Update was issued.
    expect(ddbSend).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "[generic-scoring] scheduled auto-deploy refused",
      expect.objectContaining({
        eventId: "EVD",
        outcome: "capacity_exceeded",
        refusals: ['problem "ac26-crypto-battle" needs 1700252 bytes'],
      }),
    );
    warn.mockRestore();
  });

  it("should still stamp deployFiredAt for a non-refusal outcome such as not_found", async () => {
    // Only the refusal kinds are exempt. Anything else keeps the pre-#3169
    // behaviour, because work may already have been enqueued.
    ddbSend.mockResolvedValueOnce({
      Items: [
        {
          PK: "EVENT#EVD",
          tenantId: "tenant-acme",
          eventId: "EVD",
          status: "DRAFT",
          deployAt: PAST,
        },
      ],
    });
    deploy.bulkDeployEvent.mockResolvedValue({ kind: "not_found" });
    ddbSend.mockResolvedValueOnce({});

    await reconcileEventStatuses(ctx, NOW_ISO);

    const updateCmd = ddbSend.mock.calls[1]?.[0] as UpdateCommand;
    expect(updateCmd).toBeInstanceOf(UpdateCommand);
    expect(updateCmd.input.UpdateExpression).toBe("SET deployFiredAt = :now");
  });

  it("should silently skip a deployFiredAt CCF (concurrent operator deploy race)", async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [
        {
          PK: "EVENT#EVD",
          tenantId: "tenant-acme",
          eventId: "EVD",
          status: "DRAFT",
          deployAt: PAST,
        },
      ],
    });
    deploy.bulkDeployEvent.mockResolvedValue({
      kind: "ok",
      result: { eventId: "EVD", enqueued: 1, skipped: 0 },
    });
    ddbSend.mockImplementationOnce(async () => {
      const err: Error & { name?: string } = new Error("conditional check failed");
      err.name = "ConditionalCheckFailedException";
      throw err;
    });
    await expect(reconcileEventStatuses(ctx, NOW_ISO)).resolves.toBeUndefined();
  });

  it("should warn (no throw) when the deployFiredAt stamp fails with a non-CCF error", async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [
        {
          PK: "EVENT#EVD",
          tenantId: "tenant-acme",
          eventId: "EVD",
          status: "DRAFT",
          deployAt: PAST,
        },
      ],
    });
    deploy.bulkDeployEvent.mockResolvedValue({
      kind: "ok",
      result: { eventId: "EVD", enqueued: 1, skipped: 0 },
    });
    ddbSend.mockImplementationOnce(async () => {
      throw new Error("ddb down");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(reconcileEventStatuses(ctx, NOW_ISO)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
