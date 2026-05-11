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

function buildShared(): {
  shared: DeploySharedResources;
  ddbSend: ReturnType<typeof vi.fn>;
} {
  const ddbSend = vi.fn();
  const shared: DeploySharedResources = {
    tableName: "TestDeployments",
    eventBusName: "test-bus",
    ddb: { send: ddbSend } as unknown as DeploySharedResources["ddb"],
    events: {} as unknown as DeploySharedResources["events"],
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
  it("stackId があれば stackinfo deep link を返すべき", () => {
    const url = buildCfnConsoleUrl(REGION, STACK_NAME, STACK_ID);
    expect(url).toContain("ap-northeast-1.console.aws.amazon.com/cloudformation");
    expect(url).toContain("#/stacks/stackinfo");
    expect(url).toContain(encodeURIComponent(STACK_ID));
  });

  it("stackId が無ければ filteringText 経由の一覧 URL を返すべき", () => {
    const url = buildCfnConsoleUrl(REGION, STACK_NAME);
    expect(url).toContain("#/stacks?filteringText=");
    expect(url).toContain(encodeURIComponent(STACK_NAME));
  });
});

describe("getStackProgress", () => {
  it("DDB に行が無ければ not_found を返すべき", async () => {
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

  it("tenantId が一致しない行は not_found を返すべき (クロステナント漏洩防止)", async () => {
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

  it("namePrefix が未設定なら stack_not_yet_created を返すべき", async () => {
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

  it("CFn から StackEvents と StackResources を取得して返すべき", async () => {
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

  it("最新 20 件に events を切り詰めるべき", async () => {
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

  it("CFn が ValidationError(does not exist) を返したら stack_not_found_in_cfn にすべき", async () => {
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

  it("その他の CFn エラーは throw して呼び出し側で 500 を返させるべき", async () => {
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

  it("stackId が確定済なら CFn 呼び出しに stackId を渡すべき (同名再作成事故防止)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleRow() });
    const cfn = buildCfn([], []);

    await getStackProgress(shared, { cfnClient: () => cfn as never }, TENANT, JOB_ID);

    const events = cfn.send.mock.calls[0]?.[0] as { input: { StackName?: string } };
    expect(events.input.StackName).toBe(STACK_ID);
  });

  it("stackId 未割当なら namePrefix を CFn 引数に使うべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleRow({ stackId: undefined }) });
    const cfn = buildCfn([], []);

    await getStackProgress(shared, { cfnClient: () => cfn as never }, TENANT, JOB_ID);

    const events = cfn.send.mock.calls[0]?.[0] as { input: { StackName?: string } };
    expect(events.input.StackName).toBe(STACK_NAME);
  });
});
