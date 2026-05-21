import { describe, expect, it } from "vitest";
import type { DeploymentSummary, StackProgress } from "../../src/api/deploy-client";
import {
  buildTerminalLog,
  type DeployPhase,
  deploySummaryTitle,
  derivePhases,
  type PhaseId,
} from "../../src/lib/deploy-phases";

function pick(phases: readonly DeployPhase[], id: PhaseId): DeployPhase {
  const found = phases.find((p) => p.id === id);
  if (!found) throw new Error(`phase ${id} not found`);
  return found;
}

const baseDeployment: DeploymentSummary = {
  jobId: "01HZX0K3M3K9ZQHB3MRQHBA1B2",
  problemId: "hello-world-battle",
  tenantId: "tenant-test",
  awsAccountId: "111122223333",
  region: "ap-northeast-1",
  teamName: "team-alpha",
  displayTeamName: "Alpha Team",
  namePrefix: "tc-team-alpha",
  status: "PENDING",
  createdAt: "2026-05-11T01:08:58.000Z",
  updatedAt: "2026-05-11T01:09:30.000Z",
  expiresAt: 0,
};

const emptyProgress: StackProgress = {
  jobId: baseDeployment.jobId,
  stackName: "tc-team-alpha-stack",
  region: "ap-northeast-1",
  consoleUrl: "https://console.aws.amazon.com/cloudformation/home?region=ap-northeast-1#/stacks",
  events: [],
  resources: [],
};

const progressWithCreateInProgress: StackProgress = {
  ...emptyProgress,
  events: [
    {
      timestamp: "2026-05-11T01:09:00.000Z",
      logicalResourceId: "MyBucket",
      resourceType: "AWS::S3::Bucket",
      resourceStatus: "CREATE_IN_PROGRESS",
    },
  ],
};

const progressAllComplete: StackProgress = {
  ...emptyProgress,
  events: [
    {
      timestamp: "2026-05-11T01:09:00.000Z",
      logicalResourceId: "MyBucket",
      resourceType: "AWS::S3::Bucket",
      resourceStatus: "CREATE_COMPLETE",
    },
    {
      timestamp: "2026-05-11T01:09:10.000Z",
      logicalResourceId: "MyStack",
      resourceType: "AWS::CloudFormation::Stack",
      resourceStatus: "CREATE_COMPLETE",
    },
  ],
};

const progressWithFailed: StackProgress = {
  ...emptyProgress,
  events: [
    {
      timestamp: "2026-05-11T01:09:00.000Z",
      logicalResourceId: "MyBucket",
      resourceType: "AWS::S3::Bucket",
      resourceStatus: "CREATE_IN_PROGRESS",
    },
    {
      timestamp: "2026-05-11T01:09:30.000Z",
      logicalResourceId: "MyBucket",
      resourceType: "AWS::S3::Bucket",
      resourceStatus: "CREATE_FAILED",
      resourceStatusReason: "Bucket name already exists",
    },
  ],
};

describe("derivePhases", () => {
  it("should show all 5 phases as Complete (or Skipped) when status=COMPLETE", () => {
    const phases = derivePhases({ ...baseDeployment, status: "COMPLETE" }, progressAllComplete);
    expect(phases.map((p) => p.id)).toEqual([
      "enqueued",
      "building",
      "cfn-deploy",
      "health-check",
      "complete",
    ]);
    expect(phases[0].status).toBe("complete"); // Enqueued
    expect(phases[1].status).toBe("complete"); // Building
    expect(phases[2].status).toBe("complete"); // CFn Deploy
    expect(phases[3].status).toBe("skipped"); // Health Check (placeholder)
    expect(phases[4].status).toBe("complete"); // Final
  });

  it("should show CloudFormation Deploy phase as Failed when status=FAILED with CFn progress", () => {
    const phases = derivePhases({ ...baseDeployment, status: "FAILED" }, progressWithFailed);
    expect(pick(phases, "building").status).toBe("complete"); // CFn 観測あり → Build は通った
    expect(pick(phases, "cfn-deploy").status).toBe("failed");
    expect(pick(phases, "complete").status).toBe("failed");
  });

  it("should show Building phase as Failed when status=FAILED with no CFn observed", () => {
    const phases = derivePhases({ ...baseDeployment, status: "FAILED" }, emptyProgress);
    expect(pick(phases, "building").status).toBe("failed");
    expect(pick(phases, "cfn-deploy").status).toBe("pending");
  });

  it("should show the relevant phase as In Progress when status=IN_PROGRESS with CFn in progress", () => {
    const phases = derivePhases(
      { ...baseDeployment, status: "IN_PROGRESS" },
      progressWithCreateInProgress,
    );
    expect(pick(phases, "building").status).toBe("complete"); // events 観測 → build 通った
    expect(pick(phases, "cfn-deploy").status).toBe("in-progress");
  });

  it("should show CloudFormation Deploy phase as Pending when stackEvents is empty and status=IN_PROGRESS", () => {
    const phases = derivePhases({ ...baseDeployment, status: "IN_PROGRESS" }, emptyProgress);
    expect(pick(phases, "cfn-deploy").status).toBe("pending");
  });

  it("should still generate 5 phases when stackProgress=null", () => {
    const phases = derivePhases({ ...baseDeployment, status: "PENDING" }, null);
    expect(phases).toHaveLength(5);
    expect(phases[1].status).toBe("pending"); // building pending
    expect(phases[2].status).toBe("pending"); // cfn pending
  });

  it("should show Final phase as Skipped when status=DELETED", () => {
    const phases = derivePhases({ ...baseDeployment, status: "DELETED" }, progressAllComplete);
    expect(pick(phases, "complete").status).toBe("skipped");
  });

  it("should display as auto-delete lifecycle when status=EXPIRED / AUTO_DELETED", () => {
    const expired = derivePhases({ ...baseDeployment, status: "EXPIRED" }, emptyProgress);
    expect(pick(expired, "cfn-deploy").status).toBe("skipped");
    expect(pick(expired, "complete").status).toBe("failed");

    const autoDeleted = derivePhases({ ...baseDeployment, status: "AUTO_DELETED" }, emptyProgress);
    expect(pick(autoDeleted, "cfn-deploy").status).toBe("skipped");
    expect(pick(autoDeleted, "complete").status).toBe("skipped");
  });

  // #818 regression: past CREATE_IN_PROGRESS event が history に残っていても、
  // stack 自体は CREATE_COMPLETE に到達しているなら cfn-deploy phase は complete。
  it("should mark complete even when past IN_PROGRESS events remain, if stackStatus=CREATE_COMPLETE (#818)", () => {
    const stuck: StackProgress = {
      ...emptyProgress,
      stackStatus: "CREATE_COMPLETE",
      events: [
        {
          timestamp: "2026-05-11T01:09:00.000Z",
          logicalResourceId: "MyBucket",
          resourceType: "AWS::S3::Bucket",
          resourceStatus: "CREATE_IN_PROGRESS",
        },
        {
          timestamp: "2026-05-11T01:09:10.000Z",
          logicalResourceId: "MyBucket",
          resourceType: "AWS::S3::Bucket",
          resourceStatus: "CREATE_COMPLETE",
        },
      ],
    };
    const phases = derivePhases({ ...baseDeployment, status: "COMPLETE" }, stuck);
    expect(pick(phases, "cfn-deploy").status).toBe("complete");
  });

  it("should return complete by looking at latest event per LogicalId even when stackStatus is missing (#818)", () => {
    // stackStatus 取得失敗の fallback path。 同 LogicalId に IN_PROGRESS と
    // COMPLETE 両方あるとき、 最新 (= COMPLETE) を採用する。
    const fallback: StackProgress = {
      ...emptyProgress,
      events: [
        {
          timestamp: "2026-05-11T01:09:00.000Z",
          logicalResourceId: "MyBucket",
          resourceType: "AWS::S3::Bucket",
          resourceStatus: "CREATE_IN_PROGRESS",
        },
        {
          timestamp: "2026-05-11T01:09:10.000Z",
          logicalResourceId: "MyBucket",
          resourceType: "AWS::S3::Bucket",
          resourceStatus: "CREATE_COMPLETE",
        },
      ],
    };
    const phases = derivePhases({ ...baseDeployment, status: "COMPLETE" }, fallback);
    expect(pick(phases, "cfn-deploy").status).toBe("complete");
  });

  it("should mark stackStatus=ROLLBACK_COMPLETE as failed (#818)", () => {
    const rolledBack: StackProgress = {
      ...emptyProgress,
      stackStatus: "ROLLBACK_COMPLETE",
      events: [],
    };
    const phases = derivePhases({ ...baseDeployment, status: "FAILED" }, rolledBack);
    expect(pick(phases, "cfn-deploy").status).toBe("failed");
  });

  it("should mark stackStatus=CREATE_IN_PROGRESS as in-progress (#818)", () => {
    const inProgress: StackProgress = {
      ...emptyProgress,
      stackStatus: "CREATE_IN_PROGRESS",
      events: progressWithCreateInProgress.events,
    };
    const phases = derivePhases({ ...baseDeployment, status: "IN_PROGRESS" }, inProgress);
    expect(pick(phases, "cfn-deploy").status).toBe("in-progress");
  });
});

describe("deploySummaryTitle", () => {
  it("should include succeeded when status=COMPLETE", () => {
    expect(deploySummaryTitle({ ...baseDeployment, status: "COMPLETE" })).toMatch(/succeeded/);
  });
  it("should include failed when status=FAILED", () => {
    expect(deploySummaryTitle({ ...baseDeployment, status: "FAILED" })).toMatch(/failed/);
  });

  it("should include lifecycle label when status=EXPIRED / AUTO_DELETED", () => {
    expect(deploySummaryTitle({ ...baseDeployment, status: "EXPIRED" })).toMatch(/expired/);
    expect(deploySummaryTitle({ ...baseDeployment, status: "AUTO_DELETED" })).toMatch(
      /auto-deleted/,
    );
  });
});

describe("buildTerminalLog", () => {
  it("should emit header lines and event lines per phase", () => {
    const phases = derivePhases({ ...baseDeployment, status: "COMPLETE" }, progressAllComplete);
    const lines = buildTerminalLog(
      { ...baseDeployment, status: "COMPLETE" },
      progressAllComplete,
      phases,
    );
    const headers = lines.filter((l) => l.header).map((l) => l.text);
    expect(headers).toEqual([
      "> Enqueued [complete]",
      "> Building [complete]",
      "> CloudFormation Deploy [complete]",
      "> Health Check [skipped]",
      "> Complete / Teardown [complete]",
    ]);
    // CFn event lines should include logicalResourceId.
    expect(lines.some((l) => l.text.includes("MyBucket"))).toBe(true);
  });

  it("should show CodeBuild console link inside Building phase when consoleUrl is present", () => {
    const phases = derivePhases(
      { ...baseDeployment, status: "IN_PROGRESS" },
      progressWithCreateInProgress,
    );
    const lines = buildTerminalLog(
      { ...baseDeployment, status: "IN_PROGRESS" },
      progressWithCreateInProgress,
      phases,
    );
    expect(lines.some((l) => l.text.includes("CodeBuild console:"))).toBe(true);
  });
});
