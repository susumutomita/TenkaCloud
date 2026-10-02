import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectBootstrap } from "../../infrastructure/lib/cloud-hosting/bootstrap";
import { deploymentPolicies } from "../../infrastructure/lib/cloud-hosting/deployment-policy";
import {
  cloudStackNames,
  cloudStackTags,
} from "../../infrastructure/lib/cloud-hosting/stack-names";
import { contentDigest } from "../../infrastructure/lib/problem-deploy/control-data/domain/deployment-work";
import type {
  InstallationControl,
  InstallationScope,
} from "../../infrastructure/lib/problem-deploy/control-data/installation-control";
import { installationScopeDigest } from "../../infrastructure/lib/problem-deploy/control-data/installation-control";
import { assertOwnedBootstrap } from "./bootstrap-check";
import { runCloudCli } from "./cli";
import type { CloudInstallation, InstallationLocation } from "./installation";
import type { CloudCliIo, ProcessRequest, ProcessResult } from "./process";
import "./main";

const POLICY = deploymentPolicies({
  account: "123456789012",
  region: "ap-northeast-1",
  environment: "staging",
}).identities.executionPolicyArns.join(",");
function ownedToolkit() {
  return {
    Tags: [
      { Key: "TenkaCloudProject", Value: "cloud-hosting" },
      { Key: "Environment", Value: "staging" },
    ],
    Parameters: [
      { ParameterKey: "Qualifier", ParameterValue: projectBootstrap("staging").qualifier },
      { ParameterKey: "CloudFormationExecutionPolicies", ParameterValue: POLICY },
      { ParameterKey: "BootstrapVariant", ParameterValue: "TenkaCloud cloud-hosting v1" },
      { ParameterKey: "TrustedAccounts", ParameterValue: "" },
      { ParameterKey: "TrustedAccountsForLookup", ParameterValue: "" },
    ],
  };
}
const ROOT = "/fixture/TenkaCloud";
function ownedStack(name: string) {
  return {
    StackId: `arn:aws:cloudformation:ap-northeast-1:123456789012:stack/${name}/synthetic-stack-id`,
    StackName: name,
    StackStatus: "CREATE_COMPLETE",
    Outputs: [
      { OutputKey: "CloudRunnerEnabled", OutputValue: "false" },
      { OutputKey: "CloudInstallationControlVersion", OutputValue: "1" },
      ...["Events", "Teams", "Deployments"].map((kind) => ({
        OutputKey: `${kind}TableName`,
        OutputValue: `${name}-${kind}ABC123-synthetic`,
      })),
    ],
    Tags: Object.entries(cloudStackTags("staging")).map(([Key, Value]) => ({ Key, Value })),
  };
}
function platformInspection(request: ProcessRequest): boolean {
  return (
    request.args.includes("describe-stacks") &&
    request.args.includes("Stacks[0]") &&
    request.args.some((arg) => arg.startsWith("tenkacloud-cloud"))
  );
}
function mockResponse(request: ProcessRequest): ProcessResult {
  if (request.args.includes("get-caller-identity"))
    return { code: 0, stdout: "123456789012\n", stderr: "" };
  if (platformInspection(request)) {
    const name = request.args[request.args.indexOf("--stack-name") + 1] ?? "";
    return { code: 0, stdout: JSON.stringify(ownedStack(name)), stderr: "" };
  }
  if (
    request.command === "aws" &&
    request.args.includes("describe-stacks") &&
    request.args.some((arg) => arg.startsWith("TenkaCloudToolkit-"))
  )
    return { code: 0, stdout: JSON.stringify(ownedToolkit()), stderr: "" };
  if (request.args.join(" ") === "configure get region")
    return { code: 0, stdout: "ap-northeast-1\n", stderr: "" };
  if (request.args.includes("admin-get-user"))
    return { code: 1, stdout: "", stderr: "UserNotFoundException" };
  return outputResponse(request);
}
function outputResponse(request: ProcessRequest): ProcessResult {
  let stdout = "";
  if (request.args.includes("describe-stacks")) {
    const query = request.args[request.args.indexOf("--query") + 1] ?? "";
    if (query.includes("OrganizerUserPoolId")) stdout = "ap-northeast-1_pool\n";
    else if (query.includes("ApplicationAdminConsoleUrl"))
      stdout = "https://console.example.test\n";
    else if (query.includes("ParticipantPortalApiUrl")) stdout = "https://portal.example.test\n";
    else stdout = "CREATE_COMPLETE\n";
  }
  return { code: 0, stdout, stderr: "" };
}
function invalidStackResponse(name: string, change: string): ProcessResult {
  if (change === "denied") return { code: 1, stdout: "", stderr: "AccessDeniedException" };
  const stack = ownedStack(name);
  if (change === "tags") stack.Tags = [];
  if (change === "environment")
    stack.Tags = [
      { Key: "TenkaCloudProject", Value: "cloud-hosting" },
      { Key: "Environment", Value: "other" },
    ];
  if (change === "account") stack.StackId = stack.StackId.replace("123456789012", "210987654321");
  if (change === "region") stack.StackId = stack.StackId.replace("ap-northeast-1", "us-east-1");
  if (change === "name") stack.StackName = "unrelated";
  return { code: 0, stdout: change === "malformed" ? "{}" : JSON.stringify(stack), stderr: "" };
}
function phaseMatches(request: ProcessRequest, phase: string): boolean {
  if (phase === "resolve") return request.args.includes("get-caller-identity");
  if (phase === "prepare") return request.command === "bun";
  if (phase === "toolkit") return request.args.includes("TenkaCloudToolkit-staging");
  return request.args.includes(phase);
}
function fixture(
  options: {
    confirmed?: boolean;
    toolkitMissing?: boolean;
    fail?: (request: ProcessRequest) => ProcessResult | undefined;
    installation?: CloudInstallation;
  } = {},
) {
  const calls: ProcessRequest[] = [];
  const messages: string[] = [];
  const errors: string[] = [];
  const confirmations: string[] = [];
  const storageCalls: string[] = [];
  const locations: InstallationLocation[] = [];
  let toolkitInstalled = !options.toolkitMissing;
  let control: InstallationControl | undefined;
  const installation: CloudInstallation = options.installation ?? {
    repository: {
      installationControl: async () => control,
      assertAcceptingInstallation: async () => {
        storageCalls.push("assert-accepting");
        if (control) throw new Error("installation_draining");
      },
      stopAcceptingInstallation: async (scope: InstallationScope, at: string) => {
        storageCalls.push("stop");
        control ??= {
          scope,
          scopeDigest: installationScopeDigest(scope),
          status: "DRAINING",
          startedAt: at,
          updatedAt: at,
        };
        return control;
      },
      listStoppedInstallationEvents: async () => {
        storageCalls.push("list");
        return [];
      },
      confirmInstallationDrained: async () => {
        storageCalls.push("drained");
        if (!control) throw new Error("Missing fence");
        control = { ...control, status: "DRAINED" };
      },
    },
    requestEventTeardown: async () => ({ failed: 0 }),
    close: () => storageCalls.push("close"),
  };
  const io: CloudCliIo = {
    run: async (request) => {
      calls.push(structuredClone(request));
      const failure = options.fail?.(request);
      if (failure) return failure;
      if (request.args.includes("TenkaCloudToolkit-staging")) {
        if (request.args.includes("create-stack")) toolkitInstalled = true;
        if (request.args.includes("describe-stacks") && !toolkitInstalled)
          return {
            code: 1,
            stdout: "",
            stderr:
              "An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id TenkaCloudToolkit-staging does not exist",
          };
      }
      return mockResponse(request);
    },
    stdout: (value) => messages.push(value),
    stderr: (value) => errors.push(value),
    confirm: async (question) => {
      confirmations.push(question);
      return options.confirmed ?? false;
    },
    openInstallation: (location) => {
      locations.push(location);
      return installation;
    },
    now: () => Date.parse("2026-10-01T14:00:00.000Z"),
    wait: async () => {
      throw new Error("Unexpected wait in CLI fixture");
    },
  };
  const env = {
    TENKACLOUD_ADMIN_EMAIL: "organizer@example.test",
    TENKACLOUD_CFN_EXECUTION_POLICY_ARN: POLICY,
    CDK_PARAM_ENVIRONMENT: "staging",
    AWS_REGION: "ap-northeast-1",
    ACCOUNT_ID: "123456789012",
  };
  return {
    io,
    calls,
    messages,
    errors,
    confirmations,
    storageCalls,
    locations,
    installation,
    env,
    run: (args: readonly string[]) => runCloudCli(args, io, { root: ROOT, env }),
  };
}

describe("cloud CLI injected subprocess contract: never invokes AWS/CDK in tests", () => {
  it("prints cloud help without resolving credentials or importing the CDK app", async () => {
    const f = fixture();
    expect(await f.run([])).toBe(0);
    expect(f.calls).toEqual([]);
    expect(f.messages.join("")).toContain("TenkaCloud cloud hosting");
    expect(f.messages.join("")).not.toContain("Lite");
  });
  it.each(["up", "down"])("shows %s help without AWS or storage access", async (command) => {
    const f = fixture();
    expect(await f.run([command, "--help"])).toBe(0);
    expect(f.calls).toEqual([]);
    expect(f.storageCalls).toEqual([]);
    expect(f.messages.join("")).toContain("make deploy");
    expect(f.messages.join("")).toContain("make destroy");
  });
  it("preflights the installed toolkit then builds, deploys and prepares the organizer without IAM setup", async () => {
    const f = fixture();
    expect(await f.run(["up"])).toBe(0);
    expect(f.calls[0]?.args).toContain("get-caller-identity");
    expect(f.calls[1]?.args).toContain("get-caller-identity");
    expect(f.calls.slice(2, 4).every(platformInspection)).toBe(true);
    expect(f.calls[4]?.command).toBe("aws");
    expect(f.calls.slice(5, 7).map((call) => [call.command, ...call.args])).toEqual([
      ["bun", "run", "--cwd", `${ROOT}/apps/application-admin-console`, "build"],
      ["bun", "run", "--cwd", `${ROOT}/apps/participant-portal`, "build"],
    ]);
    expect(f.calls[7]?.args.slice(2)).toEqual([
      "deploy",
      "tenkacloud-cloud-problem-deploy-staging",
      "tenkacloud-cloud-staging",
      "--require-approval",
      "never",
    ]);
    expect(
      f.calls.some(
        (call) =>
          call.args.includes("bootstrap") ||
          call.args.includes("create-stack") ||
          call.args.includes("update-stack"),
      ),
    ).toBe(false);
    expect(f.calls.every((call) => !["bash", "git", "zip", "rsync"].includes(call.command))).toBe(
      true,
    );
    expect(f.calls.some((call) => call.args.includes("s3api"))).toBe(false);
    expect(f.calls.some((call) => call.env.CDK_PARAM_S3_BUCKET_NAME !== undefined)).toBe(false);
    expect(f.calls.slice(1).every((call) => call.env.AWS_DEFAULT_REGION === "ap-northeast-1")).toBe(
      true,
    );
    const create = f.calls.find((call) => call.args.includes("admin-create-user"));
    expect(create?.args).toContain("Name=custom:userRole,Value=Admin");
    expect(create?.args.join(" ")).not.toContain("tenant");
    expect(f.messages.join("")).toContain("https://console.example.test");
    expect(f.messages.join("")).toContain("https://portal.example.test");
    expect(f.messages.join("")).toContain("hello-world with scoped participant AWS CLI access");
    expect(f.messages.join("")).toContain("native Cryptography Battle backed by DynamoDB");
    expect(f.messages.join("")).toContain("AWS usage and retained storage can incur charges");
    expect(f.messages.join("")).not.toContain("full competition lifecycle remains incomplete");
    expect(f.env).toEqual({
      TENKACLOUD_ADMIN_EMAIL: "organizer@example.test",
      TENKACLOUD_CFN_EXECUTION_POLICY_ARN: POLICY,
      CDK_PARAM_ENVIRONMENT: "staging",
      AWS_REGION: "ap-northeast-1",
      ACCOUNT_ID: "123456789012",
    });
  });
  it("requires the organizer identity before any remote setup", async () => {
    const f = fixture();
    expect(await runCloudCli(["up"], f.io, { root: ROOT, env: {} })).toBe(1);
    expect(f.calls).toEqual([]);
    expect(f.errors.join("")).toContain("TENKACLOUD_ADMIN_EMAIL");
    expect(f.errors.join("")).toContain("infrastructure/environments/development/.env.example");
    expect(f.errors.join("")).toContain("--show-setup");
  });
  it("uses the selected file for offline setup and ordinary deployment without modifying it", async () => {
    const root = mkdtempSync(join(tmpdir(), "tenkacloud-cli-env-"));
    const directory = join(root, "infrastructure/environments/staging");
    const source =
      "ENV=staging\nTENKACLOUD_ADMIN_EMAIL=file@example.test\nACCOUNT_ID=123456789012\nAWS_REGION=ap-northeast-1\n";
    try {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, ".env"), source);
      const preview = fixture();
      expect(
        await runCloudCli(["up", "--show-setup"], preview.io, { root, env: { ENV: "staging" } }),
      ).toBe(0);
      expect(preview.calls).toEqual([]);
      expect(preview.messages.join("")).toContain("TenkaCloudToolkit-staging");
      const deploy = fixture();
      expect(await runCloudCli(["up"], deploy.io, { root, env: { ENV: "staging" } })).toBe(0);
      expect(deploy.calls.every((call) => call.env.ENV === "staging")).toBe(true);
      const invitation = deploy.calls.find((call) => call.args.includes("admin-create-user"));
      expect(invitation?.args).toContain("file@example.test");
      expect(readFileSync(join(directory, ".env"), "utf8")).toBe(source);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it.each(["resolve", "prepare", "toolkit", "deploy"])("halts after %s fails", async (phase) => {
    const f = fixture({
      fail: (request) => {
        const matches = phaseMatches(request, phase);
        return matches ? { code: 42, stdout: "", stderr: "specific failure" } : undefined;
      },
    });
    expect(await f.run(["up"])).toBe(1);
    expect(f.errors.join("")).toContain("specific failure");
    expect(f.calls.some((call) => call.args.includes("admin-create-user"))).toBe(false);
  });
  it("never creates an organizer when lookup failed for a reason other than missing user", async () => {
    const f = fixture({
      fail: (request) =>
        request.args.includes("admin-get-user")
          ? { code: 1, stdout: "", stderr: "AccessDeniedException" }
          : undefined,
    });
    expect(await f.run(["up"])).toBe(1);
    expect(f.calls.some((call) => call.args.includes("admin-create-user"))).toBe(false);
  });
  it("keeps an existing organizer rather than reassigning their role", async () => {
    const f = fixture({
      fail: (request) =>
        request.args.includes("admin-get-user") ? { code: 0, stdout: "{}", stderr: "" } : undefined,
    });
    expect(await f.run(["up"])).toBe(0);
    expect(f.calls.some((call) => call.args.includes("admin-create-user"))).toBe(false);
  });
  it("fails when required stack outputs are missing instead of claiming success", async () => {
    const f = fixture({
      fail: (request) =>
        request.args.some((arg) => arg.includes("ApplicationAdminConsoleUrl"))
          ? { code: 0, stdout: "None", stderr: "" }
          : undefined,
    });
    expect(await f.run(["up"])).toBe(1);
    expect(f.messages.join("")).not.toContain("Cloud hosting deployed");
  });
  it("resolves and validates both stacks before asking for exact teardown confirmation", async () => {
    const f = fixture();
    expect(await f.run(["down"])).toBe(0);
    expect(f.confirmations).toHaveLength(1);
    expect(f.calls).toHaveLength(4);
    expect(f.calls.slice(2).every(platformInspection)).toBe(true);
    expect(f.calls.some((call) => call.inherit)).toBe(false);
    expect(f.storageCalls).toEqual(["close"]);
    expect(f.confirmations[0]).toContain("123456789012");
    expect(f.confirmations[0]).toContain("ap-northeast-1");
    expect(f.confirmations[0]).toContain(ownedStack("tenkacloud-cloud-staging").StackId);
    expect(f.confirmations[0]).toContain(
      ownedStack("tenkacloud-cloud-problem-deploy-staging").StackId,
    );
    expect(f.confirmations[0]).toContain("separately deployed exercise resources");
  });
  it.each([{ args: [] }, { args: ["--yes"] }])(
    "drains recorded events before deleting verified app and backend ARNs: %s",
    async ({ args }) => {
      const f = fixture({ confirmed: true });
      expect(await f.run(["down", ...args])).toBe(0);
      expect(f.calls).toHaveLength(8);
      expect(f.storageCalls).toEqual(["stop", "list", "list", "drained", "close"]);
      const deletes = f.calls.filter((call) => call.args.includes("delete-stack"));
      expect(deletes.map((call) => call.args[call.args.indexOf("--stack-name") + 1])).toEqual([
        ownedStack("tenkacloud-cloud-staging").StackId,
        ownedStack("tenkacloud-cloud-problem-deploy-staging").StackId,
      ]);
      expect(f.calls.filter((call) => call.args.includes("stack-delete-complete"))).toHaveLength(2);
      expect(f.calls.some((call) => call.inherit || call.command === "bun")).toBe(false);
      expect(f.messages.join("")).toContain("not purged");
    },
  );
  it("stops teardown when the dependent app stack could not be destroyed", async () => {
    const f = fixture({
      confirmed: true,
      fail: (request) =>
        request.args.includes("delete-stack")
          ? { code: 3, stdout: "", stderr: "destroy failure" }
          : undefined,
    });
    expect(await f.run(["down"])).toBe(1);
    expect(f.calls).toHaveLength(5);
    expect(f.storageCalls).toContain("drained");
  });
  it.each(["up", "down"])(
    "%s rejects a caller-account mismatch before inspecting or mutating stacks",
    async (command) => {
      const f = fixture({
        confirmed: true,
        fail: (request) =>
          request.args.includes("get-caller-identity")
            ? { code: 0, stdout: "210987654321", stderr: "" }
            : undefined,
      });
      expect(await f.run([command])).toBe(1);
      expect(f.calls).toHaveLength(1);
      expect(f.errors.join("")).toContain("credentials do not match");
      expect(f.confirmations).toEqual([]);
    },
  );
  it.each(["up", "down"])(
    "%s checks both stacks and rejects unknown ownership before any mutation",
    async (command) => {
      for (const name of Object.values(cloudStackNames("staging"))) {
        for (const change of [
          "tags",
          "environment",
          "account",
          "region",
          "name",
          "malformed",
          "denied",
        ] as const) {
          const f = fixture({
            confirmed: true,
            fail: (request) => {
              if (!platformInspection(request) || !request.args.includes(name)) return undefined;
              return invalidStackResponse(name, change);
            },
          });
          expect(await f.run([command])).toBe(1);
          expect(f.calls.some((call) => call.inherit)).toBe(false);
          expect(f.calls.some((call) => phaseMatches(call, "prepare"))).toBe(false);
          expect(f.confirmations).toEqual([]);
          expect(f.storageCalls).toEqual([]);
        }
      }
    },
  );
  it.each(["up", "down"])(
    "%s distinguishes an explicitly absent stack from denied or unknown state",
    async (command) => {
      const f = fixture({
        confirmed: true,
        fail: (request) => {
          if (!platformInspection(request)) return undefined;
          const name = request.args[request.args.indexOf("--stack-name") + 1] ?? "";
          return {
            code: 1,
            stdout: "",
            stderr: `An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id ${name} does not exist`,
          };
        },
      });
      expect(await f.run([command])).toBe(0);
      if (command === "down") {
        expect(f.messages.join("")).toContain("already absent");
        expect(f.calls.some((call) => call.inherit)).toBe(false);
        expect(f.confirmations).toEqual([]);
      }
    },
  );
  it.each(["up", "down"])(
    "%s fails closed for missing, malformed or ambiguous runner metadata",
    async (command) => {
      for (const values of [[], ["unknown"], ["false", "true"]]) {
        const f = fixture({
          confirmed: true,
          fail: (request) => {
            if (!platformInspection(request) || !request.args.includes("tenkacloud-cloud-staging"))
              return undefined;
            return {
              code: 0,
              stderr: "",
              stdout: JSON.stringify({
                ...ownedStack("tenkacloud-cloud-staging"),
                Outputs: values.map((OutputValue) => ({
                  OutputKey: "CloudRunnerEnabled",
                  OutputValue,
                })),
              }),
            };
          },
        });
        expect(await f.run([command])).toBe(1);
        expect(f.calls.some((call) => call.inherit)).toBe(false);
        expect(f.confirmations).toEqual([]);
      }
    },
  );
  it("refuses an unversioned legacy runner update or teardown, even with --yes", async () => {
    const f = fixture({
      confirmed: true,
      fail: (request) =>
        platformInspection(request) && request.args.includes("tenkacloud-cloud-staging")
          ? {
              code: 0,
              stderr: "",
              stdout: JSON.stringify({
                ...ownedStack("tenkacloud-cloud-staging"),
                Outputs: [{ OutputKey: "CloudRunnerEnabled", OutputValue: "true" }],
              }),
            }
          : undefined,
    });
    expect(await f.run(["up"])).toBe(1);
    expect(f.errors.join("")).toContain("CloudRunnerMode");
    expect(await f.run(["down", "--yes"])).toBe(1);
    expect(f.errors.join("")).toContain("durable intake-fence version");
    expect(f.calls.some((call) => call.inherit)).toBe(false);
  });
  it("permits explicit activation from a runner-disabled foundation and rejects invalid configuration before reads", async () => {
    const f = fixture();
    const binding = [
      {
        id: "reviewed-fixture",
        accountId: "123456789012",
        region: "ap-northeast-1",
        roleArn: "arn:aws:iam::123456789012:role/Fixture",
        externalIdParameterArn:
          "arn:aws:ssm:ap-northeast-1:123456789012:parameter/tenkacloud/fixture",
        reviewedProblemIds: ["hello-world"],
      },
    ];
    expect(
      await runCloudCli(["up"], f.io, {
        root: ROOT,
        env: { ...f.env, TENKACLOUD_RUNNER_BINDINGS: JSON.stringify(binding) },
      }),
    ).toBe(0);
    const invalid = fixture();
    expect(
      await runCloudCli(["up"], invalid.io, {
        root: ROOT,
        env: { ...invalid.env, TENKACLOUD_RUNNER_BINDINGS: "[]" },
      }),
    ).toBe(1);
    expect(invalid.calls).toEqual([]);
  });
  it.each(["status", "console-url", "portal-url"])(
    "supports read-only %s with matching environment stack names",
    async (command) => {
      const f = fixture();
      expect(await f.run([command])).toBe(0);
      expect(f.calls[0]?.args).toContain("get-caller-identity");
      expect(
        f.calls
          .slice(1)
          .every((call) => call.command === "aws" && call.args.includes("describe-stacks")),
      ).toBe(true);
      expect(
        f.calls.slice(1).every((call) => call.args.some((arg) => arg.endsWith("-staging"))),
      ).toBe(true);
    },
  );
  it.each(["status", "console-url", "portal-url"])(
    "%s uses the deployment's explicit region and rejects a different caller account",
    async (command) => {
      const f = fixture();
      const env = { ...f.env, REGION: "us-east-1", AWS_REGION: "ap-northeast-1" };
      expect(await runCloudCli([command], f.io, { root: ROOT, env })).toBe(0);
      expect(f.calls[0]?.args.slice(-2)).toEqual(["--region", "us-east-1"]);
      for (const call of f.calls.slice(1)) {
        expect(call.env.AWS_REGION).toBe("us-east-1");
        expect(call.env.AWS_DEFAULT_REGION).toBe("us-east-1");
      }
      expect(env.AWS_REGION).toBe("ap-northeast-1");
      expect(f.calls.some((call) => call.inherit)).toBe(false);

      const wrongAccount = fixture({
        fail: (request) =>
          request.args.includes("get-caller-identity")
            ? { code: 0, stdout: "210987654321", stderr: "" }
            : undefined,
      });
      expect(await wrongAccount.run([command])).toBe(1);
      expect(wrongAccount.calls).toHaveLength(1);
      expect(wrongAccount.errors.join("")).toContain("credentials do not match");
    },
  );
  it.each([
    { args: ["unknown"] },
    { args: ["up", "--force"] },
    { args: ["up", "--setup", "--setup-if-needed"] },
    { args: ["up", "--show-setup", "--yes"] },
    { args: ["down", "--setup-if-needed"] },
    { args: ["down", "--purge-retained-data"] },
    { args: ["status", "--yes"] },
  ])("rejects unsupported commands without effects: %s", async ({ args }) => {
    const f = fixture();
    expect(await f.run(args)).toBe(1);
    expect(f.calls).toEqual([]);
  });
  it("uses only the source-reviewed generated policy when no custom execution ARN is supplied", async () => {
    const f = fixture();
    expect(
      await runCloudCli(["up"], f.io, {
        root: ROOT,
        env: { ...f.env, TENKACLOUD_CFN_EXECUTION_POLICY_ARN: undefined },
      }),
    ).toBe(0);
    expect(
      f.calls.some((call) => call.args.includes("bootstrap") || call.args.includes("create-stack")),
    ).toBe(false);
  });
  it("inspects account-specific setup without credentials, AWS calls or organizer email", async () => {
    const f = fixture();
    expect(
      await runCloudCli(["up", "--show-setup"], f.io, {
        root: ROOT,
        env: { ACCOUNT_ID: "123456789012", AWS_REGION: "ap-northeast-1", ENV: "staging" },
      }),
    ).toBe(0);
    expect(f.calls).toEqual([]);
    expect(f.messages.join("")).toContain("TenkaCloud cloud-hosting v1");
    expect(f.messages.join("")).not.toContain("AdministratorAccess");
  });
  it.each([{ args: [] }, { args: ["--yes"] }])(
    "stops before IAM writes or builds when initial setup is declined: %s",
    async ({ args }) => {
      const f = fixture({ toolkitMissing: true });
      expect(await f.run(["up", ...args])).toBe(1);
      expect(f.confirmations).toHaveLength(1);
      expect(f.errors.join("")).toContain("--show-setup");
      expect(f.calls.some((call) => call.inherit || call.args.includes("create-stack"))).toBe(
        false,
      );
    },
  );
  it.each([
    { args: [], ci: undefined, prompts: 1 },
    { args: ["--yes"], ci: undefined, prompts: 1 },
    { args: ["--setup-if-needed", "--yes"], ci: "true", prompts: 0 },
  ])(
    "sets up a missing toolkit and completes the same deploy: %s",
    async ({ args, ci, prompts }) => {
      const f = fixture({ toolkitMissing: true, confirmed: true });
      expect(
        await runCloudCli(["up", ...args], f.io, { root: ROOT, env: { ...f.env, CI: ci } }),
      ).toBe(0);
      expect(f.confirmations).toHaveLength(prompts);
      const notice = f.messages.join("");
      for (const text of [
        "account 123456789012",
        "region ap-northeast-1",
        "environment staging",
        "IAM roles:",
        "Managed IAM policies:",
        "retained asset storage can incur charges",
        "environment names are not an IAM security boundary",
        "continues the application deployment with the same credentials",
      ])
        expect(notice).toContain(text);
      const identities = deploymentPolicies({
        account: "123456789012",
        region: "ap-northeast-1",
        environment: "staging",
      }).identities;
      expect(notice).toContain(identities.executionRoleArn);
      expect(notice).toContain(identities.operatorPolicyArn);
      expect(notice).toContain(identities.assetBucketName);
      const create = f.calls.findIndex((call) => call.args.includes("create-stack"));
      const wait = f.calls.findIndex((call) => call.args.includes("stack-create-complete"));
      const verify = f.calls.findIndex(
        (call, index) =>
          index > wait &&
          call.args.includes("TenkaCloudToolkit-staging") &&
          call.args.includes("describe-stacks"),
      );
      const build = f.calls.findIndex((call) => call.command === "bun");
      expect(create).toBeGreaterThan(0);
      expect(wait).toBeGreaterThan(create);
      expect(verify).toBeGreaterThan(wait);
      expect(build).toBeGreaterThan(verify);
      expect(f.calls[create]?.args).toContain("CAPABILITY_NAMED_IAM");
      expect(f.calls[create]?.args).toContain("--enable-termination-protection");
      expect(f.calls.some((call) => call.args.includes("deploy"))).toBe(true);
      expect(f.calls.some((call) => call.args.includes("admin-create-user"))).toBe(true);
      expect(
        f.calls.some((call) => call.args.includes("iam") || call.args.includes("update-stack")),
      ).toBe(false);
      expect(notice).toContain("https://console.example.test");
    },
  );
  it.each([{ args: [] }, { args: ["--yes"] }, { args: ["--setup-if-needed"] }])(
    "never prompts or treats ordinary CI deploy consent as initial IAM approval: %s",
    async ({ args }) => {
      const f = fixture({ toolkitMissing: true, confirmed: true });
      expect(
        await runCloudCli(["up", ...args], f.io, { root: ROOT, env: { ...f.env, CI: "true" } }),
      ).toBe(1);
      expect(f.confirmations).toEqual([]);
      expect(f.errors.join("")).toContain("--setup-if-needed --yes");
      expect(f.calls.some((call) => call.inherit || call.args.includes("create-stack"))).toBe(
        false,
      );
    },
  );
  it("validates an installed toolkit without changing IAM even with initial-setup opt-in", async () => {
    const f = fixture();
    expect(await f.run(["up", "--setup-if-needed", "--yes"])).toBe(0);
    expect(f.confirmations).toEqual([]);
    expect(
      f.calls.some(
        (call) => call.args.includes("create-stack") || call.args.includes("update-stack"),
      ),
    ).toBe(false);
  });
  it("deploys a fresh account with both platform stacks absent after confirmed toolkit setup", async () => {
    const f = fixture({
      toolkitMissing: true,
      confirmed: true,
      fail: (request) => {
        if (!platformInspection(request)) return undefined;
        const name = request.args[request.args.indexOf("--stack-name") + 1] ?? "";
        return {
          code: 1,
          stdout: "",
          stderr: `An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id ${name} does not exist`,
        };
      },
    });
    expect(await f.run(["up"])).toBe(0);
    expect(f.confirmations).toHaveLength(1);
    expect(f.storageCalls).toEqual([]);
    expect(f.calls.filter((call) => call.args.includes("create-stack"))).toHaveLength(1);
    expect(f.calls.some((call) => call.args.includes("deploy"))).toBe(true);
  });
  it("retains verified setup after a deploy failure and reuses it on retry", async () => {
    let failDeploy = true;
    const f = fixture({
      toolkitMissing: true,
      confirmed: true,
      fail: (request) =>
        failDeploy && request.args.includes("deploy")
          ? { code: 1, stdout: "", stderr: "AccessDenied: synthetic operator failure" }
          : undefined,
    });
    expect(await f.run(["up"])).toBe(1);
    expect(f.errors.join("")).toContain("staging-ap-northeast-1-operator");
    expect(f.errors.join("")).toContain("synthetic operator failure");
    expect(f.calls.some((call) => call.args.includes("delete-stack"))).toBe(false);
    failDeploy = false;
    expect(await f.run(["up"])).toBe(0);
    expect(f.confirmations).toHaveLength(1);
    expect(f.calls.filter((call) => call.args.includes("create-stack"))).toHaveLength(1);
    expect(
      f.calls.some((call) => call.args.includes("update-stack") || call.args.includes("iam")),
    ).toBe(false);
  });
  it("does not update a matching toolkit installed between the missing check and setup", async () => {
    let inspected = false;
    const f = fixture({
      fail: (request) => {
        if (!inspected && request.args.includes("TenkaCloudToolkit-staging")) {
          inspected = true;
          return {
            code: 1,
            stdout: "",
            stderr:
              "An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id TenkaCloudToolkit-staging does not exist",
          };
        }
        return undefined;
      },
    });
    expect(await f.run(["up"])).toBe(0);
    expect(f.confirmations).toEqual([]);
    expect(
      f.calls.some(
        (call) => call.args.includes("create-stack") || call.args.includes("update-stack"),
      ),
    ).toBe(false);
  });
  it.each(["create-stack", "stack-create-complete"])(
    "halts the combined deploy when initial %s fails",
    async (phase) => {
      const f = fixture({
        toolkitMissing: true,
        confirmed: true,
        fail: (request) =>
          request.args.includes(phase)
            ? { code: 1, stdout: "", stderr: "AccessDenied: synthetic initial setup denial" }
            : undefined,
      });
      expect(await f.run(["up"])).toBe(1);
      expect(f.errors.join("")).toContain("synthetic initial setup denial");
      if (phase === "create-stack")
        expect(f.errors.join("")).toContain("Metadata.TenkaCloudSetupPermissions");
      expect(f.calls.some((call) => call.inherit || call.args.includes("iam"))).toBe(false);
    },
  );
  it("does not build or claim success when the newly installed toolkit fails verification", async () => {
    let created = false;
    const f = fixture({
      toolkitMissing: true,
      confirmed: true,
      fail: (request) => {
        if (request.args.includes("create-stack")) created = true;
        if (
          created &&
          request.args.includes("describe-stacks") &&
          request.args.includes("TenkaCloudToolkit-staging")
        )
          return { code: 0, stdout: JSON.stringify({ Tags: [], Parameters: [] }), stderr: "" };
        return undefined;
      },
    });
    expect(await f.run(["up"])).toBe(1);
    expect(f.errors.join("")).toContain("refusing to modify");
    expect(f.calls.some((call) => call.inherit)).toBe(false);
  });
  it("explains the operator permission needed by a setup-only caller without granting it", async () => {
    const f = fixture({
      toolkitMissing: true,
      confirmed: true,
      fail: (request) =>
        platformInspection(request)
          ? { code: 1, stdout: "", stderr: "AccessDenied: cloudformation:DescribeStacks" }
          : undefined,
    });
    expect(await f.run(["up"])).toBe(1);
    expect(f.errors.join("")).toContain("cloudformation:DescribeStacks");
    expect(f.errors.join("")).toContain("staging-ap-northeast-1-operator");
    expect(f.errors.join("")).toContain("switch to that profile and rerun make deploy ENV=staging");
    expect(f.confirmations).toEqual([]);
    expect(
      f.calls.some(
        (call) => call.inherit || call.args.includes("create-stack") || call.args.includes("iam"),
      ),
    ).toBe(false);
  });
  it("rejects a fresh-installation policy override before asking to create the toolkit", async () => {
    const f = fixture({ toolkitMissing: true, confirmed: true });
    expect(
      await runCloudCli(["up"], f.io, {
        root: ROOT,
        env: {
          ...f.env,
          TENKACLOUD_CFN_EXECUTION_POLICY_ARN:
            "arn:aws:iam::123456789012:policy/tenkacloud/cloud-hosting/other",
        },
      }),
    ).toBe(1);
    expect(f.errors.join("")).toContain("Leave TENKACLOUD_CFN_EXECUTION_POLICY_ARN unset");
    expect(f.confirmations).toEqual([]);
    expect(f.calls.some((call) => call.inherit || call.args.includes("create-stack"))).toBe(false);
  });
  it("requires explicit setup confirmation and never treats non-interactive refusal as approval", async () => {
    const f = fixture();
    expect(await f.run(["up", "--setup"])).toBe(1);
    expect(f.confirmations).toHaveLength(1);
    expect(f.messages.join("")).toContain("origin access controls");
    expect(f.messages.join("")).toContain("log delivery");
    expect(f.messages.join("")).toContain("environment names are not an IAM security boundary");
    expect(f.errors.join("")).toContain("setup cancelled");
    expect(f.calls.some((call) => call.args.includes("update-stack") || call.inherit)).toBe(false);
  });
  it("installs only the project toolkit, then ordinary deploy uses it without setup privileges", async () => {
    let created = false;
    const f = fixture({
      confirmed: true,
      fail: (request) => {
        if (request.args.includes("create-stack")) created = true;
        if (
          request.args.includes("describe-stacks") &&
          request.args.includes("TenkaCloudToolkit-staging") &&
          !created
        )
          return {
            code: 1,
            stdout: "",
            stderr:
              "An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id TenkaCloudToolkit-staging does not exist",
          };
        return undefined;
      },
    });
    expect(await f.run(["up", "--setup"])).toBe(0);
    const create = f.calls.find((call) => call.args.includes("create-stack"));
    expect(create?.args).toContain("TenkaCloudToolkit-staging");
    expect(create?.args).toContain("CAPABILITY_NAMED_IAM");
    expect(create?.args).toContain("--enable-termination-protection");
    const body = create?.args[(create?.args.indexOf("--template-body") ?? -1) + 1] ?? "";
    expect(body.length).toBeLessThanOrEqual(51200);
    expect(body).not.toContain("AdministratorAccess");
    expect(body).toContain("TenkaCloud cloud-hosting v1");
    const wait = f.calls.findIndex((call) => call.args.includes("stack-create-complete"));
    expect(wait).toBeGreaterThan(0);
    expect(f.calls.some((call) => call.command === "bun")).toBe(false);
    const setupCalls = f.calls.length;
    expect(await f.run(["up"])).toBe(0);
    expect(f.calls.slice(setupCalls).some((call) => call.command === "bun")).toBe(true);
    expect(
      f.calls
        .slice(setupCalls)
        .some((call) => call.args.includes("create-stack") || call.args.includes("update-stack")),
    ).toBe(false);
    expect(f.calls.some((call) => call.args.includes("CDKToolkit"))).toBe(false);
  });
  it("fails setup without starting builds when IAM installation or verification fails", async () => {
    for (const failure of ["update-stack", "stack-update-complete"]) {
      const f = fixture({
        confirmed: true,
        fail: (request) =>
          request.args.includes(failure)
            ? { code: 1, stdout: "", stderr: "Synthetic setup failure" }
            : undefined,
      });
      expect(await f.run(["up", "--setup"])).toBe(1);
      expect(f.calls.some((call) => call.inherit)).toBe(false);
    }
  });
  it("handles a repeated unchanged setup without waiting for a nonexistent update", async () => {
    const f = fixture({
      confirmed: true,
      fail: (request) =>
        request.args.includes("update-stack")
          ? {
              code: 1,
              stdout: "",
              stderr: "An error occurred (ValidationError): No updates are to be performed.",
            }
          : undefined,
    });
    expect(await f.run(["up", "--setup"])).toBe(0);
    expect(f.calls.some((call) => call.args.includes("stack-update-complete"))).toBe(false);
  });
  it("stops before upload or bootstrap when a similarly named toolkit has unrelated ownership", async () => {
    const f = fixture({
      fail: (request) =>
        request.command === "aws" &&
        request.args.some((arg) => arg.startsWith("TenkaCloudToolkit-"))
          ? { code: 0, stdout: JSON.stringify({ Tags: [], Parameters: [] }), stderr: "" }
          : undefined,
    });
    expect(await f.run(["up"])).toBe(1);
    expect(f.calls).toHaveLength(5);
    expect(f.calls.some((call) => call.inherit)).toBe(false);
    expect(f.errors.join("")).toContain("refusing to modify");
  });
  it.each([
    "AccessDeniedException",
    "Stack does not exist",
    "An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id CDKToolkit does not exist",
  ])("does not treat an unknown toolkit read failure as absence: %s", async (stderr) => {
    const f = fixture({
      fail: (request) =>
        request.args.includes("TenkaCloudToolkit-staging")
          ? { code: 1, stdout: "", stderr }
          : undefined,
    });
    expect(await f.run(["up"])).toBe(1);
    expect(f.calls.some((call) => call.inherit)).toBe(false);
    expect(f.calls.some((call) => phaseMatches(call, "prepare"))).toBe(false);
  });
  it("rejects a managed administrator policy or a policy for a different account", async () => {
    const f = fixture();
    expect(
      await runCloudCli(["up"], f.io, {
        root: ROOT,
        env: {
          ...f.env,
          TENKACLOUD_CFN_EXECUTION_POLICY_ARN: "arn:aws:iam::aws:policy/AdministratorAccess",
        },
      }),
    ).toBe(1);
    expect(f.calls).toEqual([]);
    expect(
      await runCloudCli(["up"], f.io, {
        root: ROOT,
        env: {
          ...f.env,
          TENKACLOUD_CFN_EXECUTION_POLICY_ARN: POLICY.replaceAll("123456789012", "210987654321"),
        },
      }),
    ).toBe(1);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.args).toContain("get-caller-identity");
  });
  it("refuses to modify unrelated project toolkit configuration", () => {
    expect(() =>
      assertOwnedBootstrap(JSON.stringify({ Tags: [], Parameters: [] }), "staging", POLICY),
    ).toThrow("refusing");
    expect(() =>
      assertOwnedBootstrap(
        JSON.stringify({
          Tags: [
            { Key: "TenkaCloudProject", Value: "cloud-hosting" },
            { Key: "Environment", Value: "staging" },
          ],
          Parameters: [
            { ParameterKey: "Qualifier", ParameterValue: projectBootstrap("staging").qualifier },
            { ParameterKey: "CloudFormationExecutionPolicies", ParameterValue: POLICY },
            { ParameterKey: "BootstrapVariant", ParameterValue: "TenkaCloud cloud-hosting v1" },
            { ParameterKey: "TrustedAccounts", ParameterValue: "" },
            { ParameterKey: "TrustedAccountsForLookup", ParameterValue: "" },
          ],
        }),
        "staging",
        POLICY,
      ),
    ).not.toThrow();
  });
  it("rejects unsafe environment names", () => {
    expect(cloudStackNames("development")).toEqual({
      app: "tenkacloud-cloud",
      backend: "tenkacloud-cloud-problem-deploy",
    });
    expect(() => cloudStackNames("development;bad")).toThrow();
  });
  it.each(["invalid", "123456789012\nAWS_SECRET_ACCESS_KEY=synthetic"])(
    "rejects malformed account output instead of copying arbitrary environment data: %s",
    async (value) => {
      const f = fixture({
        fail: (request) =>
          request.args.includes("get-caller-identity")
            ? { code: 0, stdout: value, stderr: "" }
            : undefined,
      });
      expect(await f.run(["up"])).toBe(1);
      expect(f.calls.some((call) => call.inherit)).toBe(false);
      expect(f.errors.join("")).toContain("invalid deployment account");
    },
  );
  it("resolves a profile region only when an explicit region is absent", async () => {
    const f = fixture();
    expect(
      await runCloudCli(["up"], f.io, { root: ROOT, env: { ...f.env, AWS_REGION: undefined } }),
    ).toBe(0);
    expect(f.calls[0]?.args).toEqual(["configure", "get", "region"]);
    expect(f.calls[1]?.args).toContain("ap-northeast-1");
  });
  it.each(["", "us-gov-west-1", "not-a-region"])(
    "rejects an absent or unsupported profile region: %s",
    async (region) => {
      const f = fixture({
        fail: (request) =>
          request.args.join(" ") === "configure get region"
            ? { code: 0, stdout: region, stderr: "" }
            : undefined,
      });
      expect(
        await runCloudCli(["up"], f.io, { root: ROOT, env: { ...f.env, AWS_REGION: undefined } }),
      ).toBe(1);
      expect(f.calls).toHaveLength(1);
    },
  );
  it("preserves the pipeline's selected environment and refuses conflicting selectors", async () => {
    const f = fixture();
    expect(
      await runCloudCli(["up"], f.io, {
        root: ROOT,
        env: { ...f.env, CDK_PARAM_ENVIRONMENT: undefined, ENV: "staging" },
      }),
    ).toBe(0);
    expect(f.calls.every((call) => call.env.ENV === "staging")).toBe(true);
    const conflict = fixture();
    expect(
      await runCloudCli(["up"], conflict.io, {
        root: ROOT,
        env: { ...conflict.env, ENV: "production" },
      }),
    ).toBe(1);
    expect(conflict.calls).toEqual([]);
  });
});

describe("cloud CLI durable teardown recovery and registry updates", () => {
  const app = "tenkacloud-cloud-staging";
  const backend = "tenkacloud-cloud-problem-deploy-staging";
  function missing(name: string): ProcessResult {
    return {
      code: 1,
      stdout: "",
      stderr: `An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id ${name} does not exist`,
    };
  }
  it("resumes backend deletion after the app was removed and the first backend delete failed", async () => {
    let resumed = false;
    const f = fixture({
      confirmed: true,
      fail: (request) => {
        if (resumed && platformInspection(request) && request.args.includes(app))
          return missing(app);
        if (
          !resumed &&
          request.args.includes("delete-stack") &&
          request.args.includes(ownedStack(backend).StackId)
        )
          return { code: 3, stdout: "", stderr: "Synthetic backend failure" };
        return undefined;
      },
    });
    expect(await f.run(["down", "--yes"])).toBe(1);
    expect((await f.installation.repository.installationControl())?.status).toBe("DRAINED");
    resumed = true;
    const before = f.calls.length;
    expect(await f.run(["down", "--yes"])).toBe(0);
    expect(
      f.calls
        .slice(before)
        .filter((call) => call.args.includes("delete-stack"))
        .map((call) => call.args[call.args.indexOf("--stack-name") + 1]),
    ).toEqual([ownedStack(backend).StackId]);
  });
  it.each([app, backend])(
    "does not infer cleanup from missing %s without the durable completion proof",
    async (name) => {
      const f = fixture({
        confirmed: true,
        fail: (request) =>
          platformInspection(request) && request.args.includes(name) ? missing(name) : undefined,
      });
      expect(await f.run(["down", "--yes"])).toBe(1);
      expect(f.calls.some((call) => call.args.includes("delete-stack"))).toBe(false);
      expect(f.confirmations).toEqual([]);
    },
  );
  it("waits for a deletion already in progress instead of submitting another delete", async () => {
    const f = fixture({
      confirmed: true,
      fail: (request) =>
        platformInspection(request) && request.args.includes(app)
          ? {
              code: 0,
              stderr: "",
              stdout: JSON.stringify({ ...ownedStack(app), StackStatus: "DELETE_IN_PROGRESS" }),
            }
          : undefined,
    });
    expect(await f.run(["down", "--yes"])).toBe(0);
    expect(f.calls.filter((call) => call.args.includes("delete-stack"))).toHaveLength(1);
    expect(f.calls.find((call) => call.args.includes("delete-stack"))?.args).toContain(
      ownedStack(backend).StackId,
    );
    expect(f.calls.filter((call) => call.args.includes("stack-delete-complete"))).toHaveLength(2);
  });
  it("waits for an update to complete before stopping event intake", async () => {
    const f = fixture({
      confirmed: true,
      fail: (request) =>
        platformInspection(request) && request.args.includes(app)
          ? {
              code: 0,
              stderr: "",
              stdout: JSON.stringify({ ...ownedStack(app), StackStatus: "UPDATE_IN_PROGRESS" }),
            }
          : undefined,
    });
    expect(await f.run(["down", "--yes"])).toBe(1);
    expect(f.storageCalls).toEqual([]);
    expect(f.calls.some((call) => call.args.includes("delete-stack"))).toBe(false);
  });
  it("does not let up reopen an installation after a teardown failure", async () => {
    const f = fixture({
      confirmed: true,
      fail: (request) =>
        request.args.includes("delete-stack")
          ? { code: 3, stdout: "", stderr: "Synthetic delete failure" }
          : undefined,
    });
    expect(await f.run(["down", "--yes"])).toBe(1);
    const before = f.calls.length;
    expect(await f.run(["up"])).toBe(1);
    expect(f.errors.join("")).toContain("installation_draining");
    expect(f.calls.slice(before).some((call) => call.command === "bun" || call.inherit)).toBe(
      false,
    );
  });
  it.each(["Events", "Teams", "Deployments"])(
    "rejects an unrelated %s table output",
    async (kind) => {
      const f = fixture({
        confirmed: true,
        fail: (request) =>
          platformInspection(request) && request.args.includes(backend)
            ? {
                code: 0,
                stderr: "",
                stdout: JSON.stringify({
                  ...ownedStack(backend),
                  Outputs: ownedStack(backend).Outputs.map((entry) =>
                    entry.OutputKey === `${kind}TableName`
                      ? { ...entry, OutputValue: "unrelated-table" }
                      : entry,
                  ),
                }),
              }
            : undefined,
      });
      expect(await f.run(["down", "--yes"])).toBe(1);
      expect(f.storageCalls).toEqual([]);
      expect(f.confirmations).toEqual([]);
    },
  );
  it("updates registry hosting without manual bindings while retaining the deployed empty-binding digest", async () => {
    const f = fixture({
      fail: (request) =>
        platformInspection(request) && request.args.includes(app)
          ? {
              code: 0,
              stderr: "",
              stdout: JSON.stringify({
                ...ownedStack(app),
                Outputs: [
                  { OutputKey: "CloudRunnerEnabled", OutputValue: "true" },
                  { OutputKey: "CloudRunnerMode", OutputValue: "registry" },
                  { OutputKey: "CloudLegacyBindingsDigest", OutputValue: contentDigest("[]") },
                ],
              }),
            }
          : undefined,
    });
    expect(await f.run(["up"])).toBe(0);
    expect(f.storageCalls).toContain("assert-accepting");
  });
  it("refuses to omit legacy bindings still required by the deployed runner", async () => {
    const f = fixture({
      fail: (request) =>
        platformInspection(request) && request.args.includes(app)
          ? {
              code: 0,
              stderr: "",
              stdout: JSON.stringify({
                ...ownedStack(app),
                Outputs: [
                  { OutputKey: "CloudRunnerEnabled", OutputValue: "true" },
                  { OutputKey: "CloudRunnerMode", OutputValue: "registry-with-legacy-bindings" },
                  { OutputKey: "CloudLegacyBindingsDigest", OutputValue: "a".repeat(64) },
                ],
              }),
            }
          : undefined,
    });
    expect(await f.run(["up"])).toBe(1);
    expect(f.errors.join("")).toContain("differs from the deployed legacy bindings");
    expect(f.calls.some((call) => call.inherit || call.command === "bun")).toBe(false);
  });
});

describe("native-aware cloud teardown contract", () => {
  function nativeStackResponse(
    request: ProcessRequest,
    alter?: (outputs: { OutputKey: string; OutputValue: string }[]) => void,
  ): ProcessResult | undefined {
    if (!platformInspection(request)) return undefined;
    const name = request.args[request.args.indexOf("--stack-name") + 1] ?? "";
    const stack = ownedStack(name);
    if (name === cloudStackNames("staging").app) {
      stack.Outputs = stack.Outputs.filter(
        (item) => item.OutputKey !== "CloudInstallationControlVersion",
      );
      stack.Outputs.push(
        { OutputKey: "CloudInstallationControlVersion", OutputValue: "2" },
        { OutputKey: "CloudExecutionArtifactBucket", OutputValue: "owned-native-artifacts" },
        { OutputKey: "CloudExecutionCatalogKey", OutputValue: `catalogs/${"a".repeat(64)}.json` },
      );
      alter?.(stack.Outputs);
    }
    return { code: 0, stdout: JSON.stringify(stack), stderr: "" };
  }
  it("passes the exact reviewed artifact identity and resolved account to native settlement", async () => {
    const f = fixture({ confirmed: true, fail: (request) => nativeStackResponse(request) });
    expect(await f.run(["down"])).toBe(0);
    expect(f.locations[0]?.native).toEqual({
      artifactBucket: "owned-native-artifacts",
      catalogKey: `catalogs/${"a".repeat(64)}.json`,
      expectedBucketOwner: "123456789012",
    });
    expect(f.storageCalls).toContain("drained");
    expect(f.calls.filter((call) => call.args.includes("delete-stack"))).toHaveLength(2);
  });
  it.each([
    ["CloudExecutionArtifactBucket", ""],
    ["CloudExecutionArtifactBucket", "https://outside.example"],
    ["CloudExecutionArtifactBucket", "bucket..name"],
    ["CloudExecutionCatalogKey", ""],
    ["CloudExecutionCatalogKey", "catalogs/not-pinned.json"],
    ["CloudExecutionCatalogKey", `other/${"a".repeat(64)}.json`],
  ])(
    "rejects invalid native %s before stopping intake or deleting resources",
    async (key, value) => {
      const f = fixture({
        confirmed: true,
        fail: (request) =>
          nativeStackResponse(request, (outputs) => {
            const item = outputs.find((entry) => entry.OutputKey === key);
            if (item) item.OutputValue = value;
          }),
      });
      expect(await f.run(["down"])).toBe(1);
      expect(f.locations).toEqual([]);
      expect(f.storageCalls).not.toContain("stop");
      expect(f.calls.some((call) => call.args.includes("delete-stack"))).toBe(false);
    },
  );
  it("does not invent a native artifact requirement for the prior AWS-only control version", async () => {
    const f = fixture({ confirmed: true });
    expect(await f.run(["down"])).toBe(0);
    expect(f.locations[0]?.native).toBeUndefined();
  });
});
