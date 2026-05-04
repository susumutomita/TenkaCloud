import { DeleteStackCommand, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import type { PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  runStatusUpdate,
  type UpdaterSharedResources,
} from "../../lib/problem-deploy/handlers/status-updater/updater";

const FIXED_NOW_MS = 1_700_000_000_000;

function buildShared(rows: Record<string, unknown>[]): {
  shared: UpdaterSharedResources;
  ddbSend: ReturnType<typeof vi.fn>;
  eventsSend: ReturnType<typeof vi.fn>;
  stsSend: ReturnType<typeof vi.fn>;
  cfnSend: ReturnType<typeof vi.fn>;
} {
  const ddbSend = vi.fn().mockImplementation(async (cmd) => {
    if (cmd instanceof ScanCommand) return { Items: rows, LastEvaluatedKey: undefined };
    return {};
  });
  const eventsSend = vi.fn().mockResolvedValue({});
  const stsSend = vi.fn().mockResolvedValue({
    Credentials: { AccessKeyId: "AKIA", SecretAccessKey: "S", SessionToken: "T" },
  });
  const cfnSend = vi.fn();
  const shared: UpdaterSharedResources = {
    tableName: "TestDeployments",
    eventBusName: "test-bus",
    competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
    externalId: "ext",
    ddb: { send: ddbSend } as unknown as UpdaterSharedResources["ddb"],
    events: { send: eventsSend } as unknown as UpdaterSharedResources["events"],
    sts: { send: stsSend } as unknown as UpdaterSharedResources["sts"],
    cfnFactory: () =>
      ({ send: cfnSend }) as unknown as ReturnType<UpdaterSharedResources["cfnFactory"]>,
    now: () => FIXED_NOW_MS,
  };
  return { shared, ddbSend, eventsSend, stsSend, cfnSend };
}

const sampleRow = (over: Record<string, unknown> = {}) => ({
  PK: "DEPLOYMENT#JOB1",
  SK: "META",
  jobId: "JOB1",
  tenantId: "tenant-acme",
  problemId: "security-battle-royale",
  awsAccountId: "999999999999",
  region: "ap-northeast-1",
  namePrefix: "tc-security-battle-royale-alpha-team",
  stackId: "arn:aws:cloudformation:ap-northeast-1:999999999999:stack/tc-/uuid",
  status: "IN_PROGRESS",
  expiresAt: Math.floor(FIXED_NOW_MS / 1000) + 3600,
  ...over,
});

describe("runStatusUpdate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("CFn が CREATE_COMPLETE になったら DDB を COMPLETE に更新し DeployCompleted を publish するべき", async () => {
    const row = sampleRow();
    const { shared, ddbSend, eventsSend, cfnSend } = buildShared([row]);
    cfnSend.mockResolvedValueOnce({
      Stacks: [
        {
          StackStatus: "CREATE_COMPLETE",
          Outputs: [{ OutputKey: "FrontendUrl", OutputValue: "http://x" }],
        },
      ],
    });

    await runStatusUpdate(shared);

    // DescribeStacks 呼ばれた
    expect(cfnSend).toHaveBeenCalledOnce();
    expect(cfnSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeStacksCommand);

    // DDB Update (transition)
    const updateCalls = ddbSend.mock.calls.filter((c) => c[0] instanceof UpdateCommand);
    expect(updateCalls).toHaveLength(1);
    const updateCmd = updateCalls[0][0] as UpdateCommand;
    expect(updateCmd.input.ExpressionAttributeValues?.[":next"]).toBe("COMPLETE");
    expect(updateCmd.input.ExpressionAttributeValues?.[":outputs"]).toContain("FrontendUrl");
    // ConditionExpression で current = ":current" を要求
    expect(updateCmd.input.ConditionExpression).toContain(":current");

    // Event publish
    expect(eventsSend).toHaveBeenCalledOnce();
    const evt = eventsSend.mock.calls[0]?.[0] as PutEventsCommand;
    expect(evt.input.Entries?.[0].DetailType).toBe("DeployCompleted");
  });

  it("CFn が ROLLBACK_COMPLETE なら FAILED + DeployFailed publish", async () => {
    const { shared, ddbSend, eventsSend, cfnSend } = buildShared([sampleRow()]);
    cfnSend.mockResolvedValueOnce({
      Stacks: [{ StackStatus: "ROLLBACK_COMPLETE", StackStatusReason: "VPC limit" }],
    });

    await runStatusUpdate(shared);

    const updateCmd = ddbSend.mock.calls.find((c) => c[0] instanceof UpdateCommand)?.[0] as
      | UpdateCommand
      | undefined;
    expect(updateCmd?.input.ExpressionAttributeValues?.[":next"]).toBe("FAILED");
    expect(updateCmd?.input.ExpressionAttributeValues?.[":reason"]).toContain("ROLLBACK_COMPLETE");

    expect((eventsSend.mock.calls[0]?.[0] as PutEventsCommand).input.Entries?.[0].DetailType).toBe(
      "DeployFailed",
    );
  });

  it("CFn が CREATE_IN_PROGRESS なら DDB Update も Event publish もしないべき", async () => {
    const { shared, ddbSend, eventsSend, cfnSend } = buildShared([sampleRow()]);
    cfnSend.mockResolvedValueOnce({
      Stacks: [{ StackStatus: "CREATE_IN_PROGRESS" }],
    });

    await runStatusUpdate(shared);

    const updateCalls = ddbSend.mock.calls.filter((c) => c[0] instanceof UpdateCommand);
    expect(updateCalls).toHaveLength(0);
    expect(eventsSend).not.toHaveBeenCalled();
  });

  it("expiresAt < now() で stackId 持ち IN_PROGRESS なら DeleteStack + DELETING に遷移するべき", async () => {
    const row = sampleRow({ expiresAt: Math.floor(FIXED_NOW_MS / 1000) - 60 });
    const { shared, ddbSend, eventsSend, cfnSend } = buildShared([row]);
    cfnSend.mockResolvedValueOnce({}); // DeleteStack

    await runStatusUpdate(shared);

    expect(cfnSend).toHaveBeenCalledOnce();
    expect(cfnSend.mock.calls[0]?.[0]).toBeInstanceOf(DeleteStackCommand);

    const updateCmd = ddbSend.mock.calls.find((c) => c[0] instanceof UpdateCommand)?.[0] as
      | UpdateCommand
      | undefined;
    expect(updateCmd?.input.ExpressionAttributeValues?.[":next"]).toBe("DELETING");
    // teardown 直後は publish しない (DELETING は intermediate state)
    expect(eventsSend).not.toHaveBeenCalled();
  });

  it("stackId が無い行はスキップする (Worker がまだ CFn を作っていない)", async () => {
    const row = sampleRow({ stackId: undefined });
    const { shared, cfnSend, ddbSend, eventsSend } = buildShared([row]);

    await runStatusUpdate(shared);

    expect(cfnSend).not.toHaveBeenCalled();
    const updateCalls = ddbSend.mock.calls.filter((c) => c[0] instanceof UpdateCommand);
    expect(updateCalls).toHaveLength(0);
    expect(eventsSend).not.toHaveBeenCalled();
  });

  it("DELETING 中の行が DELETE_COMPLETE になったら DELETED + DeployDeleted publish", async () => {
    const row = sampleRow({ status: "DELETING" });
    const { shared, ddbSend, eventsSend, cfnSend } = buildShared([row]);
    cfnSend.mockResolvedValueOnce({ Stacks: [{ StackStatus: "DELETE_COMPLETE" }] });

    await runStatusUpdate(shared);

    const updateCmd = ddbSend.mock.calls.find((c) => c[0] instanceof UpdateCommand)?.[0] as
      | UpdateCommand
      | undefined;
    expect(updateCmd?.input.ExpressionAttributeValues?.[":next"]).toBe("DELETED");
    expect((eventsSend.mock.calls[0]?.[0] as PutEventsCommand).input.Entries?.[0].DetailType).toBe(
      "DeployDeleted",
    );
  });

  it("AssumeRole 失敗時は他の row 処理を continue する", async () => {
    const row = sampleRow();
    const { shared, ddbSend, stsSend } = buildShared([row]);
    stsSend.mockRejectedValueOnce(new Error("AccessDenied"));

    await expect(runStatusUpdate(shared)).resolves.toBeUndefined();
    const updateCalls = ddbSend.mock.calls.filter((c) => c[0] instanceof UpdateCommand);
    expect(updateCalls).toHaveLength(0); // 状態変えない
  });

  it("ConditionalCheckFailedException は silently swallow すべき (race の let-win)", async () => {
    const row = sampleRow();
    const { shared, ddbSend, eventsSend, cfnSend } = buildShared([row]);
    cfnSend.mockResolvedValueOnce({ Stacks: [{ StackStatus: "CREATE_COMPLETE", Outputs: [] }] });
    // Update が ConditionalCheckFailed を投げる
    ddbSend.mockImplementationOnce(async (cmd) => {
      if (cmd instanceof ScanCommand) return { Items: [row], LastEvaluatedKey: undefined };
      return {};
    });
    ddbSend.mockImplementationOnce(async (cmd) => {
      if (cmd instanceof UpdateCommand) {
        const err: Error & { name?: string } = new Error("conditional check failed");
        err.name = "ConditionalCheckFailedException";
        throw err;
      }
      return {};
    });

    await runStatusUpdate(shared);

    // race で先に書かれたので publish しない
    expect(eventsSend).not.toHaveBeenCalled();
  });

  it("ScanCommand の filter は PENDING / IN_PROGRESS / DELETING に絞るべき", async () => {
    const { shared, ddbSend } = buildShared([]);
    await runStatusUpdate(shared);
    const scanCmd = ddbSend.mock.calls[0]?.[0] as ScanCommand;
    expect(scanCmd).toBeInstanceOf(ScanCommand);
    expect(scanCmd.input.FilterExpression).toContain(":pending");
    expect(scanCmd.input.FilterExpression).toContain(":inProgress");
    expect(scanCmd.input.FilterExpression).toContain(":deleting");
  });
});
