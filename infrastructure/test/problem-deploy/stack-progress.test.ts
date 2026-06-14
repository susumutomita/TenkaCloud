import { describe, expect, it, vi } from "vitest";
import type { DeploySharedResources } from "../../lib/problem-deploy/handlers/deploy-handler/deploy";
import {
  buildCfnConsoleUrl,
  getStackProgress,
} from "../../lib/problem-deploy/handlers/deploy-handler/stack-progress";

const TENANT = "tenant-acme";
const JOB_ID = "01HXYZ12345678901234567890";
const STACK_NAME = "tc-hello-world-team-alpha";
const STACK_ID = `arn:aws:cloudformation:ap-northeast-1:999999999999:stack/${STACK_NAME}/uuid`;
const REGION = "ap-northeast-1";

/**
 * Phase 2.2 (Issue #459): getStackProgress は CompetitorAccounts table も Get するため、
 * GetCommand を TableName で振り分ける wrapper を使う。default は「未登録」(= verified 行
 * 無し) に倒し、cross-account を試したい test だけ override する。
 */
function buildShared(options: { verified?: boolean } = {}): {
  shared: DeploySharedResources;
  ddbSend: ReturnType<typeof vi.fn>;
} {
  const ddbSend = vi.fn();
  const wrappedSend = vi.fn(async (cmd: unknown) => {
    type GetLike = { input: { TableName?: string; Key?: { PK?: string; SK?: string } } };
    if (
      typeof cmd === "object" &&
      cmd !== null &&
      "input" in cmd &&
      (cmd as GetLike).input?.TableName === "TestCompetitorAccounts"
    ) {
      if (!options.verified) return { Item: undefined };
      const key = (cmd as GetLike).input.Key ?? {};
      const sk = String(key.SK ?? "");
      const awsAccountId = sk.replace(/^ACCOUNT#/, "");
      return {
        Item: {
          PK: key.PK,
          SK: key.SK,
          awsAccountId,
          region: "ap-northeast-1",
          competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
          verified: true,
        },
      };
    }
    return ddbSend(cmd);
  });
  const shared: DeploySharedResources = {
    tableName: "TestDeployments",
    competitorAccountsTableName: "TestCompetitorAccounts",
    env: "development",
    eventBusName: "test-bus",
    ddb: { send: wrappedSend } as unknown as DeploySharedResources["ddb"],
    events: {} as unknown as DeploySharedResources["events"],
    problemsCatalog: {},
  };
  return { shared, ddbSend };
}

const sampleRow = (over: Record<string, unknown> = {}) => ({
  jobId: JOB_ID,
  tenantId: TENANT,
  region: REGION,
  namePrefix: STACK_NAME,
  stackId: STACK_ID,
  ...over,
});

function buildCfn(events: unknown[], resources: unknown[]) {
  return {
    send: vi.fn(async (cmd: { constructor: { name: string } }) => {
      const name = cmd.constructor.name;
      if (name === "DescribeStackEventsCommand") return { StackEvents: events };
      if (name === "DescribeStackResourcesCommand") return { StackResources: resources };
      throw new Error(`unexpected CFn command: ${name}`);
    }),
  };
}

describe("buildCfnConsoleUrl", () => {
  it("should return a stackinfo deep link when stackId is present", () => {
    const url = buildCfnConsoleUrl(REGION, STACK_NAME, STACK_ID);
    expect(url).toContain("ap-northeast-1.console.aws.amazon.com/cloudformation");
    expect(url).toContain("#/stacks/stackinfo");
    expect(url).toContain(encodeURIComponent(STACK_ID));
  });

  it("should return the filteringText list URL when stackId is missing", () => {
    const url = buildCfnConsoleUrl(REGION, STACK_NAME);
    expect(url).toContain("#/stacks?filteringText=");
    expect(url).toContain(encodeURIComponent(STACK_NAME));
  });
});

describe("getStackProgress", () => {
  it("should return not_found when the row is missing in DDB", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: undefined });

    const out = await getStackProgress(
      shared,
      { cfnClient: () => buildCfn([], []) as never },
      TENANT,
      JOB_ID,
    );

    expect(out.kind).toBe("not_found");
  });

  it("should return not_found for rows whose tenantId does not match (cross-tenant leak guard)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleRow({ tenantId: "tenant-evil" }) });

    const out = await getStackProgress(
      shared,
      { cfnClient: () => buildCfn([], []) as never },
      TENANT,
      JOB_ID,
    );

    expect(out.kind).toBe("not_found");
  });

  it("should return stack_not_yet_created when namePrefix is unset", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Item: sampleRow({ namePrefix: undefined, stackId: undefined }),
    });

    const out = await getStackProgress(
      shared,
      { cfnClient: () => buildCfn([], []) as never },
      TENANT,
      JOB_ID,
    );

    expect(out.kind).toBe("stack_not_yet_created");
  });

  it("should fetch and return StackEvents and StackResources from CFn", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleRow() });

    const events = [
      {
        Timestamp: new Date("2026-05-11T10:00:01Z"),
        LogicalResourceId: STACK_NAME,
        ResourceType: "AWS::CloudFormation::Stack",
        ResourceStatus: "CREATE_IN_PROGRESS",
      },
      {
        Timestamp: new Date("2026-05-11T10:00:00Z"),
        LogicalResourceId: "MyTable",
        ResourceType: "AWS::DynamoDB::Table",
        ResourceStatus: "CREATE_COMPLETE",
      },
    ];
    const resources = [
      {
        LogicalResourceId: "BBB",
        ResourceType: "AWS::EC2::Instance",
        ResourceStatus: "CREATE_IN_PROGRESS",
        PhysicalResourceId: "i-abc",
      },
      {
        LogicalResourceId: "AAA",
        ResourceType: "AWS::IAM::Role",
        ResourceStatus: "CREATE_COMPLETE",
        PhysicalResourceId: "role-abc",
      },
    ];

    const out = await getStackProgress(
      shared,
      { cfnClient: () => buildCfn(events, resources) as never },
      TENANT,
      JOB_ID,
    );

    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.progress.events).toHaveLength(2);
    expect(out.progress.events[0]?.timestamp).toBe("2026-05-11T10:00:01.000Z");
    expect(out.progress.events[0]?.resourceStatus).toBe("CREATE_IN_PROGRESS");
    // resources は logicalId 昇順
    expect(out.progress.resources.map((r) => r.logicalResourceId)).toEqual(["AAA", "BBB"]);
    // stack-level event から stackStatus を抽出
    expect(out.progress.stackStatus).toBe("CREATE_IN_PROGRESS");
    expect(out.progress.consoleUrl).toContain("ap-northeast-1.console.aws.amazon.com");
    expect(out.progress.consoleUrl).toContain("#/stacks/stackinfo");
  });

  it("#1810 sibling: should query CFn with namePrefix when stackId is an empty string (FAILED deploy)", async () => {
    // FAILED deployment は stack ARN 記録前に終わると stackId="" (空文字、null ではない)。
    // `item.stackId ?? namePrefix` は空文字を fallback しないので StackName="" で CFn を引き、
    // DescribeStackEvents が失敗する → 失敗 deploy の進捗を一切引けなくなる。`||` で namePrefix
    // に倒し、stackId が空でも実 stack 名で events/resources を引けることを固定する。
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleRow({ status: "FAILED", stackId: "" }) });

    const seenStackNames: Array<string | undefined> = [];
    const cfn = {
      send: vi.fn(
        async (cmd: { constructor: { name: string }; input?: { StackName?: string } }) => {
          seenStackNames.push(cmd.input?.StackName);
          const name = cmd.constructor.name;
          if (name === "DescribeStackEventsCommand") return { StackEvents: [] };
          if (name === "DescribeStackResourcesCommand") return { StackResources: [] };
          throw new Error(`unexpected CFn command: ${name}`);
        },
      ),
    };

    const out = await getStackProgress(shared, { cfnClient: () => cfn as never }, TENANT, JOB_ID);

    expect(out.kind).toBe("ok");
    // 空文字 stackId は namePrefix に倒れ、CFn は実 stack 名で引かれる ("" では引かない)。
    expect(seenStackNames.length).toBeGreaterThan(0);
    expect(seenStackNames).not.toContain("");
    expect(seenStackNames.every((n) => n === STACK_NAME)).toBe(true);
  });

  it("should return stuck cause and recovery hint when IN_PROGRESS is frozen past the threshold", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Item: sampleRow({
        status: "IN_PROGRESS",
        updatedAt: "2026-05-11T10:00:00.000Z",
      }),
    });

    const events = [
      {
        Timestamp: new Date("2026-05-11T10:00:00Z"),
        LogicalResourceId: STACK_NAME,
        ResourceType: "AWS::CloudFormation::Stack",
        ResourceStatus: "CREATE_IN_PROGRESS",
      },
      {
        Timestamp: new Date("2026-05-11T09:59:30Z"),
        LogicalResourceId: "WebServer",
        ResourceType: "AWS::EC2::Instance",
        ResourceStatus: "CREATE_IN_PROGRESS",
        ResourceStatusReason: "Resource handler returned message: service quota exceeded",
      },
    ];

    const out = await getStackProgress(
      shared,
      {
        cfnClient: () => buildCfn(events, []) as never,
        now: () => new Date("2026-05-11T10:45:00Z"),
      },
      TENANT,
      JOB_ID,
    );

    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.progress.stuck?.isStuck).toBe(true);
    expect(out.progress.stuck?.elapsedMinutes).toBe(45);
    expect(out.progress.stuck?.resourceLogicalId).toBe("WebServer");
    expect(out.progress.stuck?.reason).toContain("service quota exceeded");
    expect(out.progress.stuck?.remediationHint).toContain("service quota");
  });

  it("should not classify as stuck when IN_PROGRESS but recent events are fresh", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Item: sampleRow({
        status: "IN_PROGRESS",
        updatedAt: "2026-05-11T10:00:00.000Z",
      }),
    });

    const events = [
      {
        Timestamp: new Date("2026-05-11T10:40:00Z"),
        LogicalResourceId: STACK_NAME,
        ResourceType: "AWS::CloudFormation::Stack",
        ResourceStatus: "CREATE_IN_PROGRESS",
      },
    ];

    const out = await getStackProgress(
      shared,
      {
        cfnClient: () => buildCfn(events, []) as never,
        now: () => new Date("2026-05-11T10:45:00Z"),
      },
      TENANT,
      JOB_ID,
    );

    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.progress.stuck).toBeUndefined();
  });

  it("should truncate events to the latest 20", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleRow() });

    const events = Array.from({ length: 50 }, (_, i) => ({
      Timestamp: new Date(`2026-05-11T10:${String(i).padStart(2, "0")}:00Z`),
      LogicalResourceId: `R${i}`,
      ResourceType: "AWS::IAM::Role",
      ResourceStatus: "CREATE_COMPLETE",
    }));

    const out = await getStackProgress(
      shared,
      { cfnClient: () => buildCfn(events, []) as never },
      TENANT,
      JOB_ID,
    );

    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.progress.events).toHaveLength(20);
  });

  it("should map ValidationError(does not exist) from CFn to stack_not_found_in_cfn", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleRow() });

    const cfn = {
      send: vi.fn(async () => {
        const err = new Error("Stack with id tc-x-y does not exist");
        (err as { name: string }).name = "ValidationError";
        throw err;
      }),
    };

    const out = await getStackProgress(shared, { cfnClient: () => cfn as never }, TENANT, JOB_ID);

    expect(out.kind).toBe("stack_not_found_in_cfn");
    if (out.kind !== "stack_not_found_in_cfn") return;
    expect(out.consoleUrl).toContain("cloudformation");
  });

  it("should throw other CFn errors and let the caller return 500", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleRow() });

    const cfn = {
      send: vi.fn(async () => {
        throw new Error("Throttling");
      }),
    };

    await expect(
      getStackProgress(shared, { cfnClient: () => cfn as never }, TENANT, JOB_ID),
    ).rejects.toThrow("Throttling");
  });

  it("should pass stackId to the CFn call once stackId is finalized (prevent same-name recreation accidents)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleRow() });
    const cfn = buildCfn([], []);

    await getStackProgress(shared, { cfnClient: () => cfn as never }, TENANT, JOB_ID);

    const events = cfn.send.mock.calls[0]?.[0] as { input: { StackName?: string } };
    expect(events.input.StackName).toBe(STACK_ID);
  });

  it("should use namePrefix as the CFn argument when stackId is unassigned", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleRow({ stackId: undefined }) });
    const cfn = buildCfn([], []);

    await getStackProgress(shared, { cfnClient: () => cfn as never }, TENANT, JOB_ID);

    const events = cfn.send.mock.calls[0]?.[0] as { input: { StackName?: string } };
    expect(events.input.StackName).toBe(STACK_NAME);
  });
});
