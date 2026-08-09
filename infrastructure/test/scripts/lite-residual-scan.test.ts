import { describe, expect, it } from "vitest";
import {
  type AwsCommandError,
  LITE_RESIDUAL_SERVICES,
  type LiteResidualInventoryAdapter,
  type LiteResidualOwnershipEvidence,
  liteResidualScanExitCode,
  type ObservedResource,
  parseLiteResidualOwnershipEvidence,
  scanLiteResidualResources,
  serializeLiteResidualScanReport,
} from "../../../scripts/lib/lite-residual-scan";
import {
  type AwsCliResult,
  type AwsCliRunner,
  createAwsCliLiteResidualInventory,
} from "../../../scripts/lib/lite-residual-scan-aws";
import {
  parseLiteResidualScanCliArgs,
  runLiteResidualScanCli,
} from "../../../scripts/ops/scan-lite-residual-resources";

const ACCOUNT_ID = "111122223333";
const REGION = "ap-northeast-1";
const RUN_ID = "golden-run-001";
const PLATFORM_COMMIT = "a".repeat(40);
const CATALOG_COMMIT = "b".repeat(40);
const SIMULATOR_IMAGE = `public.ecr.aws/tenkacloud/simulator@sha256:${"c".repeat(64)}`;
const RELEASE_IDENTITY = {
  releaseVersion: "1.2.3-rc.1",
  platformCommit: PLATFORM_COMMIT,
  catalogCommit: CATALOG_COMMIT,
  simulatorImage: SIMULATOR_IMAGE,
};

function emptyResources(): LiteResidualOwnershipEvidence["resources"] {
  return {
    cloudformation: [],
    dynamodb: [],
    s3: [],
    logs: [],
    sns: [],
    budgets: [],
    codebuild: [],
  };
}

function ownership(
  overrides: Partial<LiteResidualOwnershipEvidence> = {},
): LiteResidualOwnershipEvidence {
  return {
    evidenceVersion: 1,
    runId: RUN_ID,
    mode: "lite",
    environment: "development",
    accountId: ACCOUNT_ID,
    region: REGION,
    releaseIdentity: RELEASE_IDENTITY,
    resources: emptyResources(),
    ...overrides,
  };
}

function scanInput(ownershipEvidence = ownership(), releaseIdentity = RELEASE_IDENTITY) {
  return {
    runId: RUN_ID,
    environment: "development",
    expectedAccountId: ACCOUNT_ID,
    region: REGION,
    releaseIdentity,
    ownership: ownershipEvidence,
  };
}

function identityOk() {
  return {
    ok: true as const,
    identity: {
      accountId: ACCOUNT_ID,
      arn: `arn:aws:iam::${ACCOUNT_ID}:user/scanner`,
      partition: "aws",
    },
  };
}

function cleanAdapter(
  serviceCalls: string[] = [],
  override?: LiteResidualInventoryAdapter["scanService"],
): LiteResidualInventoryAdapter {
  return {
    getCallerIdentity: async () => identityOk(),
    scanService: async (service, input) => {
      serviceCalls.push(service);
      if (override) return override(service, input);
      if (service === "cloudformation") {
        return {
          resources: [
            { id: "CDKToolkit", tags: {} },
            { id: "unrelated-stack", tags: { Project: "Elsewhere" } },
          ],
          errors: [],
        };
      }
      if (service === "s3") {
        return {
          resources: [
            { id: `cdk-hnb659fds-assets-${ACCOUNT_ID}-${REGION}`, tags: {} },
            { id: "other-environment", tags: { Project: "TenkaCloud", Environment: "staging" } },
          ],
          errors: [],
        };
      }
      return { resources: [], errors: [] };
    },
  };
}

const accessDenied: AwsCommandError = {
  code: "aws-command-failed",
  operation: "dynamodb list-tables",
  message: "AccessDenied (exit 254)",
};

describe("Lite residual scan contract (#2977)", () => {
  it("passes only after every supported service returned a clean inventory", async () => {
    const calls: string[] = [];
    let timeIndex = 0;
    const report = await scanLiteResidualResources(scanInput(), {
      inventory: cleanAdapter(calls),
      now: () =>
        timeIndex++ === 0 ? new Date("2026-08-09T00:00:00Z") : new Date("2026-08-09T00:00:01Z"),
    });

    expect(report.decision).toBe("passed");
    expect(report.reportVersion).toBe(1);
    expect(report.releaseIdentity).toEqual(RELEASE_IDENTITY);
    expect(report.startedAt).toBe("2026-08-09T00:00:00.000Z");
    expect(report.completedAt).toBe("2026-08-09T00:00:01.000Z");
    expect(new Set(calls)).toEqual(new Set(LITE_RESIDUAL_SERVICES));
    expect(report.services.cloudformation.allowlisted).toEqual([
      { id: "CDKToolkit", reason: "cdk-bootstrap" },
    ]);
    expect(report.services.s3.allowlisted).toEqual([
      {
        id: `cdk-hnb659fds-assets-${ACCOUNT_ID}-${REGION}`,
        reason: "cdk-bootstrap",
      },
    ]);
  });

  it("never lets the bootstrap allowlist override exact run ownership", async () => {
    const bootstrapBucket = `cdk-hnb659fds-assets-${ACCOUNT_ID}-${REGION}`;
    const exact = ownership({
      resources: {
        ...emptyResources(),
        cloudformation: ["CDKToolkit"],
        s3: [bootstrapBucket],
      },
    });
    const report = await scanLiteResidualResources(scanInput(exact), {
      inventory: cleanAdapter(),
    });

    expect(report.decision).toBe("failed");
    expect(report.services.cloudformation.unexpected).toEqual([
      { id: "CDKToolkit", ownership: "exact" },
    ]);
    expect(report.services.s3.unexpected).toEqual([{ id: bootstrapBucket, ownership: "exact" }]);
    expect(report.services.cloudformation.allowlisted).toEqual([]);
    expect(report.services.s3.allowlisted).toEqual([]);
  });

  it("fails on exact or target-tag-owned residuals but ignores another environment", async () => {
    const exact = ownership({
      resources: { ...emptyResources(), dynamodb: ["captured-table"] },
    });
    const report = await scanLiteResidualResources(scanInput(exact), {
      inventory: cleanAdapter([], async (service) => {
        if (service !== "dynamodb") return { resources: [], errors: [] };
        const resources: ObservedResource[] = [
          { id: "captured-table" },
          { id: "tagged-table", tags: { Project: "TenkaCloud", Environment: "development" } },
          { id: "ambiguous-table", tags: { Project: "TenkaCloud" } },
          { id: "staging-table", tags: { Project: "TenkaCloud", Environment: "staging" } },
        ];
        return {
          resources,
          errors: [],
        };
      }),
    });

    expect(report.decision).toBe("failed");
    expect(report.services.dynamodb.unexpected).toEqual([
      { id: "ambiguous-table", ownership: "project-tag-missing-environment" },
      { id: "captured-table", ownership: "exact" },
      { id: "tagged-table", ownership: "project-environment-tags" },
    ]);
    expect(report.services.dynamodb.unexpected.map((item) => item.id)).not.toContain(
      "staging-table",
    );
  });

  it("returns undecidable when an inventory access error occurs and never rounds it to empty", async () => {
    const report = await scanLiteResidualResources(scanInput(), {
      inventory: cleanAdapter([], async (service) =>
        service === "dynamodb"
          ? { resources: [], errors: [accessDenied] }
          : { resources: [], errors: [] },
      ),
    });

    expect(report.decision).toBe("undecidable");
    expect(report.services.dynamodb.decision).toBe("undecidable");
    expect(report.services.dynamodb.errors).toEqual([accessDenied]);
    expect(liteResidualScanExitCode(report.decision)).toBe(2);
  });

  it("keeps a known residual failed even when another inventory is undecidable", async () => {
    const report = await scanLiteResidualResources(scanInput(), {
      inventory: cleanAdapter([], async (service) => {
        if (service === "dynamodb") return { resources: [], errors: [accessDenied] };
        if (service === "logs") {
          return {
            resources: [
              {
                id: "owned-log",
                tags: { Project: "TenkaCloud", Environment: "development" },
              },
            ],
            errors: [],
          };
        }
        return { resources: [], errors: [] };
      }),
    });
    expect(report.decision).toBe("failed");
    expect(report.services.logs.decision).toBe("failed");
    expect(report.services.dynamodb.decision).toBe("undecidable");
  });

  it("turns an adapter throw into undecidable evidence instead of rejecting the whole report", async () => {
    const report = await scanLiteResidualResources(scanInput(), {
      inventory: cleanAdapter([], async (service) => {
        if (service === "sns") throw new Error("credential expired");
        return { resources: [], errors: [] };
      }),
    });
    expect(report.decision).toBe("undecidable");
    expect(report.services.sns.errors[0]?.message).toBe("credential expired");
  });

  it("does not run service scans after an STS failure or account mismatch", async () => {
    const calls: string[] = [];
    const stsFailure: LiteResidualInventoryAdapter = {
      getCallerIdentity: async () => ({
        ok: false,
        error: { ...accessDenied, operation: "sts get-caller-identity" },
      }),
      scanService: async (service) => {
        calls.push(service);
        return { resources: [], errors: [] };
      },
    };
    const undecidable = await scanLiteResidualResources(scanInput(), { inventory: stsFailure });
    expect(undecidable.decision).toBe("undecidable");
    expect(undecidable.observedAccountId).toBeNull();
    expect(calls).toEqual([]);

    const wrongAccount: LiteResidualInventoryAdapter = {
      ...stsFailure,
      getCallerIdentity: async () => ({
        ok: true,
        identity: {
          accountId: "999900001111",
          arn: "arn:aws:iam::999900001111:user/wrong",
          partition: "aws",
        },
      }),
    };
    const failed = await scanLiteResidualResources(scanInput(), { inventory: wrongAccount });
    expect(failed.decision).toBe("failed");
    expect(failed.decisionReasons[0]).toContain("does not match expected");
    expect(calls).toEqual([]);
  });

  it("returns undecidable without scanning when ownership evidence belongs to another run", async () => {
    const calls: string[] = [];
    const report = await scanLiteResidualResources(
      scanInput(ownership({ runId: "different-run", region: "us-east-1" })),
      { inventory: cleanAdapter(calls) },
    );
    expect(report.decision).toBe("undecidable");
    expect(report.decisionReasons).toEqual([
      "ownership evidence runId mismatch",
      "ownership evidence region mismatch",
    ]);
    expect(calls).toEqual([]);
  });

  it("refuses to scan when the ownership artifact belongs to another immutable release", async () => {
    const calls: string[] = [];
    const otherRelease = { ...RELEASE_IDENTITY, platformCommit: "d".repeat(40) };
    const report = await scanLiteResidualResources(scanInput(ownership(), otherRelease), {
      inventory: cleanAdapter(calls),
    });
    expect(report.decision).toBe("undecidable");
    expect(report.decisionReasons).toContain(
      "ownership evidence releaseIdentity.platformCommit mismatch",
    );
    expect(report.releaseIdentity).toEqual(otherRelease);
    expect(report.ownershipEvidence.releaseIdentity).toEqual(RELEASE_IDENTITY);
    expect(calls).toEqual([]);
  });

  it("serializes a versioned report and uses distinct failed/undecidable exit codes", async () => {
    const report = await scanLiteResidualResources(scanInput(), { inventory: cleanAdapter() });
    const serialized = serializeLiteResidualScanReport(report);
    expect(serialized.endsWith("\n")).toBe(true);
    expect(JSON.parse(serialized)).toMatchObject({ reportVersion: 1, runId: RUN_ID });
    expect(liteResidualScanExitCode("passed")).toBe(0);
    expect(liteResidualScanExitCode("failed")).toBe(1);
    expect(liteResidualScanExitCode("undecidable")).toBe(2);
  });
});

describe("ownership evidence parser (#2977)", () => {
  it("accepts the complete seven-service exact ownership shape", () => {
    expect(parseLiteResidualOwnershipEvidence(ownership())).toEqual(ownership());
  });

  it("accepts canonical service-native IDs without narrowing valid names", () => {
    const resources = {
      cloudformation: ["TenkaCloud-Golden-1"],
      dynamodb: ["tenkacloud.table_1"],
      s3: ["tenkacloud.golden-path-1"],
      logs: ["/aws/lambda/tenkacloud-golden_1"],
      sns: [`arn:aws:sns:${REGION}:${ACCOUNT_ID}:tenkacloud_golden-1.fifo`],
      budgets: ["TenkaCloud Golden Path"],
      codebuild: ["tenkacloud_golden-1"],
    };
    expect(parseLiteResidualOwnershipEvidence(ownership({ resources })).resources).toEqual(
      resources,
    );
  });

  it("rejects missing service arrays, duplicate IDs, wrong modes, and non-object input", () => {
    const missingS3 = { ...ownership(), resources: { ...emptyResources(), s3: undefined } };
    expect(() => parseLiteResidualOwnershipEvidence(missingS3)).toThrow("resources.s3");
    const duplicate = {
      ...ownership(),
      resources: { ...emptyResources(), logs: ["same", "same"] },
    };
    expect(() => parseLiteResidualOwnershipEvidence(duplicate)).toThrow("duplicate IDs");
    expect(() => parseLiteResidualOwnershipEvidence({ ...ownership(), mode: "saas" })).toThrow(
      'mode must be "lite"',
    );
    expect(() => parseLiteResidualOwnershipEvidence(null)).toThrow("JSON object");
  });

  it("rejects unknown fields at every versioned evidence boundary", () => {
    expect(() =>
      parseLiteResidualOwnershipEvidence({ ...ownership(), ignoredTopLevel: true }),
    ).toThrow("unknown field(s): ignoredTopLevel");
    expect(() =>
      parseLiteResidualOwnershipEvidence({
        ...ownership(),
        resources: { ...emptyResources(), sqs: [] },
      }),
    ).toThrow("unknown field(s): sqs");
    expect(() =>
      parseLiteResidualOwnershipEvidence({
        ...ownership(),
        releaseIdentity: { ...RELEASE_IDENTITY, mutableTag: "latest" },
      }),
    ).toThrow("unknown field(s): mutableTag");
  });

  it("requires full Git commits and a digest-pinned simulator image", () => {
    expect(() =>
      parseLiteResidualOwnershipEvidence({
        ...ownership(),
        releaseIdentity: { ...RELEASE_IDENTITY, platformCommit: "abc1234" },
      }),
    ).toThrow("full lowercase Git commit");
    expect(() =>
      parseLiteResidualOwnershipEvidence({
        ...ownership(),
        releaseIdentity: { ...RELEASE_IDENTITY, simulatorImage: "simulator:latest" },
      }),
    ).toThrow("pinned by sha256 digest");
    expect(() =>
      parseLiteResidualOwnershipEvidence({
        ...ownership(),
        releaseIdentity: { ...RELEASE_IDENTITY, releaseVersion: "v1.2.3" },
      }),
    ).toThrow("canonical SemVer without a v prefix");
    expect(() =>
      parseLiteResidualOwnershipEvidence({
        ...ownership(),
        releaseIdentity: { ...RELEASE_IDENTITY, releaseVersion: "01.2.3" },
      }),
    ).toThrow("canonical SemVer");
  });

  it("rejects malformed run scope and non-canonical service IDs", () => {
    for (const invalid of [
      { runId: " run" },
      { environment: "Development" },
      { accountId: "not-an-account" },
      { region: "not-a-region" },
    ]) {
      expect(() => parseLiteResidualOwnershipEvidence(ownership(invalid))).toThrow(
        "ownership evidence",
      );
    }
    expect(() =>
      parseLiteResidualOwnershipEvidence(
        ownership({ resources: { ...emptyResources(), logs: ["\n"] } }),
      ),
    ).toThrow("non-canonical ID");
    expect(() =>
      parseLiteResidualOwnershipEvidence(
        ownership({ resources: { ...emptyResources(), s3: ["not a bucket"] } }),
      ),
    ).toThrow("invalid S3 bucket name");
  });

  it("requires SNS ownership ARNs to match the evidence account and region", () => {
    expect(() =>
      parseLiteResidualOwnershipEvidence(
        ownership({
          resources: {
            ...emptyResources(),
            sns: [`arn:aws:sns:${REGION}:999900001111:wrong-account`],
          },
        }),
      ),
    ).toThrow("another account or region");
    expect(() =>
      parseLiteResidualOwnershipEvidence(
        ownership({
          resources: {
            ...emptyResources(),
            sns: [`arn:aws:sns:us-east-1:${ACCOUNT_ID}:wrong-region`],
          },
        }),
      ),
    ).toThrow("another account or region");
  });
});

const ok = (value: unknown): AwsCliResult => ({
  code: 0,
  stdout: JSON.stringify(value ?? null),
  stderr: "",
});

function awsOperation(args: readonly string[]): string {
  return `${args[0]} ${args[1]}`;
}

describe("AWS CLI inventory adapter (#2977)", () => {
  it("paginates CloudFormation explicitly and keeps exact tag evidence", async () => {
    const calls: string[][] = [];
    const run: AwsCliRunner = async (args) => {
      calls.push([...args]);
      if (args.includes("--starting-token")) {
        return ok({
          Stacks: [
            {
              StackName: "tenkacloud-lite",
              Tags: [
                { Key: "Project", Value: "TenkaCloud" },
                { Key: "Environment", Value: "development" },
              ],
            },
          ],
        });
      }
      return ok({ Stacks: [{ StackName: "CDKToolkit", Tags: [] }], NextToken: "page-2" });
    };
    const inventory = await createAwsCliLiteResidualInventory(run).scanService("cloudformation", {
      accountId: ACCOUNT_ID,
      region: REGION,
      partition: "aws",
    });
    expect(inventory.errors).toEqual([]);
    expect(inventory.resources).toEqual([
      { id: "CDKToolkit", tags: {} },
      {
        id: "tenkacloud-lite",
        tags: { Project: "TenkaCloud", Environment: "development" },
      },
    ]);
    expect(calls[1]).toContain("--starting-token");
    expect(calls[1]).toContain("page-2");
  });

  it("reports repeated tokens and malformed list responses rather than returning clean", async () => {
    const cycling = createAwsCliLiteResidualInventory(async () =>
      ok({ Stacks: [], NextToken: "same" }),
    );
    const cycled = await cycling.scanService("cloudformation", {
      accountId: ACCOUNT_ID,
      region: REGION,
      partition: "aws",
    });
    expect(cycled.errors[0]?.code).toBe("pagination-cycle");

    const malformed = createAwsCliLiteResidualInventory(async () => ok({}));
    const malformedInventory = await malformed.scanService("dynamodb", {
      accountId: ACCOUNT_ID,
      region: REGION,
      partition: "aws",
    });
    expect(malformedInventory.resources).toEqual([]);
    expect(malformedInventory.errors[0]?.code).toBe("malformed-response");
  });

  it("supports all seven service inventories and their service-native tag shapes", async () => {
    const calls: string[] = [];
    const responses: Readonly<Record<string, unknown>> = {
      "cloudformation describe-stacks": {
        Stacks: [{ StackName: "stack", Tags: [{ Key: "K", Value: "V" }] }],
      },
      "dynamodb list-tables": { TableNames: ["table"] },
      "dynamodb describe-table": {
        Table: { TableArn: `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/table` },
      },
      "dynamodb list-tags-of-resource": { Tags: [{ Key: "K", Value: "V" }] },
      "s3api list-buckets": { Buckets: [{ Name: "bucket" }] },
      "s3api get-bucket-tagging": { TagSet: [{ Key: "K", Value: "V" }] },
      "logs describe-log-groups": {
        logGroups: [
          {
            logGroupName: "group",
            logGroupArn: `arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:group`,
          },
        ],
      },
      "logs list-tags-for-resource": { tags: { K: "V" } },
      "sns list-topics": {
        Topics: [{ TopicArn: `arn:aws:sns:${REGION}:${ACCOUNT_ID}:topic` }],
      },
      "sns list-tags-for-resource": { Tags: [{ Key: "K", Value: "V" }] },
      "budgets describe-budgets": { Budgets: [{ BudgetName: "budget" }] },
      "budgets list-tags-for-resource": { ResourceTags: [{ Key: "K", Value: "V" }] },
      "codebuild list-projects": { projects: ["project"] },
      "codebuild batch-get-projects": {
        projects: [{ name: "project", tags: [{ key: "K", value: "V" }] }],
        projectsNotFound: [],
      },
    };
    const run: AwsCliRunner = async (args) => {
      const operation = awsOperation(args);
      calls.push(operation);
      if (!(operation in responses)) throw new Error(`unexpected AWS call: ${args.join(" ")}`);
      return ok(responses[operation]);
    };
    const adapter = createAwsCliLiteResidualInventory(run);
    const inventories = await Promise.all(
      LITE_RESIDUAL_SERVICES.map((service) =>
        adapter.scanService(service, { accountId: ACCOUNT_ID, region: REGION, partition: "aws" }),
      ),
    );
    expect(inventories.every((inventory) => inventory.errors.length === 0)).toBe(true);
    expect(inventories.every((inventory) => inventory.resources[0]?.tags?.K === "V")).toBe(true);
    expect(new Set(calls.filter((call) => call.includes("list-tags")))).toEqual(
      new Set([
        "dynamodb list-tags-of-resource",
        "logs list-tags-for-resource",
        "sns list-tags-for-resource",
        "budgets list-tags-for-resource",
      ]),
    );
  });

  it("treats a successful dedicated tag response with a missing field as malformed", async () => {
    const responses: Readonly<Record<string, unknown>> = {
      "s3api list-buckets": { Buckets: [{ Name: "bucket" }] },
      "logs describe-log-groups": {
        logGroups: [
          {
            logGroupName: "group",
            logGroupArn: `arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:group`,
          },
        ],
      },
      "sns list-topics": {
        Topics: [{ TopicArn: `arn:aws:sns:${REGION}:${ACCOUNT_ID}:topic` }],
      },
      "budgets describe-budgets": { Budgets: [{ BudgetName: "budget" }] },
    };
    const run: AwsCliRunner = async (args) => ok(responses[awsOperation(args)] ?? {});
    const adapter = createAwsCliLiteResidualInventory(run);
    const services = ["s3", "logs", "sns", "budgets"] as const;
    const inventories = await Promise.all(
      services.map((service) =>
        adapter.scanService(service, { accountId: ACCOUNT_ID, region: REGION, partition: "aws" }),
      ),
    );

    for (const inventory of inventories) {
      expect(inventory.resources).toHaveLength(1);
      expect(inventory.resources[0]?.tags).toBeUndefined();
      expect(inventory.errors[0]?.code).toBe("malformed-response");
      expect(inventory.errors[0]?.message).toContain("field is required");
    }
  });

  it("rejects malformed CodeBuild tags instead of treating the project as untagged", async () => {
    const run: AwsCliRunner = async (args) => {
      if (awsOperation(args) === "codebuild list-projects") return ok({ projects: ["project"] });
      return ok({ projects: [{ name: "project", tags: [{ key: "K" }] }], projectsNotFound: [] });
    };
    const inventory = await createAwsCliLiteResidualInventory(run).scanService("codebuild", {
      accountId: ACCOUNT_ID,
      region: REGION,
      partition: "aws",
    });
    expect(inventory.resources).toEqual([{ id: "project" }]);
    expect(inventory.errors[0]?.code).toBe("malformed-response");
  });

  it("distinguishes S3 NoSuchTagSet from AccessDenied", async () => {
    let tagResult: AwsCliResult = {
      code: 254,
      stdout: "",
      stderr: "An error occurred (NoSuchTagSet)",
    };
    const run: AwsCliRunner = async (args) =>
      awsOperation(args) === "s3api list-buckets"
        ? ok({ Buckets: [{ Name: "bucket" }] })
        : tagResult;
    const adapter = createAwsCliLiteResidualInventory(run);
    const untagged = await adapter.scanService("s3", {
      accountId: ACCOUNT_ID,
      region: REGION,
      partition: "aws",
    });
    expect(untagged).toEqual({ resources: [{ id: "bucket", tags: {} }], errors: [] });

    tagResult = { code: 254, stdout: "", stderr: "AccessDenied" };
    const denied = await adapter.scanService("s3", {
      accountId: ACCOUNT_ID,
      region: REGION,
      partition: "aws",
    });
    expect(denied.resources).toEqual([{ id: "bucket" }]);
    expect(denied.errors[0]?.code).toBe("aws-command-failed");
  });

  it("preflights STS account and ARN shape without accepting malformed identity", async () => {
    const good = createAwsCliLiteResidualInventory(async () =>
      ok({ Account: ACCOUNT_ID, Arn: `arn:aws:iam::${ACCOUNT_ID}:user/scanner` }),
    );
    await expect(good.getCallerIdentity(REGION)).resolves.toEqual(identityOk());

    const bad = createAwsCliLiteResidualInventory(async () => ok({ Account: "", Arn: "nope" }));
    await expect(bad.getCallerIdentity(REGION)).resolves.toMatchObject({
      ok: false,
      error: { code: "malformed-response" },
    });

    const mismatchedAccount = createAwsCliLiteResidualInventory(async () =>
      ok({ Account: ACCOUNT_ID, Arn: "arn:aws:iam::999900001111:user/scanner" }),
    );
    await expect(mismatchedAccount.getCallerIdentity(REGION)).resolves.toMatchObject({
      ok: false,
      error: { code: "malformed-response" },
    });
  });
});

describe("Lite residual scanner CLI (#2977)", () => {
  const argv = [
    `--run-id=${RUN_ID}`,
    "--environment=development",
    `--expected-account=${ACCOUNT_ID}`,
    `--expected-region=${REGION}`,
    `--release-version=${RELEASE_IDENTITY.releaseVersion}`,
    `--platform-commit=${PLATFORM_COMMIT}`,
    `--catalog-commit=${CATALOG_COMMIT}`,
    `--simulator-image=${SIMULATOR_IMAGE}`,
    "--ownership-file=/tmp/ownership.json",
  ];

  it("requires exact account/region/run/ownership arguments", () => {
    expect(parseLiteResidualScanCliArgs(argv)).toMatchObject({
      runId: RUN_ID,
      expectedAccountId: ACCOUNT_ID,
      expectedRegion: REGION,
      releaseIdentity: RELEASE_IDENTITY,
    });
    expect(() => parseLiteResidualScanCliArgs([])).toThrow("are required");
    expect(() => parseLiteResidualScanCliArgs(["--unknown=x"])).toThrow("unknown argument");
  });

  it("writes one JSON report and returns the report decision exit code", async () => {
    const stdout: string[] = [];
    const runAws: AwsCliRunner = async (args) => {
      const operation = awsOperation(args);
      if (operation === "sts get-caller-identity") {
        return ok({ Account: ACCOUNT_ID, Arn: `arn:aws:iam::${ACCOUNT_ID}:user/scanner` });
      }
      const emptyByOperation: Record<string, unknown> = {
        "cloudformation describe-stacks": { Stacks: [] },
        "dynamodb list-tables": { TableNames: [] },
        "s3api list-buckets": { Buckets: [] },
        "logs describe-log-groups": { logGroups: [] },
        "sns list-topics": { Topics: [] },
        "budgets describe-budgets": { Budgets: [] },
        "codebuild list-projects": { projects: [] },
      };
      return ok(emptyByOperation[operation]);
    };
    const code = await runLiteResidualScanCli(argv, {
      runAws,
      readTextFile: () => JSON.stringify(ownership()),
      stdout: (text) => stdout.push(text),
      stderr: () => undefined,
    });
    expect(code).toBe(0);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0] ?? "{}")).toMatchObject({
      reportVersion: 1,
      decision: "passed",
      runId: RUN_ID,
      releaseIdentity: RELEASE_IDENTITY,
    });
  });

  it("returns undecidable JSON without inventories when the release BOM does not match", async () => {
    const calls: string[] = [];
    const stdout: string[] = [];
    const code = await runLiteResidualScanCli(argv, {
      runAws: async (args) => {
        calls.push(awsOperation(args));
        return ok({ Account: ACCOUNT_ID, Arn: `arn:aws:iam::${ACCOUNT_ID}:user/scanner` });
      },
      readTextFile: () =>
        JSON.stringify(
          ownership({
            releaseIdentity: { ...RELEASE_IDENTITY, catalogCommit: "d".repeat(40) },
          }),
        ),
      stdout: (text) => stdout.push(text),
      stderr: () => undefined,
    });
    expect(code).toBe(2);
    expect(calls).toEqual(["sts get-caller-identity"]);
    expect(JSON.parse(stdout[0] ?? "{}")).toMatchObject({
      decision: "undecidable",
      decisionReasons: ["ownership evidence releaseIdentity.catalogCommit mismatch"],
    });
  });

  it("returns usage without AWS calls for malformed ownership JSON", async () => {
    let called = false;
    const stderr: string[] = [];
    const code = await runLiteResidualScanCli(argv, {
      runAws: async () => {
        called = true;
        return ok({});
      },
      readTextFile: () => "not-json",
      stderr: (text) => stderr.push(text),
    });
    expect(code).toBe(64);
    expect(called).toBe(false);
    expect(stderr.join("")).toContain("invalid JSON");
  });
});
