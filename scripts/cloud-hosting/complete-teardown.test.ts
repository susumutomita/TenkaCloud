import { describe, expect, it } from "bun:test";
import { cloudStackTags } from "../../infrastructure/lib/cloud-hosting/stack-names";
import {
  discoverTeardownPlan,
  emptyStackOwnedBuckets,
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
    bucketsOnly?: boolean;
    purgeRetainedBuckets?: boolean;
    status?: string;
    arn?: string;
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
    if (args.includes("get-bucket-tagging")) value = { TagSet: bucketTags() };
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
        stacks: [
          {
            name: "owned",
            arn: overrides.arn ?? stackArn,
            outputs: {},
            status: overrides.status ?? "CREATE_FAILED",
          },
        ],
        bucketsOnly: overrides.bucketsOnly,
        purgeRetainedBuckets: overrides.purgeRetainedBuckets,
        run,
      }),
  };
}
function bucketTags() {
  return Object.entries({
    ...cloudStackTags("test"),
    "aws:cloudformation:stack-id": stackArn,
    "aws:cloudformation:logical-id": "Bucket",
  }).map(([Key, Value]) => ({ Key, Value }));
}
function ok(value: unknown): ProcessResult {
  return { code: 0, stderr: "", stdout: JSON.stringify(value) };
}
function bucketFixture(overrides: Parameters<typeof fixture>[0] = {}) {
  return fixture({
    inventory: [
      {
        LogicalResourceId: "Bucket",
        PhysicalResourceId: "owned-assets",
        ResourceType: "AWS::S3::Bucket",
        ResourceStatus: "DELETE_FAILED",
      },
    ],
    deletionPolicy: () => "Delete",
    bucketsOnly: true,
    ...overrides,
  });
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

describe("failed-stack owned S3 recovery", () => {
  it("empties current and old versions, null versions and delete markers without outputs or control data", async () => {
    const versions = [
      { Key: "index.html", VersionId: "new" },
      { Key: "index.html", VersionId: "old" },
      { Key: "unversioned file.txt", VersionId: "null" },
    ];
    const markers = [{ Key: "deleted.html", VersionId: "marker" }];
    let emptied = false;
    const f = bucketFixture({
      fail: (args) => {
        if (args.includes("list-object-versions"))
          return ok({
            IsTruncated: false,
            Versions: emptied ? [] : versions,
            DeleteMarkers: emptied ? [] : markers,
          });
        if (args.includes("delete-objects")) {
          emptied = true;
          return ok({});
        }
        return undefined;
      },
    });
    const plan = await f.discover();
    expect(plan.buckets).toEqual([
      { name: "owned-assets", logicalId: "Bucket", stackArn, retention: "Delete" },
    ]);
    expect(f.calls.some((args) => args[0] === "dynamodb" || args.includes("delete-objects"))).toBe(
      false,
    );
    await emptyStackOwnedBuckets(plan, f.run);
    const deletion = f.calls.find((args) => args.includes("delete-objects"));
    expect(JSON.parse(deletion?.[deletion.indexOf("--delete") + 1] ?? "{}")).toEqual({
      Objects: [...versions, ...markers],
      Quiet: true,
    });
    const s3Calls = f.calls.filter((args) => args[0] === "s3api");
    expect(
      s3Calls.every(
        (args) =>
          args[args.indexOf("--bucket") + 1] === "owned-assets" &&
          args[args.indexOf("--expected-bucket-owner") + 1] === account,
      ),
    ).toBe(true);
    expect(s3Calls.map((args) => args[1])).toEqual([
      "get-bucket-tagging",
      "list-object-versions",
      "get-bucket-tagging",
      "delete-objects",
      "list-object-versions",
    ]);
    expect(
      f.calls.some(
        (args) =>
          args.includes("list-buckets") ||
          args.includes("delete-bucket") ||
          args.includes("--prefix"),
      ),
    ).toBe(false);
  });
  it("drains more than 1000 objects through bounded service pages and verifies emptiness", async () => {
    let remaining = Array.from({ length: 2005 }, (_, index) => ({
      Key: `file-${index}`,
      VersionId: `version-${index}`,
    }));
    const f = bucketFixture({
      fail: (args) => {
        if (args.includes("list-object-versions"))
          return ok({ IsTruncated: remaining.length > 1000, Versions: remaining.slice(0, 1000) });
        if (args.includes("delete-objects")) {
          remaining = remaining.slice(1000);
          return ok({});
        }
        return undefined;
      },
    });
    await emptyStackOwnedBuckets(await f.discover(), f.run);
    const listings = f.calls.filter((args) => args.includes("list-object-versions"));
    expect(listings).toHaveLength(4);
    expect(
      listings.every(
        (args) => args.includes("--no-paginate") && args[args.indexOf("--max-keys") + 1] === "1000",
      ),
    ).toBe(true);
    expect(
      f.calls
        .filter((args) => args.includes("delete-objects"))
        .map(
          (args) =>
            (JSON.parse(args[args.indexOf("--delete") + 1] ?? "{}") as { Objects: unknown[] })
              .Objects.length,
        ),
    ).toEqual([1000, 1000, 5]);
  });
  it.each(["Retain", "RetainExceptOnCreate"])(
    "honors %s by default and requires an explicit retained-data purge",
    async (policy) => {
      const ordinary = bucketFixture({ deletionPolicy: () => policy });
      const plan = await ordinary.discover();
      await emptyStackOwnedBuckets(plan, ordinary.run);
      expect(plan.buckets).toEqual([]);
      expect(plan.retainedResources[0]?.deletionPolicy).toBe(policy);
      expect(ordinary.calls.some((args) => args[0] === "s3api")).toBe(false);
      const purge = bucketFixture({
        deletionPolicy: () => policy,
        purgeRetainedBuckets: true,
        fail: (args) =>
          args.includes("list-object-versions") ? ok({ IsTruncated: false }) : undefined,
      });
      const purgePlan = await purge.discover();
      const before = purge.calls.length;
      await expect(emptyStackOwnedBuckets(purgePlan, purge.run)).rejects.toThrow("explicit purge");
      expect(purge.calls).toHaveLength(before);
      await emptyStackOwnedBuckets(purgePlan, purge.run, true);
      expect(purge.calls.some((args) => args.includes("list-object-versions"))).toBe(true);
    },
  );
  it("uses CloudFormation's default Delete policy when the deployed template omits it", async () => {
    const f = bucketFixture({ deletionPolicy: () => undefined });
    expect((await f.discover()).buckets[0]?.retention).toBe("Delete");
  });
  it.each(["get-bucket-tagging", "list-object-versions", "delete-objects"])(
    "only accepts an already-gone bucket for %s",
    async (operation) => {
      const f = bucketFixture({
        fail: (args) => {
          if (args.includes(operation))
            return {
              code: 1,
              stdout: "",
              stderr: "An error occurred (NoSuchBucket) when calling operation: absent",
            };
          if (args.includes("list-object-versions"))
            return ok({ IsTruncated: false, Versions: [{ Key: "file", VersionId: "null" }] });
          return undefined;
        },
      });
      await emptyStackOwnedBuckets(await f.discover(), f.run);
    },
  );
  it.each(["get-bucket-tagging", "list-object-versions", "delete-objects"])(
    "fails closed for %s permission errors",
    async (operation) => {
      const f = bucketFixture({
        fail: (args) => {
          if (args.includes(operation))
            return { code: 1, stdout: "", stderr: "An error occurred (AccessDenied): denied" };
          if (args.includes("list-object-versions"))
            return ok({ IsTruncated: false, Versions: [{ Key: "file", VersionId: "null" }] });
          return undefined;
        },
      });
      await expect(
        (async () => emptyStackOwnedBuckets(await f.discover(), f.run))(),
      ).rejects.toThrow("AccessDenied");
    },
  );
  it("fails on a per-object error even when DeleteObjects succeeds at HTTP level", async () => {
    const f = bucketFixture({
      fail: (args) => {
        if (args.includes("list-object-versions"))
          return ok({ IsTruncated: false, Versions: [{ Key: "locked", VersionId: "v1" }] });
        if (args.includes("delete-objects"))
          return ok({
            Errors: [
              { Key: "locked", VersionId: "v1", Code: "AccessDenied", Message: "Object locked" },
            ],
          });
        return undefined;
      },
    });
    await expect(emptyStackOwnedBuckets(await f.discover(), f.run)).rejects.toThrow("AccessDenied");
    expect(f.calls.filter((args) => args.includes("delete-objects"))).toHaveLength(1);
  });
  it.each([
    "Environment",
    "TenkaCloudProject",
    "aws:cloudformation:stack-id",
    "aws:cloudformation:logical-id",
  ])("rejects missing, conflicting and duplicate %s ownership tags", async (key) => {
    for (const kind of ["missing", "conflicting", "duplicate"]) {
      const tags = bucketTags().filter((tag) => tag.Key !== key);
      if (kind !== "missing") tags.push({ Key: key, Value: "foreign" });
      if (kind === "duplicate") tags.push(...bucketTags().filter((tag) => tag.Key === key));
      const f = bucketFixture({
        fail: (args) => (args.includes("get-bucket-tagging") ? ok({ TagSet: tags }) : undefined),
      });
      await expect(f.discover()).rejects.toThrow("ownership tags");
      expect(f.calls.some((args) => args.includes("delete-objects"))).toBe(false);
    }
  });
  it("rechecks ownership after planning and immediately before deletion", async () => {
    let changed = false;
    const f = bucketFixture({
      fail: (args) => {
        if (changed && args.includes("get-bucket-tagging")) return ok({ TagSet: [] });
        if (args.includes("list-object-versions"))
          return ok({ IsTruncated: false, Versions: [{ Key: "file", VersionId: "v1" }] });
        return undefined;
      },
    });
    const plan = await f.discover();
    changed = true;
    await expect(emptyStackOwnedBuckets(plan, f.run)).rejects.toThrow("ownership tags");
    expect(f.calls.some((args) => args.includes("delete-objects"))).toBe(false);
  });
  it.each([stackArn.replace(account, "210987654321"), stackArn.replace(region, "us-east-1")])(
    "rejects stack account or region mismatch before discovery: %s",
    async (arn) => {
      const f = bucketFixture({ arn });
      await expect(f.discover()).rejects.toThrow("selected account and region");
      expect(f.calls).toEqual([]);
    },
  );
  it("does not inventory or clean buckets while CloudFormation deletion is in progress", async () => {
    const f = bucketFixture({ status: "DELETE_IN_PROGRESS" });
    await emptyStackOwnedBuckets(await f.discover(), f.run);
    expect(f.calls).toEqual([]);
  });
  it("stops when an apparently successful deletion makes no progress", async () => {
    const f = bucketFixture({
      fail: (args) =>
        args.includes("list-object-versions")
          ? ok({ IsTruncated: true, Versions: [{ Key: "file", VersionId: "v1" }] })
          : undefined,
    });
    await expect(emptyStackOwnedBuckets(await f.discover(), f.run)).rejects.toThrow("no progress");
    expect(f.calls.filter((args) => args.includes("delete-objects"))).toHaveLength(1);
  });
  it.each([
    { IsTruncated: true },
    { Versions: [] },
    { IsTruncated: false, Versions: [{ Key: "file" }] },
  ])("rejects a malformed or stalled S3 listing before deletion: %j", async (page) => {
    const f = bucketFixture({
      fail: (args) => (args.includes("list-object-versions") ? ok(page) : undefined),
    });
    await expect(emptyStackOwnedBuckets(await f.discover(), f.run)).rejects.toThrow();
    expect(f.calls.some((args) => args.includes("delete-objects"))).toBe(false);
  });
  it("bounds deletion when writers keep creating different versions", async () => {
    let version = 0;
    const f = bucketFixture({
      fail: (args) =>
        args.includes("list-object-versions")
          ? ok({ IsTruncated: false, Versions: [{ Key: "file", VersionId: String(version++) }] })
          : undefined,
    });
    await expect(emptyStackOwnedBuckets(await f.discover(), f.run)).rejects.toThrow(
      "exceeded 10000 pages",
    );
    expect(f.calls.filter((args) => args.includes("delete-objects"))).toHaveLength(10000);
  });
});

describe("S3 deletion payload safety", () => {
  it("splits long UTF-8 and escaped keys below the OS argument limit without losing identities", async () => {
    const objects = Array.from({ length: 1000 }, (_, index) => ({
      Key: `${"\n雪".repeat(200)}-${index}`,
      VersionId: `version-${index}`,
    }));
    let listed = false;
    const f = bucketFixture({
      fail: (args) => {
        if (!args.includes("list-object-versions")) return undefined;
        const result = ok({ IsTruncated: false, Versions: listed ? [] : objects });
        listed = true;
        return result;
      },
    });
    await emptyStackOwnedBuckets(await f.discover(), f.run);
    const requests = f.calls
      .filter((args) => args.includes("delete-objects"))
      .map((args) => args[args.indexOf("--delete") + 1] ?? "{}");
    expect(requests.length).toBeGreaterThan(1);
    expect(requests.every((request) => Buffer.byteLength(request) <= 64 * 1024)).toBe(true);
    expect(
      requests.flatMap((request) => (JSON.parse(request) as { Objects: unknown[] }).Objects),
    ).toEqual(objects);
    const writes = f.calls.flatMap((args, index) =>
      args.includes("delete-objects") ? [index] : [],
    );
    expect(writes.every((index) => f.calls[index - 1]?.includes("get-bucket-tagging"))).toBe(true);
  });
  it("rejects missing tag sets instead of treating them as absent buckets", async () => {
    const f = bucketFixture({
      fail: (args) =>
        args.includes("get-bucket-tagging")
          ? { code: 1, stdout: "", stderr: "(NoSuchTagSet) absent tags" }
          : undefined,
    });
    await expect(f.discover()).rejects.toThrow("NoSuchTagSet");
  });
  it("skips a physical name marked DELETE_COMPLETE without adopting a replacement bucket", async () => {
    const f = bucketFixture({
      inventory: [
        {
          LogicalResourceId: "Bucket",
          PhysicalResourceId: "owned-assets",
          ResourceType: "AWS::S3::Bucket",
          ResourceStatus: "DELETE_COMPLETE",
        },
      ],
    });
    expect((await f.discover()).buckets).toEqual([]);
    expect(f.calls.some((args) => args[0] === "s3api")).toBe(false);
  });
});

describe("S3 recovery command boundaries", () => {
  it("accepts AWS CLI's empty successful quiet-delete output and still verifies emptiness", async () => {
    let deleted = false;
    const f = bucketFixture({
      fail: (args) => {
        if (args.includes("list-object-versions"))
          return ok({
            IsTruncated: false,
            Versions: deleted ? [] : [{ Key: "file", VersionId: "null" }],
          });
        if (args.includes("delete-objects")) {
          deleted = true;
          return { code: 0, stdout: "", stderr: "" };
        }
        return undefined;
      },
    });
    await emptyStackOwnedBuckets(await f.discover(), f.run);
    expect(f.calls.filter((args) => args.includes("list-object-versions"))).toHaveLength(2);
  });
  it("does not read tables or delete logs in ordinary bucket-only discovery", async () => {
    const f = fixture({
      bucketsOnly: true,
      deletionPolicy: () => "Delete",
      fail: (args) =>
        args[0] === "dynamodb"
          ? { code: 1, stdout: "", stderr: "Control database is unavailable" }
          : undefined,
    });
    const plan = await f.discover();
    expect(plan.buckets).toHaveLength(1);
    expect(plan.tables).toEqual([]);
    expect(plan.logGroups).toEqual([]);
    expect(
      f.calls.every((args) => args[0] === "cloudformation" || args[1] === "get-bucket-tagging"),
    ).toBe(true);
  });
});
