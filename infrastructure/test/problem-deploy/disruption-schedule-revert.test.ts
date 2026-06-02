import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DisruptionDispatch } from "../../lib/problem-deploy/handlers/disruption-executor-handler/dispatch-command";
import type {
  DeploymentTarget,
  DisruptionFiredDetail,
} from "../../lib/problem-deploy/handlers/disruption-executor-handler/execute";
import {
  revertAtExpression,
  revertScheduleName,
  type ScheduleRevertDeps,
  scheduleRevert,
} from "../../lib/problem-deploy/handlers/disruption-executor-handler/schedule-revert";

/**
 * [ADR-031 / ADR-029 INV-2 / #1419] scheduleRevert: one-shot aws-scheduler 登録を mocked client で pin。
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

describe("scheduleRevert (ADR-031 #1419)", () => {
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
