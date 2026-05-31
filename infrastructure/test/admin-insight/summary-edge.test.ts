import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminInsightSharedResources } from "../../lib/admin-insight/handlers/admin-insight-handler/shared";
import { summarizeTenants } from "../../lib/admin-insight/handlers/admin-insight-handler/summary";

/**
 * Issue #1418: admin-insight summary.ts は 75% branch だった。 既存 summary.test は active/failed
 * 集計・dedup・pagination を見るが、 out.Items / item.status / out.Count の `?? default` 枝と
 * neither-active-nor-failed status が未カバー。 command を TableName で分岐する fake で pin する。
 */
const cfg = {
  deploy: {} as Record<string, unknown>,
  events: {} as Record<string, unknown>,
};
const ddb = {
  // biome-ignore lint/suspicious/noExplicitAny: fake dispatches by TableName.
  send: vi.fn(async (cmd: any) => {
    if (cmd instanceof QueryCommand) {
      return cmd.input.TableName === "Deployments" ? cfg.deploy : cfg.events;
    }
    return {};
  }),
};
const shared = {
  ddb,
  deploymentsTableName: "Deployments",
  eventsTableName: "Events",
} as unknown as AdminInsightSharedResources;

beforeEach(() => {
  vi.clearAllMocks();
  cfg.deploy = {};
  cfg.events = {};
});

describe("summarizeTenants edge branches", () => {
  it("should default deploy/event counts when DDB returns no Items or Count", async () => {
    cfg.deploy = {}; // no Items → out.Items ?? []
    cfg.events = {}; // no Count → out.Count ?? 0
    const res = await summarizeTenants(shared, ["t1"]);
    expect(res.items[0]).toEqual({
      tenantId: "t1",
      activeDeploys: 0,
      failedDeploys: 0,
      totalEvents: 0,
    });
  });

  it("should ignore non-active/non-failed statuses and default a missing status to ''", async () => {
    cfg.deploy = {
      Items: [
        { status: "IN_PROGRESS" }, // active
        { status: "FAILED" }, // failed
        { status: "COMPLETE" }, // neither → ignored
        {}, // missing status → "" → ignored
      ],
    };
    cfg.events = { Count: 4 };
    const res = await summarizeTenants(shared, ["t1"]);
    expect(res.items[0]).toMatchObject({ activeDeploys: 1, failedDeploys: 1, totalEvents: 4 });
  });
});
