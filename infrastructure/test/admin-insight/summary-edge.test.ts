import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminInsightSharedResources } from "../../lib/admin-insight/handlers/admin-insight-handler/shared";
import { summarizeTenants } from "../../lib/admin-insight/handlers/admin-insight-handler/summary";
import { makeTestControlDataRuntime } from "../problem-deploy/control-data/runtime.test-helpers";

/**
 * Issue #1418: admin-insight summary.ts は 75% branch だった。既存 summary.test は active/failed
 * 集計・dedup・pagination を見るが、`out.Count` の `?? default` 枝が未カバー。command を
 * TableName で分岐する fake で pin する。
 *
 * [Issue #2441 / Phase B PR-6] `countTenantDeployments` は raw `QueryCommand` + client-side
 * status 集計から `DeploymentsRepository.countActiveByTenant` (3 回の `Select=COUNT` Query、
 * active/COMPLETE/FAILED それぞれ) に置き換わった。fake は Deployments 宛の 3 呼び出しを
 * `ExpressionAttributeValues` の値 (`"FAILED"` / `"COMPLETE"` の有無) で区別する。
 */
const cfg = {
  deployActive: {} as Record<string, unknown>,
  deployCompleted: {} as Record<string, unknown>,
  deployFailed: {} as Record<string, unknown>,
  events: {} as Record<string, unknown>,
};
const ddb = {
  // biome-ignore lint/suspicious/noExplicitAny: fake dispatches by TableName + filter values.
  send: vi.fn(async (cmd: any) => {
    if (cmd instanceof QueryCommand) {
      if (cmd.input.TableName !== "Deployments") return cfg.events;
      const values = Object.values(cmd.input.ExpressionAttributeValues ?? {});
      if (values.includes("FAILED")) return cfg.deployFailed;
      if (values.includes("COMPLETE")) return cfg.deployCompleted;
      return cfg.deployActive;
    }
    return {};
  }),
};
const shared = {
  runtime: makeTestControlDataRuntime(),
  ddb,
  deploymentsTableName: "Deployments",
  eventsTableName: "Events",
} as unknown as AdminInsightSharedResources;

beforeEach(() => {
  vi.clearAllMocks();
  cfg.deployActive = {};
  cfg.deployCompleted = {};
  cfg.deployFailed = {};
  cfg.events = {};
});

describe("summarizeTenants edge branches", () => {
  it("should default deploy/event counts to 0 when DDB returns no Count", async () => {
    cfg.deployActive = {}; // no Count → out.Count ?? 0 (repository default)
    cfg.deployCompleted = {};
    cfg.deployFailed = {};
    cfg.events = {}; // no Count → out.Count ?? 0
    const res = await summarizeTenants(shared, ["t1"]);
    expect(res.items[0]).toEqual({
      tenantId: "t1",
      activeDeploys: 0,
      completedDeploys: 0,
      failedDeploys: 0,
      totalEvents: 0,
    });
  });

  it("should surface distinct active/completed/failed counts from the three countActiveByTenant queries", async () => {
    // 3 つとも別の値にして、 どれかの枝が他の Count を拾っていたら落ちるようにする。
    cfg.deployActive = { Count: 1 };
    cfg.deployCompleted = { Count: 2 };
    cfg.deployFailed = { Count: 3 };
    cfg.events = { Count: 4 };
    const res = await summarizeTenants(shared, ["t1"]);
    expect(res.items[0]).toMatchObject({
      activeDeploys: 1,
      completedDeploys: 2,
      failedDeploys: 3,
      totalEvents: 4,
    });
  });
});
