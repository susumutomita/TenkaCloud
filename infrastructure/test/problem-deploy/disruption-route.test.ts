import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "../../lib/problem-deploy/handlers/disruption-executor-handler/execute";
import {
  parseDisruptionFiredDetail,
  routeDisruptionInvocation,
} from "../../lib/problem-deploy/handlers/disruption-executor-handler/route";
import type { ProblemDisruptionEntry } from "../../lib/utils/discover-problems-catalog";

/**
 * [ADR-031 / #1419] executor router: EventBridge inject envelope と scheduler revert payload を
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
    ...over,
  };
}

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
});

describe("routeDisruptionInvocation (ADR-031 #1419)", () => {
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
