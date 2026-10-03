import { GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { endEvent } from "../../lib/problem-deploy/handlers/event-handler/end-event";
import type { EventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

/**
 * Issue #1418: endEvent (event-handler/end-event.ts) は 62.5% branch だった。 ConditionalCheckFailed
 * の probe による not_found / not_endable 区別、 非 CCF rethrow、 !updatedEvent、 per-deployment
 * denormalize の CCF skip / 非 CCF throw / PK filter を pin する。
 */
const ccf = () =>
  Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });
const cfg = {
  eventUpdate: undefined as { resolve?: unknown; reject?: unknown } | undefined,
  probeItem: undefined as Record<string, unknown> | undefined,
  depItems: [] as Record<string, unknown>[],
  depReject: undefined as unknown,
};
const ddb = {
  // biome-ignore lint/suspicious/noExplicitAny: fake dispatches by command + TableName.
  send: vi.fn(async (cmd: any) => {
    if (cmd instanceof GetCommand) return { Item: cfg.probeItem };
    if (cmd instanceof QueryCommand) return { Items: cfg.depItems };
    if (cmd instanceof UpdateCommand) {
      if (cmd.input.TableName === "Events") {
        if (cfg.eventUpdate?.reject) throw cfg.eventUpdate.reject;
        return { Attributes: cfg.eventUpdate?.resolve };
      }
      // deployments denormalize
      if (cfg.depReject) throw cfg.depReject;
      return {};
    }
    return {};
  }),
};
const shared = {
  runtime: makeTestControlDataRuntime(),
  ddb,
  eventsTableName: "Events",
  // resolveEventRepositories (mirror 対応 seam) が Teams repo も構築するため必須。
  teamsTableName: "Teams",
  deploymentsTableName: "Deployments",
} as unknown as EventSharedResources;

beforeEach(() => {
  vi.clearAllMocks();
  cfg.eventUpdate = { resolve: { eventId: "e1", status: "ENDED" } };
  cfg.probeItem = undefined;
  cfg.depItems = [];
  cfg.depReject = undefined;
});

describe("endEvent", () => {
  it("should end a READY event and denormalize eventEndsAt to its deployments", async () => {
    cfg.depItems = [{ PK: "DEPLOYMENT#1" }, { PK: "DEPLOYMENT#2" }];
    const res = await endEvent(shared, "t1", "e1", 1_700_000_000_000);
    expect(res).toMatchObject({ kind: "ok", updatedDeployments: 2 });
    // 1 event update + 2 deployment updates.
    expect(ddb.send.mock.calls.filter((c) => c[0] instanceof UpdateCommand)).toHaveLength(3);
    const deploymentUpdates = ddb.send.mock.calls
      .map((c) => c[0])
      .filter(
        (cmd): cmd is UpdateCommand =>
          cmd instanceof UpdateCommand && cmd.input.TableName === "Deployments",
      );
    expect(deploymentUpdates.map((cmd) => cmd.input.Key)).toEqual([
      { PK: "DEPLOYMENT#1", SK: "META" },
      { PK: "DEPLOYMENT#2", SK: "META" },
    ]);
  });

  it("should return not_found when the ConditionalCheck fails and the event is absent", async () => {
    cfg.eventUpdate = { reject: ccf() };
    cfg.probeItem = undefined;
    expect(await endEvent(shared, "t1", "e1", 1)).toEqual({ kind: "not_found" });
  });

  it("should return not_found on a tenant mismatch during the probe", async () => {
    cfg.eventUpdate = { reject: ccf() };
    cfg.probeItem = { tenantId: "other", status: "READY" };
    expect(await endEvent(shared, "t1", "e1", 1)).toEqual({ kind: "not_found" });
  });

  it("should return not_endable with the current status when not READY", async () => {
    cfg.eventUpdate = { reject: ccf() };
    cfg.probeItem = { tenantId: "t1", status: "DRAFT" };
    expect(await endEvent(shared, "t1", "e1", 1)).toEqual({ kind: "not_endable", status: "DRAFT" });
  });

  it("should report '?' status when the probed status is not a string", async () => {
    cfg.eventUpdate = { reject: ccf() };
    cfg.probeItem = { tenantId: "t1", status: 42 };
    expect(await endEvent(shared, "t1", "e1", 1)).toEqual({ kind: "not_endable", status: "?" });
  });

  it("should rethrow a non-ConditionalCheck error from the event update", async () => {
    cfg.eventUpdate = { reject: new Error("ddb down") };
    await expect(endEvent(shared, "t1", "e1", 1)).rejects.toThrow("ddb down");
  });

  it("should return not_found when the update returns no Attributes", async () => {
    cfg.eventUpdate = { resolve: undefined };
    expect(await endEvent(shared, "t1", "e1", 1)).toEqual({ kind: "not_found" });
  });

  it("should skip a deployment denormalize that hits a ConditionalCheck (idempotent)", async () => {
    cfg.depItems = [{ PK: "DEPLOYMENT#1" }];
    cfg.depReject = ccf();
    const res = await endEvent(shared, "t1", "e1", 1);
    expect(res).toMatchObject({ kind: "ok", updatedDeployments: 1 });
  });

  it("should rethrow a non-ConditionalCheck error from a deployment denormalize", async () => {
    cfg.depItems = [{ PK: "DEPLOYMENT#1" }];
    cfg.depReject = new Error("dep ddb down");
    await expect(endEvent(shared, "t1", "e1", 1)).rejects.toThrow("dep ddb down");
  });
});
