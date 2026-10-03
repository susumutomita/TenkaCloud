import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "../../lib/problem-deploy/handlers/disruption-executor-handler/execute";
import {
  parseDisruptionFiredDetail,
  routeDisruptionInvocation,
} from "../../lib/problem-deploy/handlers/disruption-executor-handler/route";
import type { ProblemDisruptionEntry } from "../../lib/utils/discover-problems-catalog";

/**
 * [#1419] executor router: EventBridge inject envelope と scheduler revert payload を
 * 判別し、 それぞれ executeDisruptionAction / sendDispatch dep に振り分けることを pin する。
 */

const action = {
  kind: "ssm-run-command" as const,
  targetRef: "WorkerInstanceIds",
  paramTemplate: { commands: ["delay {{delayMs}}"] },
  revert: { afterSeconds: 600 },
};
const withAction: ProblemDisruptionEntry = {
  id: "ec2-latency-injection",
  name: "latency",
  eventDetailType: "DegradedDisruptionFired",
  parameters: { delayMs: 200 },
  action,
};

const firedDetail = {
  disruptionId: "ec2-latency-injection",
  eventId: "evt-1",
  problemId: "microservice-migration-battle",
  tenantId: "tenant-1",
  teamId: "team-1",
  parameters: { delayMs: 200 },
  requestId: "req-1",
  firedAt: "2026-06-02T00:00:00.000Z",
};

const deploymentTarget = {
  jobId: "job-1",
  region: "ap-northeast-1",
  competitorRoleArn: "arn:aws:iam::111122223333:role/TenkaCloud-CompetitorDeploy-Role",
  externalIdParameterName: "/tenkacloud/tenant-1/external-id",
  stackOutputs: { WorkerInstanceIds: "i-aaa" },
};

function makeDeps(over: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return {
    problemsDisruptions: { "microservice-migration-battle": [withAction] },
    claimExecution: vi.fn().mockResolvedValue("claimed"),
    resolveDeployment: vi.fn().mockResolvedValue(deploymentTarget),
    sendDispatch: vi.fn().mockResolvedValue(undefined),
    scheduleRevert: vi.fn().mockResolvedValue(undefined),
    scheduleInject: vi.fn().mockResolvedValue(undefined),
    scheduleRecurring: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

describe("recurring routing", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should parse the recurrence block from the initial fired event", () => {
    const parsed = parseDisruptionFiredDetail({
      detail: { ...firedDetail, recurrence: { intervalMinutes: 5, maxFires: 6 } },
    });
    expect(parsed?.recurrence).toEqual({ intervalMinutes: 5, maxFires: 6 });
  });

  it("should drop a malformed recurrence (missing maxFires / non-positive)", () => {
    expect(
      parseDisruptionFiredDetail({ detail: { ...firedDetail, recurrence: { intervalMinutes: 5 } } })
        ?.recurrence,
    ).toBeUndefined();
    expect(
      parseDisruptionFiredDetail({
        detail: { ...firedDetail, recurrence: { intervalMinutes: 0, maxFires: 6 } },
      })?.recurrence,
    ).toBeUndefined();
  });

  it("should route a {mode:'inject-recurring'} payload to the per-tick recurring inject", async () => {
    const deps = makeDeps();
    const outcome = await routeDisruptionInvocation(
      { mode: "inject-recurring", detail: firedDetail },
      deps,
    );
    expect(outcome).toEqual({ kind: "ok", jobId: "job-1" });
    expect(deps.claimExecution).toHaveBeenCalledWith(expect.anything(), "recurring");
    expect(deps.sendDispatch).toHaveBeenCalledTimes(1);
  });

  it("should reject an inject-recurring payload whose detail is invalid", async () => {
    const outcome = await routeDisruptionInvocation(
      { mode: "inject-recurring", detail: { ...firedDetail, teamId: "" } },
      makeDeps(),
    );
    expect(outcome).toEqual({ kind: "invalid_event" });
  });
});

describe("parseDisruptionFiredDetail", () => {
  it("should narrow a valid EventBridge envelope detail", () => {
    expect(parseDisruptionFiredDetail({ "detail-type": "X", detail: firedDetail })).toEqual(
      firedDetail,
    );
  });

  it("should default parameters to {} when absent / non-object", () => {
    const { parameters, ...rest } = firedDetail;
    expect(parseDisruptionFiredDetail({ detail: rest })?.parameters).toEqual({});
    expect(
      parseDisruptionFiredDetail({ detail: { ...rest, parameters: ["x"] } })?.parameters,
    ).toEqual({});
  });

  it("should return undefined for a missing detail or a missing required field", () => {
    expect(parseDisruptionFiredDetail(undefined)).toBeUndefined();
    expect(parseDisruptionFiredDetail({})).toBeUndefined();
    expect(parseDisruptionFiredDetail({ detail: { ...firedDetail, teamId: "" } })).toBeUndefined();
  });

  // scheduled fire: afterMinutes は正の有限数のみ採用
  it("should carry a positive finite afterMinutes and drop invalid ones", () => {
    expect(parseDisruptionFiredDetail({ detail: { ...firedDetail, afterMinutes: 30 } })).toEqual({
      ...firedDetail,
      afterMinutes: 30,
    });
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, "30"]) {
      expect(
        parseDisruptionFiredDetail({ detail: { ...firedDetail, afterMinutes: bad } }),
      ).not.toHaveProperty("afterMinutes");
    }
  });
});

describe("routeDisruptionInvocation (#1419)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should route an EventBridge fired envelope to executeDisruptionAction (inject)", async () => {
    const deps = makeDeps();
    const outcome = await routeDisruptionInvocation(
      { "detail-type": "DegradedDisruptionFired", detail: firedDetail },
      deps,
    );
    expect(outcome).toEqual({ kind: "ok", jobId: "job-1" });
    expect(deps.sendDispatch).toHaveBeenCalledTimes(1); // the inject send
    expect(deps.scheduleRevert).toHaveBeenCalledTimes(1);
  });

  it("should route a scheduler revert payload straight to sendDispatch (no re-execution)", async () => {
    const deps = makeDeps();
    const revertDispatch = {
      kind: "ssm-run-command" as const,
      target: "i-aaa",
      params: { commands: ["undo"] },
    };
    const outcome = await routeDisruptionInvocation(
      { mode: "revert", dispatch: revertDispatch, target: deploymentTarget },
      deps,
    );
    expect(outcome).toEqual({ kind: "reverted" });
    expect(deps.sendDispatch).toHaveBeenCalledWith(revertDispatch, deploymentTarget);
    expect(deps.claimExecution).not.toHaveBeenCalled();
    expect(deps.scheduleRevert).not.toHaveBeenCalled();
  });

  it("should defer the inject when the fired envelope carries afterMinutes > 0", async () => {
    const deps = makeDeps();
    const outcome = await routeDisruptionInvocation(
      { detail: { ...firedDetail, afterMinutes: 30 } },
      deps,
    );
    expect(outcome).toEqual({ kind: "scheduled" });
    expect(deps.scheduleInject).toHaveBeenCalledTimes(1);
    expect(deps.sendDispatch).not.toHaveBeenCalled();
  });

  it("should route a scheduler inject payload to executeScheduledInject (inject-phase claim)", async () => {
    const deps = makeDeps();
    const outcome = await routeDisruptionInvocation({ mode: "inject", detail: firedDetail }, deps);
    expect(outcome).toEqual({ kind: "ok", jobId: "job-1" });
    // distinct inject-phase claim fences aws-scheduler redelivery (not the fire-time event claim)
    expect(deps.claimExecution).toHaveBeenCalledWith(firedDetail, "inject");
    expect(deps.sendDispatch).toHaveBeenCalledTimes(1);
    expect(deps.scheduleRevert).toHaveBeenCalledTimes(1);
  });

  it("should return invalid_event for an inject payload with a malformed detail", async () => {
    const deps = makeDeps();
    expect(
      await routeDisruptionInvocation({ mode: "inject", detail: { teamId: "team-1" } }, deps),
    ).toEqual({ kind: "invalid_event" });
    expect(deps.sendDispatch).not.toHaveBeenCalled();
  });

  it("should return invalid_event for a malformed envelope (neither revert nor a valid detail)", async () => {
    const deps = makeDeps();
    expect(await routeDisruptionInvocation({ detail: { teamId: "team-1" } }, deps)).toEqual({
      kind: "invalid_event",
    });
    expect(deps.sendDispatch).not.toHaveBeenCalled();
  });

  it("should treat a revert payload missing dispatch/target as a (failing) inject parse", async () => {
    const deps = makeDeps();
    expect(await routeDisruptionInvocation({ mode: "revert" }, deps)).toEqual({
      kind: "invalid_event",
    });
    expect(deps.sendDispatch).not.toHaveBeenCalled();
  });
});
