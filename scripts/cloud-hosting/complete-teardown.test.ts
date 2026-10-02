import { describe, expect, it } from "bun:test";
import { cloudStackTags } from "../../infrastructure/lib/cloud-hosting/stack-names";
import {
  discoverTeardownPlan,
  parseStackOwnedCleanupResources,
  purgeStackOwnedLogGroups,
  purgeStackOwnedResources,
  showTeardownPlan,
} from "./complete-teardown";
import type { ProcessResult } from "./process";

const account = "123456789012";
const region = "ap-northeast-1";
const stackArn = `arn:aws:cloudformation:${region}:${account}:stack/owned/stack-id`;
const tableArn = `arn:aws:dynamodb:${region}:${account}:table/owned-events`;
const resources = [
  {
    LogicalResourceId: "Events",
    PhysicalResourceId: "owned-events",
    ResourceType: "AWS::DynamoDB::Table",
    ResourceStatus: "CREATE_COMPLETE",
  },
  {
    LogicalResourceId: "Lambda",
    PhysicalResourceId: "owned-worker",
    ResourceType: "AWS::Lambda::Function",
    ResourceStatus: "CREATE_COMPLETE",
  },
  {
    LogicalResourceId: "Build",
    PhysicalResourceId: "owned-build",
    ResourceType: "AWS::CodeBuild::Project",
    ResourceStatus: "CREATE_COMPLETE",
  },
  {
    LogicalResourceId: "Logs",
    PhysicalResourceId: "/owned/explicit",
    ResourceType: "AWS::Logs::LogGroup",
    ResourceStatus: "CREATE_COMPLETE",
  },
  {
    LogicalResourceId: "Bucket",
    PhysicalResourceId: "owned-assets",
    ResourceType: "AWS::S3::Bucket",
    ResourceStatus: "CREATE_COMPLETE",
  },
  {
    LogicalResourceId: "UserPool",
    PhysicalResourceId: "ap-northeast-1_owned",
    ResourceType: "AWS::Cognito::UserPool",
    ResourceStatus: "CREATE_COMPLETE",
  },
];
function fixture(
  overrides: {
    protected?: boolean;
    inventory?: unknown;
    deletionPolicy?: (logicalId: string) => string | undefined;
    fail?: (args: readonly string[]) => ProcessResult | undefined;
  } = {},
) {
  const calls: readonly string[][] = [];
  const mutableCalls: string[][] = calls as string[][];
  const run = async (args: readonly string[]): Promise<ProcessResult> => {
    mutableCalls.push([...args]);
    const result = overrides.fail?.(args);
    if (result) return result;
    let value: unknown = {};
    if (args.includes("get-template"))
      value = {
        TemplateBody: {
          Resources: Object.fromEntries(
            resources.map((item) => [
              item.LogicalResourceId,
              {
                Type: item.ResourceType,
                DeletionPolicy: overrides.deletionPolicy
                  ? overrides.deletionPolicy(item.LogicalResourceId)
                  : "Retain",
              },
            ]),
          ),
        },
      };
    if (args.includes("list-stack-resources"))
      value = { StackResourceSummaries: overrides.inventory ?? resources };
    if (args.includes("describe-table"))
      value = {
        Table: {
          TableArn: tableArn,
          TableName: "owned-events",
          TableStatus: "ACTIVE",
          DeletionProtectionEnabled: overrides.protected ?? false,
        },
      };
    if (args.includes("list-tags-of-resource"))
      value = {
        Tags: Object.entries(cloudStackTags("test")).map(([Key, Value]) => ({ Key, Value })),
      };
    return { code: 0, stdout: JSON.stringify(value), stderr: "" };
  };
  return {
    calls,
    run,
    discover: () =>
      discoverTeardownPlan({
        account,
        region,
        environment: "test",
        stacks: [{ name: "owned", arn: stackArn, outputs: {}, status: "CREATE_FAILED" }],
        run,
      }),
  };
}
describe("baseline exact stack-owned purge", () => {
  it("matches original physical table/default log/explicit log scope without adopting other resources", () => {
    expect(
      parseStackOwnedCleanupResources(JSON.stringify({ StackResourceSummaries: resources })),
    ).toEqual({
      tableNames: ["owned-events"],
      logGroupNames: ["/aws/lambda/owned-worker", "/aws/codebuild/owned-build", "/owned/explicit"],
    });
  });
  it("builds a read-only ARN/tag/protection/retention plan without outputs or table scans", async () => {
    const f = fixture({ protected: true });
    const plan = await f.discover();
    expect(plan.tables).toEqual([
      { name: "owned-events", arn: tableArn, stackArn, retention: "Retain", protected: true },
    ]);
    expect(f.calls.every((args) => args.includes("--region") && args.includes(region))).toBe(true);
    expect(
      f.calls.some(
        (args) =>
          args.includes("scan") || args.includes("update-table") || args.includes("delete-table"),
      ),
    ).toBe(false);
  });
  it("refuses protected tables before any purge and never silently disables protection", async () => {
    const f = fixture({ protected: true });
    const plan = await f.discover();
    const before = f.calls.length;
    await expect(purgeStackOwnedResources(plan, f.run)).rejects.toThrow(
      "Purge stopped before mutation",
    );
    expect(f.calls.length).toBe(before);
  });
  it("prints exact retained S3 and Cognito identities from the existing CFN reads", async () => {
    const f = fixture();
    const plan = await f.discover();
    const output: string[] = [];
    showTeardownPlan(plan, (text) => output.push(text));
    const printed = JSON.parse(output[0]?.slice(output[0].indexOf("\n") + 1) ?? "{}") as {
      retainedResources: unknown[];
    };
    expect(printed.retainedResources).toContainEqual({
      logicalId: "Bucket",
      physicalId: "owned-assets",
      resourceType: "AWS::S3::Bucket",
      stackArn,
      deletionPolicy: "Retain",
    });
    expect(printed.retainedResources).toContainEqual({
      logicalId: "UserPool",
      physicalId: "ap-northeast-1_owned",
      resourceType: "AWS::Cognito::UserPool",
      stackArn,
      deletionPolicy: "Retain",
    });
    expect(f.calls.map((args) => args.slice(0, 2))).toEqual([
      ["cloudformation", "get-template"],
      ["cloudformation", "list-stack-resources"],
      ["dynamodb", "describe-table"],
      ["dynamodb", "list-tags-of-resource"],
    ]);
  });
  it("records RetainExceptOnCreate without claiming default Delete resources are retained", async () => {
    const f = fixture({
      deletionPolicy: (id) => (id === "UserPool" ? "RetainExceptOnCreate" : undefined),
    });
    expect((await f.discover()).retainedResources).toEqual([
      {
        logicalId: "UserPool",
        physicalId: "ap-northeast-1_owned",
        resourceType: "AWS::Cognito::UserPool",
        stackArn,
        deletionPolicy: "RetainExceptOnCreate",
      },
    ]);
  });
  it("purges tables and waits before deleting exact logs, without scanning accounts", async () => {
    const f = fixture();
    const plan = await f.discover();
    const before = f.calls.length;
    await purgeStackOwnedResources(plan, f.run);
    expect(f.calls.slice(before).map((args) => args.slice(0, 2))).toEqual([
      ["dynamodb", "delete-table"],
      ["dynamodb", "wait"],
      ["logs", "delete-log-group"],
      ["logs", "delete-log-group"],
      ["logs", "delete-log-group"],
    ]);
    expect(
      f.calls.some((args) => args.includes("list-tables") || args.includes("CDKToolkit")),
    ).toBe(false);
    expect(
      f.calls
        .slice(before)
        .some((args) => args.includes("owned-assets") || args.includes("ap-northeast-1_owned")),
    ).toBe(false);
  });
  it("idempotently repeats only captured logs when deleted log groups are already absent", async () => {
    const f = fixture({
      fail: (args) =>
        args.includes("delete-log-group")
          ? { code: 1, stdout: "", stderr: "(ResourceNotFoundException) Log group is absent" }
          : undefined,
    });
    const plan = await f.discover();
    const before = f.calls.length;
    await purgeStackOwnedLogGroups(plan, f.run);
    await purgeStackOwnedLogGroups(plan, f.run);
    const cleanup = f.calls.slice(before);
    expect(cleanup.map((args) => args[args.indexOf("--log-group-name") + 1])).toEqual([
      ...plan.logGroups,
      ...plan.logGroups,
    ]);
    expect(cleanup.every((args) => args[0] === "logs" && args[1] === "delete-log-group")).toBe(
      true,
    );
  });
  it.each(["CREATE_FAILED", "DELETE_COMPLETE"])(
    "allows missing physical IDs for %s resources without inventing retained identities",
    async (status) => {
      const f = fixture({
        inventory: resources.map(({ PhysicalResourceId: _physicalId, ...resource }) => ({
          ...resource,
          ResourceStatus: status,
        })),
      });
      const plan = await f.discover();
      expect(plan.retainedResources).toEqual([]);
      expect(plan.tables).toEqual([]);
      expect(plan.logGroups).toEqual([]);
      expect(f.calls.length).toBe(2);
    },
  );
  it.each(["missing", "duplicate", "type", "changing", "malformed"])(
    "rejects %s retained-resource inventory before mutation",
    async (kind) => {
      const bucket = resources.find((resource) => resource.LogicalResourceId === "Bucket");
      const changed = {
        ...bucket,
        ...(kind === "missing" ? { PhysicalResourceId: undefined } : {}),
        ...(kind === "type" ? { ResourceType: "AWS::Cognito::UserPool" } : {}),
        ...(kind === "changing" ? { ResourceStatus: "DELETE_IN_PROGRESS" } : {}),
        ...(kind === "malformed" ? { PhysicalResourceId: 42 } : {}),
      };
      const f = fixture({ inventory: kind === "duplicate" ? [changed, changed] : [changed] });
      await expect(f.discover()).rejects.toThrow();
      expect(f.calls.map((args) => args.slice(0, 2))).toEqual([
        ["cloudformation", "get-template"],
        ["cloudformation", "list-stack-resources"],
      ]);
    },
  );
  it("recovers a failed DynamoDB provider from deployed template references without runtime outputs", async () => {
    const f = fixture({
      fail: (args) => {
        if (args.includes("get-template"))
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              TemplateBody: {
                Resources: Object.fromEntries(
                  ["Events", "Teams", "Deployments"].map((kind) => [
                    kind,
                    { Type: "AWS::DynamoDB::Table" },
                  ]),
                ),
                Outputs: Object.fromEntries(
                  ["Events", "Teams", "Deployments"].map((kind) => [
                    `${kind}TableName`,
                    { Value: { Ref: kind } },
                  ]),
                ),
              },
            }),
          };
        if (args.includes("list-stack-resources"))
          return { code: 0, stderr: "", stdout: JSON.stringify({ StackResourceSummaries: [] }) };
        return undefined;
      },
    });
    const plan = await f.discover();
    expect(plan.storageOutputs[stackArn]).toEqual({ CloudControlDataBackend: "dynamodb" });
    expect(plan.tables).toEqual([]);
  });
  it.each(["delete-table", "table-not-exists", "delete-log-group"])(
    "stops on %s failure",
    async (operation) => {
      const f = fixture({
        fail: (args) =>
          args.includes(operation) ? { code: 2, stdout: "", stderr: "Denied" } : undefined,
      });
      const plan = await f.discover();
      await expect(purgeStackOwnedResources(plan, f.run)).rejects.toThrow("failed");
    },
  );
  it("allows already-absent exact resources when resuming a partial purge", async () => {
    const f = fixture({
      fail: (args) =>
        args.includes("delete-table") || args.includes("delete-log-group")
          ? { code: 1, stdout: "", stderr: "(ResourceNotFoundException) resource missing" }
          : undefined,
    });
    await purgeStackOwnedResources(await f.discover(), f.run);
    expect(f.calls.some((args) => args.includes("table-not-exists"))).toBe(false);
  });
  it.each(["arn", "tags", "inventory"])(
    "rejects %s ownership mismatches before mutation",
    async (kind) => {
      const f = fixture({
        fail: (args) => {
          if (kind === "arn" && args.includes("describe-table"))
            return {
              code: 0,
              stderr: "",
              stdout: JSON.stringify({
                Table: {
                  TableArn: tableArn.replace(account, "210987654321"),
                  TableName: "owned-events",
                  TableStatus: "ACTIVE",
                  DeletionProtectionEnabled: false,
                },
              }),
            };
          if (kind === "tags" && args.includes("list-tags-of-resource"))
            return { code: 0, stderr: "", stdout: '{"Tags":[]}' };
          if (kind === "inventory" && args.includes("list-stack-resources"))
            return {
              code: 0,
              stderr: "",
              stdout: JSON.stringify({ StackResourceSummaries: [...resources, resources[0]] }),
            };
          return undefined;
        },
      });
      await expect(f.discover()).rejects.toThrow();
      expect(
        f.calls.some((args) => args.includes("delete-table") || args.includes("update-table")),
      ).toBe(false);
    },
  );
  it.each([
    "{}",
    "invalid",
    JSON.stringify({ StackResourceSummaries: resources, NextToken: "truncated" }),
  ])("rejects incomplete inventory: %s", (text) => {
    expect(parseStackOwnedCleanupResources(text)).toBeUndefined();
  });
});
