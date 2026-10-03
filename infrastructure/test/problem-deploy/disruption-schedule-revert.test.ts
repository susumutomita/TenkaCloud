import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DisruptionDispatch } from "../../lib/problem-deploy/handlers/disruption-executor-handler/dispatch-command";
import type {
  DeploymentTarget,
  DisruptionFiredDetail,
} from "../../lib/problem-deploy/handlers/disruption-executor-handler/execute";
import {
  injectScheduleName,
  recurringScheduleName,
  revertAtExpression,
  revertScheduleName,
  type ScheduleRevertDeps,
  scheduleInject,
  scheduleRecurring,
  scheduleRevert,
} from "../../lib/problem-deploy/handlers/disruption-executor-handler/schedule-revert";

/**
 * Issue #1419: scheduleRevert の one-shot aws-scheduler 登録を mocked client で pin し、
 * every injection が自動復旧されることを保証する。
 * 冪等 name / at(...) 式 / DELETE-after-completion / revert payload を観察する。
 */

const detail: DisruptionFiredDetail = {
  disruptionId: "ec2-latency-injection",
  eventId: "evt-1",
  problemId: "microservice-migration-battle",
  tenantId: "tenant-1",
  teamId: "team-1",
  parameters: { delayMs: 200 },
  requestId: "req-1",
  firedAt: "2026-06-02T00:00:00.000Z",
};

const target: DeploymentTarget = {
  jobId: "job-1",
  region: "ap-northeast-1",
  competitorRoleArn: "arn:aws:iam::111122223333:role/TenkaCloud-CompetitorDeploy-Role",
  externalIdParameterName: "/tenkacloud/tenant-1/external-id",
  stackOutputs: { WorkerInstanceIds: "i-aaa" },
};

const revert: DisruptionDispatch = {
  kind: "ssm-run-command",
  target: "i-aaa",
  documentName: "AWS-RunShellScript",
  params: { commands: ["tc qdisc del dev eth0 root"] },
};

function makeDeps(send = vi.fn().mockResolvedValue({})): {
  deps: ScheduleRevertDeps;
  send: typeof send;
} {
  return {
    deps: {
      scheduler: { send } as unknown as ScheduleRevertDeps["scheduler"],
      schedulerRoleArn: "arn:aws:iam::444455556666:role/tc-disruption-scheduler",
      revertTargetArn: "arn:aws:lambda:ap-northeast-1:444455556666:function:tc-disruption-executor",
    },
    send,
  };
}

describe("revertScheduleName", () => {
  it("should be the idempotent EXEC# twin sanitized to the scheduler name charset / length", () => {
    expect(revertScheduleName(detail)).toBe("tc-revert-req-1-team-1");
    const dirty = { ...detail, requestId: "req/1 weird", teamId: "team#1" };
    expect(revertScheduleName(dirty)).toBe("tc-revert-req-1-weird-team-1");
    const long = { ...detail, requestId: "r".repeat(100) };
    expect(revertScheduleName(long).length).toBe(64);
  });
});

describe("revertAtExpression", () => {
  it("should produce a UTC at(...) expression at firedAt + afterSeconds (second precision)", () => {
    expect(revertAtExpression("2026-06-02T00:00:00.000Z", 600)).toBe("at(2026-06-02T00:10:00)");
  });
});

describe("scheduleRevert (#1419)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should create a one-shot DELETE-after schedule invoking the target with the revert payload", async () => {
    const { deps, send } = makeDeps();
    await scheduleRevert(revert, detail, target, 600, deps);
    const input = send.mock.calls[0][0].input;
    expect(input.Name).toBe("tc-revert-req-1-team-1");
    expect(input.ScheduleExpression).toBe("at(2026-06-02T00:10:00)");
    expect(input.FlexibleTimeWindow).toEqual({ Mode: "OFF" });
    expect(input.ActionAfterCompletion).toBe("DELETE");
    expect(input.State).toBe("ENABLED");
    expect(input.Target.Arn).toBe(deps.revertTargetArn);
    expect(input.Target.RoleArn).toBe(deps.schedulerRoleArn);
    expect(JSON.parse(input.Target.Input)).toEqual({
      mode: "revert",
      detail,
      dispatch: revert,
      target,
    });
  });

  it("should propagate scheduler errors (revert scheduling failure is loud — INV-2)", async () => {
    const { deps } = makeDeps(vi.fn().mockRejectedValue(new Error("ConflictException")));
    await expect(scheduleRevert(revert, detail, target, 600, deps)).rejects.toThrow(
      "ConflictException",
    );
  });
});

describe("injectScheduleName", () => {
  it("should be the idempotent tc-inject- twin of revert (requestId/teamId)", () => {
    expect(injectScheduleName(detail)).toBe("tc-inject-req-1-team-1");
    expect(injectScheduleName({ ...detail, requestId: "r".repeat(100) }).length).toBe(64);
  });
});

describe("scheduleInject (scheduled fire)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should create a one-shot at firedAt + afterMinutes invoking the target with mode:inject", async () => {
    const { deps, send } = makeDeps();
    await scheduleInject(detail, 30, deps);
    const input = send.mock.calls[0][0].input;
    expect(input.Name).toBe("tc-inject-req-1-team-1");
    expect(input.ScheduleExpression).toBe("at(2026-06-02T00:30:00)");
    expect(input.FlexibleTimeWindow).toEqual({ Mode: "OFF" });
    expect(input.ActionAfterCompletion).toBe("DELETE");
    expect(input.Target.Arn).toBe(deps.revertTargetArn);
    const payload = JSON.parse(input.Target.Input);
    expect(payload.mode).toBe("inject");
    // detail.firedAt is bumped to the inject time so the later revert is relative to it,
    // and afterMinutes is dropped so it does not re-defer.
    expect(payload.detail.firedAt).toBe("2026-06-02T00:30:00.000Z");
    expect(payload.detail).not.toHaveProperty("afterMinutes");
    expect(payload.detail.disruptionId).toBe("ec2-latency-injection");
  });

  it("should propagate scheduler errors (inject scheduling failure is loud)", async () => {
    const { deps } = makeDeps(vi.fn().mockRejectedValue(new Error("ConflictException")));
    await expect(scheduleInject(detail, 30, deps)).rejects.toThrow("ConflictException");
  });
});

describe("scheduleRecurring", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should register a rate() schedule with EndDate, auto-delete, and a scheduled-time tick payload", async () => {
    const { deps, send } = makeDeps();
    await scheduleRecurring(detail, 5, 6, deps);
    const input = send.mock.calls[0][0].input;
    expect(input.Name).toBe(recurringScheduleName(detail));
    expect(input.ScheduleExpression).toBe("rate(5 minutes)");
    expect(input.ActionAfterCompletion).toBe("DELETE");
    // EndDate caps the run at interval×maxFires (= always-ends without a counter).
    expect(input.EndDate).toBeInstanceOf(Date);
    expect((input.EndDate as Date).toISOString()).toBe("2026-06-02T00:30:00.000Z");
    const payload = JSON.parse(input.Target.Input);
    expect(payload.mode).toBe("inject-recurring");
    // firedAt is the scheduler template so each tick claims uniquely; recurrence isn't re-sent.
    expect(payload.detail.firedAt).toBe("<aws.scheduler.scheduled-time>");
    expect(payload.detail.recurrence).toBeUndefined();
  });

  it("should propagate scheduler errors (recurring scheduling failure is loud)", async () => {
    const { deps } = makeDeps(vi.fn().mockRejectedValue(new Error("ConflictException")));
    await expect(scheduleRecurring(detail, 5, 6, deps)).rejects.toThrow("ConflictException");
  });
});
