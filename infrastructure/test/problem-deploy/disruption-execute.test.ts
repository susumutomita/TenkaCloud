import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DeploymentTarget,
  type DisruptionFiredDetail,
  type ExecutorDeps,
  executeDisruptionAction,
} from "../../lib/problem-deploy/handlers/disruption-executor-handler/execute";
import type { ProblemDisruptionEntry } from "../../lib/utils/discover-problems-catalog";

/**
 * [ADR-031 / #1419] executor orchestration を pin する。 副作用は deps 経由のみなので、
 * 各 dep を mock して分岐 (no_action / duplicate / no_deployment / ok + 順序) を観察する。
 */

const withAction: ProblemDisruptionEntry = {
  id: "ec2-latency-injection",
  name: "latency",
  eventDetailType: "DegradedDisruptionFired",
  parameters: { delayMs: 200, device: "eth0" },
  action: {
    kind: "ssm-run-command",
    targetRef: "WorkerInstanceIds",
    documentName: "AWS-RunShellScript",
    paramTemplate: { commands: ["tc qdisc add dev {{device}} root netem delay {{delayMs}}ms"] },
    revert: {
      afterSeconds: 600,
      paramTemplate: { commands: ["tc qdisc del dev {{device}} root"] },
    },
  },
};

const detail: DisruptionFiredDetail = {
  disruptionId: "ec2-latency-injection",
  eventId: "evt-1",
  problemId: "microservice-migration-battle",
  tenantId: "tenant-1",
  teamId: "team-1",
  parameters: { delayMs: 200, device: "eth0" },
  requestId: "req-1",
  firedAt: "2026-06-02T00:00:00.000Z",
};

const target: DeploymentTarget = {
  jobId: "job-1",
  region: "ap-northeast-1",
  competitorRoleArn: "arn:aws:iam::111122223333:role/TenkaCloud-CompetitorDeploy-Role",
  externalIdParameterName: "/tenkacloud/tenant-1/external-id",
  stackOutputs: { WorkerInstanceIds: "i-aaa,i-bbb" },
};

function makeDeps(over: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return {
    problemsDisruptions: { "microservice-migration-battle": [withAction] },
    claimExecution: vi.fn().mockResolvedValue("claimed"),
    resolveDeployment: vi.fn().mockResolvedValue(target),
    sendDispatch: vi.fn().mockResolvedValue(undefined),
    scheduleRevert: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

describe("executeDisruptionAction (ADR-031 #1419)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should inject the built dispatch then schedule the revert on the happy path", async () => {
    const deps = makeDeps();
    const outcome = await executeDisruptionAction(detail, deps);
    expect(outcome).toEqual({ kind: "ok", jobId: "job-1" });

    expect(deps.sendDispatch).toHaveBeenCalledTimes(1);
    const [injected, sentTarget] = (deps.sendDispatch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(injected).toEqual({
      kind: "ssm-run-command",
      target: "i-aaa,i-bbb",
      documentName: "AWS-RunShellScript",
      params: { commands: ["tc qdisc add dev eth0 root netem delay 200ms"] },
    });
    expect(sentTarget).toBe(target);

    expect(deps.scheduleRevert).toHaveBeenCalledTimes(1);
    const [detailArg, revert, , afterSeconds] = (deps.scheduleRevert as ReturnType<typeof vi.fn>)
      .mock.calls[0];
    expect(detailArg).toBe(detail); // revert payload / idempotent schedule name 用に detail を渡す
    expect(revert).toEqual({
      kind: "ssm-run-command",
      target: "i-aaa,i-bbb",
      documentName: "AWS-RunShellScript",
      params: { commands: ["tc qdisc del dev eth0 root"] },
    });
    expect(afterSeconds).toBe(600);
  });

  it("should be a no-op (no_action) when the disruption declares no action (Phase A)", async () => {
    const noAction: ProblemDisruptionEntry = { ...withAction, action: undefined };
    const deps = makeDeps({
      problemsDisruptions: { "microservice-migration-battle": [noAction] },
    });
    expect(await executeDisruptionAction(detail, deps)).toEqual({ kind: "no_action" });
    expect(deps.claimExecution).not.toHaveBeenCalled();
    expect(deps.sendDispatch).not.toHaveBeenCalled();
  });

  it("should return unknown_disruption when the problem / disruption is not in the catalog", async () => {
    expect(await executeDisruptionAction(detail, makeDeps({ problemsDisruptions: {} }))).toEqual({
      kind: "unknown_disruption",
    });
    const otherId = makeDeps({
      problemsDisruptions: { "microservice-migration-battle": [{ ...withAction, id: "other" }] },
    });
    expect(await executeDisruptionAction(detail, otherId)).toEqual({ kind: "unknown_disruption" });
  });

  it("should stop at the idempotency claim when the execution is a duplicate", async () => {
    const deps = makeDeps({ claimExecution: vi.fn().mockResolvedValue("duplicate") });
    expect(await executeDisruptionAction(detail, deps)).toEqual({ kind: "duplicate" });
    expect(deps.resolveDeployment).not.toHaveBeenCalled();
    expect(deps.sendDispatch).not.toHaveBeenCalled();
    expect(deps.scheduleRevert).not.toHaveBeenCalled();
  });

  it("should be a no-op (no_deployment) when the team has no resolvable deployment", async () => {
    const deps = makeDeps({ resolveDeployment: vi.fn().mockResolvedValue(undefined) });
    expect(await executeDisruptionAction(detail, deps)).toEqual({ kind: "no_deployment" });
    expect(deps.sendDispatch).not.toHaveBeenCalled();
    expect(deps.scheduleRevert).not.toHaveBeenCalled();
  });

  it("should not schedule the revert when the inject send fails (error propagates)", async () => {
    const deps = makeDeps({
      sendDispatch: vi.fn().mockRejectedValue(new Error("SendCommand denied")),
    });
    await expect(executeDisruptionAction(detail, deps)).rejects.toThrow("SendCommand denied");
    expect(deps.scheduleRevert).not.toHaveBeenCalled();
  });
});
