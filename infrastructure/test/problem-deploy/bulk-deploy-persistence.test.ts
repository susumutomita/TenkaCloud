import { TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  markBulkEventDeploying,
  markPublishFailuresFailed,
  writeBulkDeployPlan,
} from "../../lib/problem-deploy/handlers/event-handler/bulk-deploy/persistence";
import type { EventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

/**
 * Issue #1418: bulk-deploy/persistence.ts は 33% branch だった。 writeBulkDeployPlan の
 * replaces-existing chunking + Put/Delete 構築、 markBulkEventDeploying / markPublishFailuresFailed
 * の ConditionalCheck no-op / 非 CCF throw を pin する。
 */
const ccf = () =>
  Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });
const cfg = { eventUpdateReject: undefined as unknown, depUpdateReject: undefined as unknown };
const ddb = {
  // biome-ignore lint/suspicious/noExplicitAny: fake dispatches by command + TableName.
  send: vi.fn(async (cmd: any) => {
    if (cmd instanceof TransactWriteCommand) return {};
    if (cmd instanceof UpdateCommand) {
      if (cmd.input.TableName === "Events") {
        if (cfg.eventUpdateReject) throw cfg.eventUpdateReject;
        return {};
      }
      if (cfg.depUpdateReject) throw cfg.depUpdateReject;
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

// biome-ignore lint/suspicious/noExplicitAny: minimal PlanEntry list for the writer.
const planEntry = (jobId: string, replacesJobId?: string): any => ({
  item: { PK: `DEPLOYMENT#${jobId}`, jobId },
  ...(replacesJobId ? { replacesJobId } : {}),
});

beforeEach(() => {
  vi.clearAllMocks();
  cfg.eventUpdateReject = undefined;
  cfg.depUpdateReject = undefined;
});

describe("writeBulkDeployPlan", () => {
  it("should issue a single Put-only TransactWrite for a small non-replacing plan", async () => {
    await writeBulkDeployPlan(shared, "t1", [planEntry("a"), planEntry("b")], false);
    const calls = ddb.send.mock.calls.filter((c) => c[0] instanceof TransactWriteCommand);
    expect(calls).toHaveLength(1);
    const items = calls[0][0].input.TransactItems;
    expect(items).toHaveLength(2);
    expect(items.every((i: Record<string, unknown>) => "Put" in i)).toBe(true);
  });

  it("should emit Put+Delete per entry when replacing and chunk by the 25-op limit", async () => {
    // replacesExisting → 2 ops/entry → 12 entries/chunk (floor(25/2)). 13 entries → 2 chunks.
    const plan = Array.from({ length: 13 }, (_, i) => planEntry(`j${i}`, `old${i}`));
    await writeBulkDeployPlan(shared, "t1", plan, true);
    const calls = ddb.send.mock.calls.filter((c) => c[0] instanceof TransactWriteCommand);
    expect(calls).toHaveLength(2); // 13 entries / 12-per-chunk → 2 chunks
    // First chunk: 12 entries × (Put + Delete) = 24 ops.
    expect(calls[0][0].input.TransactItems).toHaveLength(24);
    expect(
      calls[0][0].input.TransactItems.some((i: Record<string, unknown>) => "Delete" in i),
    ).toBe(true);
  });

  it("should omit the Delete op for an entry without replacesJobId even when replacing", async () => {
    await writeBulkDeployPlan(shared, "t1", [planEntry("a")], true); // no replacesJobId
    const items = ddb.send.mock.calls.find((c) => c[0] instanceof TransactWriteCommand)?.[0].input
      .TransactItems;
    expect(items).toHaveLength(1);
    expect("Delete" in items[0]).toBe(false);
  });
});

describe("markBulkEventDeploying", () => {
  it("should update the event status to DEPLOYING", async () => {
    await markBulkEventDeploying(shared, "t1", "e1", "2026-06-01T00:00:00Z");
    expect(ddb.send).toHaveBeenCalledTimes(1);
  });

  it("should swallow a ConditionalCheck failure (no-op)", async () => {
    cfg.eventUpdateReject = ccf();
    await expect(
      markBulkEventDeploying(shared, "t1", "e1", "2026-06-01T00:00:00Z"),
    ).resolves.toBeUndefined();
  });

  it("should rethrow a non-ConditionalCheck error", async () => {
    cfg.eventUpdateReject = new Error("ddb down");
    await expect(
      markBulkEventDeploying(shared, "t1", "e1", "2026-06-01T00:00:00Z"),
    ).rejects.toThrow("ddb down");
  });
});

describe("markPublishFailuresFailed", () => {
  const failures = [{ jobId: "1", reason: "boom" }];

  it("should mark PENDING deployments FAILED", async () => {
    await markPublishFailuresFailed(shared, "t1", failures, "2026-06-01T00:00:00Z");
    expect(ddb.send).toHaveBeenCalledTimes(1);
  });

  it("should swallow a ConditionalCheck failure (already advanced elsewhere)", async () => {
    cfg.depUpdateReject = ccf();
    await expect(
      markPublishFailuresFailed(shared, "t1", failures, "2026-06-01T00:00:00Z"),
    ).resolves.toBeUndefined();
  });

  it("should rethrow a non-ConditionalCheck error", async () => {
    cfg.depUpdateReject = new Error("ddb down");
    await expect(
      markPublishFailuresFailed(shared, "t1", failures, "2026-06-01T00:00:00Z"),
    ).rejects.toThrow("ddb down");
  });
});
