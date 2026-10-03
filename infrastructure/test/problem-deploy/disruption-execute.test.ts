import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DeploymentTarget,
  type DisruptionFiredDetail,
  type ExecutorDeps,
  executeDisruptionAction,
  executeRecurringInject,
  executeScheduledInject,
} from "../../lib/problem-deploy/handlers/disruption-executor-handler/execute";
import type { ProblemDisruptionEntry } from "../../lib/utils/discover-problems-catalog";

/**
 * [#1419] executor orchestration を pin する。 副作用は deps 経由のみなので、
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
    scheduleInject: vi.fn().mockResolvedValue(undefined),
    scheduleRecurring: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

describe("executeDisruptionAction (#1419)", () => {
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

  // scheduled fire
  it("should defer the inject (schedule it) when afterMinutes > 0, after claiming", async () => {
    const deps = makeDeps();
    const scheduled: DisruptionFiredDetail = { ...detail, afterMinutes: 30 };
    const outcome = await executeDisruptionAction(scheduled, deps);
    expect(outcome).toEqual({ kind: "scheduled" });
    // claim is taken first (dedupes EventBridge redelivery before scheduling)
    expect(deps.claimExecution).toHaveBeenCalledTimes(1);
    expect(deps.scheduleInject).toHaveBeenCalledTimes(1);
    expect(deps.scheduleInject).toHaveBeenCalledWith(scheduled, 30);
    // the inject itself does NOT run now
    expect(deps.resolveDeployment).not.toHaveBeenCalled();
    expect(deps.sendDispatch).not.toHaveBeenCalled();
    expect(deps.scheduleRevert).not.toHaveBeenCalled();
  });

  it("should not defer when afterMinutes is 0 (immediate inject, regression)", async () => {
    const deps = makeDeps();
    const outcome = await executeDisruptionAction({ ...detail, afterMinutes: 0 }, deps);
    expect(outcome).toEqual({ kind: "ok", jobId: "job-1" });
    expect(deps.scheduleInject).not.toHaveBeenCalled();
    expect(deps.sendDispatch).toHaveBeenCalledTimes(1);
  });

  it("should not schedule the inject when the fired event is a duplicate", async () => {
    const deps = makeDeps({ claimExecution: vi.fn().mockResolvedValue("duplicate") });
    expect(await executeDisruptionAction({ ...detail, afterMinutes: 30 }, deps)).toEqual({
      kind: "duplicate",
    });
    expect(deps.scheduleInject).not.toHaveBeenCalled();
  });
});

describe("executeScheduledInject (deferred inject)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should claim the inject phase, then inject + schedule revert", async () => {
    const deps = makeDeps();
    const outcome = await executeScheduledInject(detail, deps);
    expect(outcome).toEqual({ kind: "ok", jobId: "job-1" });
    // inject-phase claim (distinct from the fire-time event claim) fences scheduler redelivery
    expect(deps.claimExecution).toHaveBeenCalledWith(detail, "inject");
    expect(deps.sendDispatch).toHaveBeenCalledTimes(1);
    expect(deps.scheduleRevert).toHaveBeenCalledTimes(1);
  });

  it("should stop (duplicate) when the inject phase was already claimed (scheduler redelivery)", async () => {
    const deps = makeDeps({ claimExecution: vi.fn().mockResolvedValue("duplicate") });
    expect(await executeScheduledInject(detail, deps)).toEqual({ kind: "duplicate" });
    expect(deps.sendDispatch).not.toHaveBeenCalled();
    expect(deps.scheduleRevert).not.toHaveBeenCalled();
  });

  it("should be a no-op (no_action) when the disruption declares no action", async () => {
    const noAction: ProblemDisruptionEntry = { ...withAction, action: undefined };
    const deps = makeDeps({
      problemsDisruptions: { "microservice-migration-battle": [noAction] },
    });
    expect(await executeScheduledInject(detail, deps)).toEqual({ kind: "no_action" });
    expect(deps.sendDispatch).not.toHaveBeenCalled();
  });

  it("should return unknown_disruption when not in the catalog", async () => {
    expect(await executeScheduledInject(detail, makeDeps({ problemsDisruptions: {} }))).toEqual({
      kind: "unknown_disruption",
    });
  });

  it("should be a no-op (no_deployment) when the team has no resolvable deployment", async () => {
    const deps = makeDeps({ resolveDeployment: vi.fn().mockResolvedValue(undefined) });
    expect(await executeScheduledInject(detail, deps)).toEqual({ kind: "no_deployment" });
    expect(deps.sendDispatch).not.toHaveBeenCalled();
  });
});

describe("recurring fire", () => {
  beforeEach(() => vi.clearAllMocks());
  const recurringDetail: DisruptionFiredDetail = {
    ...detail,
    recurrence: { intervalMinutes: 5, maxFires: 6 },
  };

  it("should create the recurring schedule (not inject yet) on the initial fired event", async () => {
    const deps = makeDeps();
    const outcome = await executeDisruptionAction(recurringDetail, deps);
    expect(outcome).toEqual({ kind: "scheduled" });
    expect(deps.scheduleRecurring).toHaveBeenCalledWith(recurringDetail, 5, 6);
    // the initial fired event only schedules — injection happens on each tick.
    expect(deps.sendDispatch).not.toHaveBeenCalled();
    expect(deps.scheduleInject).not.toHaveBeenCalled();
  });

  it("should inject + schedule revert on each recurring tick, claiming with the recurring phase", async () => {
    const deps = makeDeps();
    const outcome = await executeRecurringInject(detail, deps);
    expect(outcome).toEqual({ kind: "ok", jobId: "job-1" });
    expect(deps.claimExecution).toHaveBeenCalledWith(detail, "recurring");
    expect(deps.sendDispatch).toHaveBeenCalledTimes(1);
    expect(deps.scheduleRevert).toHaveBeenCalledTimes(1);
  });

  it("should suppress a duplicate redelivery of the same recurring tick", async () => {
    const deps = makeDeps({ claimExecution: vi.fn().mockResolvedValue("duplicate") });
    expect(await executeRecurringInject(detail, deps)).toEqual({ kind: "duplicate" });
    expect(deps.sendDispatch).not.toHaveBeenCalled();
  });

  it("should return no_action / unknown_disruption for an undeclared or unknown tick", async () => {
    const noAction: ProblemDisruptionEntry = { ...withAction, action: undefined };
    expect(
      await executeRecurringInject(
        detail,
        makeDeps({ problemsDisruptions: { "microservice-migration-battle": [noAction] } }),
      ),
    ).toEqual({ kind: "no_action" });
    expect(await executeRecurringInject(detail, makeDeps({ problemsDisruptions: {} }))).toEqual({
      kind: "unknown_disruption",
    });
  });
});
