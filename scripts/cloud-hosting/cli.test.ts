import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { assertStandardBootstrap } from "./bootstrap-check";
import { runCloudCli } from "./cli";
import type { CloudInstallation, InstallationLocation } from "./installation";
import type { CloudCliIo, ProcessRequest, ProcessResult } from "./process";
import "./main";

function standardToolkit() {
  return {
    StackName: "CDKToolkit",
    StackId:
      "arn:aws:cloudformation:ap-northeast-1:123456789012:stack/CDKToolkit/synthetic-stack-id",
    StackStatus: "CREATE_COMPLETE",
    Parameters: [{ ParameterKey: "Qualifier", ParameterValue: "hnb659fds" }],
    Outputs: [{ OutputKey: "BootstrapVersion", OutputValue: "32" }],
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
    request.args.some((arg) => arg === "CDKToolkit")
  )
    return { code: 0, stdout: JSON.stringify(standardToolkit()), stderr: "" };
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
  if (phase === "toolkit") return request.args.includes("CDKToolkit");
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
      if (request.args.includes("--show-template"))
        return { code: 0, stdout: "Description: AWS CDK: Default Resources", stderr: "" };
      if (request.args.includes("bootstrap")) toolkitInstalled = true;
      if (request.args.includes("CDKToolkit")) {
        if (request.args.includes("describe-stacks") && !toolkitInstalled)
          return {
            code: 1,
            stdout: "",
            stderr:
              "An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id CDKToolkit does not exist",
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

describe("cloud CLI real CDK app execution", () => {
  it("synthesizes a dummy TypeScript app from a repository path containing spaces", async () => {
    const root = mkdtempSync(join(tmpdir(), "tenkacloud cdk app "));
    try {
      symlinkSync(join(import.meta.dir, "../../node_modules"), join(root, "node_modules"), "dir");
      mkdirSync(join(root, "infrastructure/bin"), { recursive: true });
      writeFileSync(join(root, "infrastructure/package.json"), '{"type":"module"}');
      writeFileSync(
        join(root, "infrastructure/bin/cloud-hosting.ts"),
        [
          'import { App, Stack } from "aws-cdk-lib";',
          'const stackName: string = "DummyStack";',
          "const app = new App();",
          "new Stack(app, stackName);",
          "app.synth();",
          'console.log("DUMMY_TYPESCRIPT_APP_EXECUTED");',
        ].join("\n"),
      );
      const emptyConfig = join(root, "empty-aws-config");
      writeFileSync(emptyConfig, "");
      const f = fixture();
      expect(await runCloudCli(["up"], f.io, { root, env: f.env })).toBe(0);
      const request = f.calls.find((call) => call.args.includes("deploy"));
      if (!request) throw new Error("Missing CDK deployment request");
      // Exercise CDK's real --app parser and subprocess with no deployment or AWS access.
      const result = spawnSync(
        request.command,
        [
          ...request.args.slice(0, request.args.indexOf("deploy")),
          "synth",
          "--no-lookups",
          "--no-notices",
          "--no-version-reporting",
        ],
        {
          cwd: request.cwd,
          env: {
            PATH: process.env.PATH,
            HOME: root,
            AWS_CONFIG_FILE: emptyConfig,
            AWS_SHARED_CREDENTIALS_FILE: emptyConfig,
            AWS_EC2_METADATA_DISABLED: "true",
            AWS_REGION: f.env.AWS_REGION,
            CDK_DISABLE_VERSION_CHECK: "1",
            CDK_DISABLE_CLI_TELEMETRY: "1",
          },
          encoding: "utf8",
          timeout: 20_000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("DUMMY_TYPESCRIPT_APP_EXECUTED");
      expect(
        JSON.parse(readFileSync(join(root, "cdk.out/manifest.json"), "utf8")) as unknown,
      ).toMatchObject({ artifacts: { DummyStack: { type: "aws:cloudformation:stack" } } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

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
  it("preflights the installed toolkit, pins standard CDKToolkit during deploy and prepares the organizer without IAM setup", async () => {
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
    expect(f.calls[7]?.args.slice(2, 8)).toEqual([
      "--toolkit-stack-name",
      "CDKToolkit",
      "--profile",
      "",
      "--region",
      "ap-northeast-1",
    ]);
    expect(f.calls[7]?.args.slice(8)).toEqual([
      "deploy",
      "tenkacloud-cloud-problem-deploy-staging",
      "tenkacloud-cloud-staging",
      "--require-approval",
      "broadening",
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
      expect(preview.calls).toHaveLength(1);
      expect(preview.calls[0]?.args).toEqual([
        "bootstrap",
        "--show-template",
        "--toolkit-stack-name",
        "CDKToolkit",
        "--qualifier",
        "hnb659fds",
        "--profile",
        "",
        "--region",
        "ap-northeast-1",
        "--bootstrap-bucket-name",
        "cdk-hnb659fds-assets-123456789012-ap-northeast-1",
        "--bootstrap-kms-key-id",
        "AWS_MANAGED_KEY",
      ]);
      expect(preview.messages.join("")).toContain("CDKToolkit");
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
      expect(deletes.every((call) => !call.args.includes("--role-arn"))).toBe(true);
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
  it.each([{ args: [] }, { args: ["--yes"] }, { args: ["--setup-if-needed", "--yes"] }])(
    "preserves an existing customized standard toolkit for deploy flags %s",
    async ({ args }) => {
      const f = fixture({
        fail: (request) =>
          request.args.includes("CDKToolkit")
            ? {
                code: 0,
                stdout: JSON.stringify({
                  ...standardToolkit(),
                  Tags: [],
                  Parameters: [
                    {
                      ParameterKey: "CloudFormationExecutionPolicies",
                      ParameterValue: "arn:aws:iam::123456789012:policy/ReviewedExecution",
                    },
                    { ParameterKey: "TrustedAccounts", ParameterValue: "210987654321" },
                    {
                      ParameterKey: "InputPermissionsBoundary",
                      ParameterValue: "ReviewedBoundary",
                    },
                    {
                      ParameterKey: "BootstrapVariant",
                      ParameterValue: "Account administrator customization",
                    },
                  ],
                }),
                stderr: "",
              }
            : undefined,
      });
      expect(await f.run(["up", ...args])).toBe(0);
      expect(f.confirmations).toEqual([]);
      expect(
        f.calls.some(
          (call) => call.args.includes("bootstrap") || call.args.includes("update-stack"),
        ),
      ).toBe(false);
      const deploy = f.calls.find((call) => call.args.includes("deploy"));
      expect(deploy?.args.at(-1)).toBe(
        args.some((arg) => arg === "--yes") ? "never" : "broadening",
      );
    },
  );
  it("inspects the official bootstrap template offline without AWS, app synthesis or organizer email", async () => {
    const f = fixture();
    expect(
      await runCloudCli(["up", "--show-setup"], f.io, {
        root: ROOT,
        env: { ACCOUNT_ID: "123456789012", AWS_REGION: "ap-northeast-1", ENV: "staging" },
      }),
    ).toBe(0);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.command).toBe(`${ROOT}/node_modules/aws-cdk/bin/cdk`);
    expect(f.calls[0]?.args).toEqual([
      "bootstrap",
      "--show-template",
      "--toolkit-stack-name",
      "CDKToolkit",
      "--qualifier",
      "hnb659fds",
      "--profile",
      "",
      "--region",
      "ap-northeast-1",
      "--bootstrap-bucket-name",
      "cdk-hnb659fds-assets-123456789012-ap-northeast-1",
      "--bootstrap-kms-key-id",
      "AWS_MANAGED_KEY",
    ]);
    expect(f.calls[0]?.inherit).toBeUndefined();
    expect(f.messages.join("")).toContain("AWS CDK: Default Resources");
    expect(f.messages.join("")).toContain("AdministratorAccess");
    expect(f.messages.join("")).toContain("not a TenkaCloud-scoped permission");
  });
  it("clears implicit CDK profile settings while preserving the selected AWS profile for all subprocesses", async () => {
    const f = fixture({ toolkitMissing: true, confirmed: true });
    const env = {
      ...f.env,
      AWS_PROFILE: "reviewed-profile",
      AWS_DEFAULT_PROFILE: "fallback-profile",
    };
    expect(await runCloudCli(["up", "--show-setup"], f.io, { root: ROOT, env })).toBe(0);
    expect(await runCloudCli(["up"], f.io, { root: ROOT, env })).toBe(0);
    const cdkCalls = f.calls.filter(
      (call) => call.command === `${ROOT}/node_modules/aws-cdk/bin/cdk`,
    );
    expect(cdkCalls).toHaveLength(3);
    for (const call of cdkCalls) {
      const profileIndex = call.args.indexOf("--profile");
      expect(profileIndex).toBeGreaterThan(-1);
      expect(call.args[profileIndex + 1]).toBe("");
    }
    expect(f.calls.every((call) => call.env.AWS_PROFILE === "reviewed-profile")).toBe(true);
    expect(f.calls.every((call) => call.env.AWS_DEFAULT_PROFILE === "fallback-profile")).toBe(true);
    expect(f.messages.join("")).toContain("--profile ''");
    expect(f.messages.join("")).toContain("--bootstrap-kms-key-id AWS_MANAGED_KEY");
    expect(f.messages.join("")).toContain(
      "--bootstrap-bucket-name cdk-hnb659fds-assets-123456789012-ap-northeast-1",
    );
    expect(env.AWS_PROFILE).toBe("reviewed-profile");
  });
  it("reports a failed offline template preview", async () => {
    const f = fixture({
      fail: (request) =>
        request.args.includes("--show-template")
          ? { code: 1, stdout: "", stderr: "Synthetic template failure" }
          : undefined,
    });
    expect(await f.run(["up", "--show-setup"])).toBe(1);
    expect(f.errors.join("")).toContain("Synthetic template failure");
    expect(f.calls.every((call) => call.command !== "aws")).toBe(true);
  });
  it.each([{ args: [] }, { args: ["--yes"] }])(
    "stops before IAM writes or builds when initial bootstrap is declined: %s",
    async ({ args }) => {
      const f = fixture({ toolkitMissing: true });
      expect(await f.run(["up", ...args])).toBe(1);
      expect(f.confirmations).toHaveLength(1);
      expect(f.errors.join("")).toContain("--show-setup");
      expect(f.calls.some((call) => call.inherit)).toBe(false);
      expect(f.calls.some((call) => call.command === "bun")).toBe(false);
    },
  );
  it.each([
    { args: [], ci: undefined, prompts: 1 },
    { args: ["--yes"], ci: undefined, prompts: 1 },
    { args: ["--setup-if-needed", "--yes"], ci: "true", prompts: 0 },
  ])(
    "pins the standard bootstrap stack and qualifier before completing the same deploy: %s",
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
        "AdministratorAccess",
        "broad account administration",
        "ReadOnlyAccess",
        "retained asset storage can incur charges",
        "continues the application deployment with the same credentials",
        "arn:aws:iam::123456789012:role/cdk-hnb659fds-cfn-exec-role-123456789012-ap-northeast-1",
        "cdk-hnb659fds-assets-123456789012-ap-northeast-1",
        "cdk-hnb659fds-container-assets-123456789012-ap-northeast-1",
        "/cdk-bootstrap/hnb659fds/version",
      ])
        expect(notice).toContain(text);
      const create = f.calls.findIndex((call) => call.args.includes("bootstrap"));
      const verify = f.calls.findIndex(
        (call, index) => index > create && call.args.includes("CDKToolkit"),
      );
      const build = f.calls.findIndex((call) => call.command === "bun");
      expect(create).toBeGreaterThan(0);
      expect(f.calls[create]?.command).toBe(`${ROOT}/node_modules/aws-cdk/bin/cdk`);
      expect(f.calls[create]?.args).toEqual([
        "bootstrap",
        "aws://123456789012/ap-northeast-1",
        "--toolkit-stack-name",
        "CDKToolkit",
        "--qualifier",
        "hnb659fds",
        "--profile",
        "",
        "--region",
        "ap-northeast-1",
        "--bootstrap-bucket-name",
        "cdk-hnb659fds-assets-123456789012-ap-northeast-1",
        "--bootstrap-kms-key-id",
        "AWS_MANAGED_KEY",
      ]);
      expect(f.calls[create]?.inherit).toBe(true);
      expect(verify).toBeGreaterThan(create);
      expect(build).toBeGreaterThan(verify);
      expect(f.calls.some((call) => call.args.includes("deploy"))).toBe(true);
      expect(f.calls.some((call) => call.args.includes("admin-create-user"))).toBe(true);
      expect(
        f.calls.some(
          (call) =>
            call.args.includes("iam") ||
            call.args.includes("create-stack") ||
            call.args.includes("update-stack"),
        ),
      ).toBe(false);
      expect(notice).toContain("https://console.example.test");
    },
  );
  it.each([{ args: [] }, { args: ["--yes"] }, { args: ["--setup-if-needed"] }])(
    "never treats ordinary CI deployment consent as initial bootstrap approval: %s",
    async ({ args }) => {
      const f = fixture({ toolkitMissing: true, confirmed: true });
      expect(
        await runCloudCli(["up", ...args], f.io, { root: ROOT, env: { ...f.env, CI: "true" } }),
      ).toBe(1);
      expect(f.confirmations).toEqual([]);
      expect(f.errors.join("")).toContain("--setup-if-needed --yes");
      expect(f.calls.some((call) => call.inherit)).toBe(false);
    },
  );
  it("deploys a fresh account after confirmed toolkit bootstrap", async () => {
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
    expect(f.calls.filter((call) => call.args.includes("bootstrap"))).toHaveLength(1);
    expect(f.calls.some((call) => call.args.includes("deploy"))).toBe(true);
  });
  it("retains verified bootstrap after a deployment failure and reuses it on retry", async () => {
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
    expect(f.errors.join("")).toContain("synthetic operator failure");
    expect(f.calls.some((call) => call.args.includes("delete-stack"))).toBe(false);
    failDeploy = false;
    expect(await f.run(["up"])).toBe(0);
    expect(f.confirmations).toHaveLength(1);
    expect(f.calls.filter((call) => call.args.includes("bootstrap"))).toHaveLength(1);
  });
  it("rechecks after consent and reuses a toolkit installed while confirmation was pending", async () => {
    let inspected = false;
    const f = fixture({
      confirmed: true,
      fail: (request) => {
        if (!inspected && request.args.includes("CDKToolkit")) {
          inspected = true;
          return {
            code: 1,
            stdout: "",
            stderr:
              "An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id CDKToolkit does not exist",
          };
        }
        return undefined;
      },
    });
    expect(await f.run(["up"])).toBe(0);
    expect(f.confirmations).toHaveLength(1);
    expect(
      f.calls.some((call) => call.args.includes("bootstrap") || call.args.includes("update-stack")),
    ).toBe(false);
  });
  it("halts the deployment when official bootstrap fails", async () => {
    const f = fixture({
      toolkitMissing: true,
      confirmed: true,
      fail: (request) =>
        request.args.includes("bootstrap")
          ? { code: 1, stdout: "", stderr: "AccessDenied: synthetic initial bootstrap denial" }
          : undefined,
    });
    expect(await f.run(["up"])).toBe(1);
    expect(f.errors.join("")).toContain("synthetic initial bootstrap denial");
    expect(f.calls.some((call) => call.command === "bun" || call.args.includes("deploy"))).toBe(
      false,
    );
  });
  it.each(["invalid", "denied"])(
    "does not build or claim success when installed toolkit verification is %s",
    async (failure) => {
      let created = false;
      const f = fixture({
        toolkitMissing: true,
        confirmed: true,
        fail: (request) => {
          if (request.args.includes("bootstrap")) created = true;
          if (created && request.args.includes("CDKToolkit"))
            return failure === "invalid"
              ? { code: 0, stdout: "{}", stderr: "" }
              : { code: 1, stdout: "", stderr: "Synthetic verification denial" };
          return undefined;
        },
      });
      expect(await f.run(["up"])).toBe(1);
      expect(f.calls.some((call) => call.command === "bun")).toBe(false);
      expect(f.messages.join("")).not.toContain("Standard CDKToolkit verified");
    },
  );
  it("explains deployment permissions without granting an operator policy", async () => {
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
    expect(f.errors.join("")).toContain("intended AWS profile");
    expect(f.confirmations).toEqual([]);
    expect(f.calls.some((call) => call.inherit || call.args.includes("iam"))).toBe(false);
  });
  it.each([
    "arn:aws:iam::aws:policy/AdministratorAccess",
    "arn:aws:iam::123456789012:policy/ReviewedExecution",
    "",
  ])(
    "rejects obsolete policy environment configuration without ignoring it: %s",
    async (policy) => {
      for (const args of [["up"], ["up", "--setup"], ["up", "--show-setup"]]) {
        const f = fixture();
        expect(
          await runCloudCli(args, f.io, {
            root: ROOT,
            env: { ...f.env, TENKACLOUD_CFN_EXECUTION_POLICY_ARN: policy },
          }),
        ).toBe(1);
        expect(f.errors.join("")).toContain("TENKACLOUD_CFN_EXECUTION_POLICY_ARN is obsolete");
        expect(f.errors.join("")).toContain("Remove it");
        expect(f.calls).toEqual([]);
      }
    },
  );
  it("requires separate consent for optional bootstrap-only setup", async () => {
    const f = fixture({ toolkitMissing: true });
    expect(await f.run(["up", "--setup"])).toBe(1);
    expect(f.confirmations).toHaveLength(1);
    expect(f.errors.join("")).toContain("bootstrap cancelled");
    expect(f.calls.some((call) => call.inherit)).toBe(false);
  });
  it("optional setup installs only a missing standard toolkit, then deployment reuses it", async () => {
    const f = fixture({ toolkitMissing: true, confirmed: true });
    expect(await f.run(["up", "--setup"])).toBe(0);
    expect(f.calls.filter((call) => call.args.includes("bootstrap"))).toHaveLength(1);
    expect(f.calls.some((call) => call.command === "bun" || call.args.includes("deploy"))).toBe(
      false,
    );
    expect(await f.run(["up", "--setup"])).toBe(0);
    expect(await f.run(["up"])).toBe(0);
    expect(f.confirmations).toHaveLength(1);
    expect(f.calls.filter((call) => call.args.includes("bootstrap"))).toHaveLength(1);
    expect(f.calls.some((call) => call.args.includes("update-stack"))).toBe(false);
  });
  it.each([
    "AccessDeniedException",
    "Stack does not exist",
    "An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id OtherToolkit does not exist",
  ])("does not treat an unknown toolkit read failure as absence: %s", async (stderr) => {
    const f = fixture({
      fail: (request) =>
        request.args.includes("CDKToolkit") ? { code: 1, stdout: "", stderr } : undefined,
    });
    expect(await f.run(["up"])).toBe(1);
    expect(f.calls.some((call) => call.inherit || call.command === "bun")).toBe(false);
    expect(f.confirmations).toEqual([]);
  });
  it.each([
    { StackName: "OtherToolkit" },
    { StackId: "arn:aws:cloudformation:ap-northeast-1:210987654321:stack/CDKToolkit/other" },
    { StackId: "arn:aws:cloudformation:us-east-1:123456789012:stack/CDKToolkit/other" },
    { StackStatus: "UPDATE_IN_PROGRESS" },
    { StackStatus: "ROLLBACK_COMPLETE" },
  ])("fails closed for toolkit identity or status: %s", async (change) => {
    const f = fixture({
      fail: (request) =>
        request.args.includes("CDKToolkit")
          ? { code: 0, stdout: JSON.stringify({ ...standardToolkit(), ...change }), stderr: "" }
          : undefined,
    });
    expect(await f.run(["up"])).toBe(1);
    expect(f.calls.some((call) => call.inherit || call.command === "bun")).toBe(false);
    expect(f.confirmations).toEqual([]);
  });
  it.each([
    { Parameters: [{ ParameterKey: "Qualifier", ParameterValue: "custom" }] },
    {
      Parameters: [
        { ParameterKey: "Qualifier", ParameterValue: "hnb659fds" },
        { ParameterKey: "Qualifier", ParameterValue: "hnb659fds" },
      ],
    },
    { Outputs: [] },
    { Outputs: [{ OutputKey: "BootstrapVersion", OutputValue: "5" }] },
    { Outputs: [{ OutputKey: "BootstrapVersion", OutputValue: "invalid" }] },
    {
      Outputs: [
        { OutputKey: "BootstrapVersion", OutputValue: "32" },
        { OutputKey: "BootstrapVersion", OutputValue: "6" },
      ],
    },
  ])(
    "reports incompatible toolkit configuration without an automatic upgrade: %s",
    async (change) => {
      const f = fixture({
        fail: (request) =>
          request.args.includes("CDKToolkit")
            ? { code: 0, stdout: JSON.stringify({ ...standardToolkit(), ...change }), stderr: "" }
            : undefined,
      });
      expect(await f.run(["up", "--setup-if-needed", "--yes"])).toBe(1);
      expect(f.errors.join("")).toContain("official CDK CLI separately");
      expect(f.calls.some((call) => call.inherit || call.command === "bun")).toBe(false);
      expect(f.confirmations).toEqual([]);
    },
  );
  it("checks existing toolkit identity and status without requiring project ownership tags", () => {
    expect(() =>
      assertStandardBootstrap(JSON.stringify(standardToolkit()), "123456789012", "ap-northeast-1"),
    ).not.toThrow();
    expect(() => assertStandardBootstrap("{}", "123456789012", "ap-northeast-1")).toThrow();
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

describe("failed initial cloud creation recovery", () => {
  const names = cloudStackNames("staging");
  const kinds = ["Events", "Teams", "Deployments"];
  const result = (body: unknown): ProcessResult => ({
    code: 0,
    stdout: JSON.stringify(body),
    stderr: "",
  });
  function recoveryFixture(
    options: {
      backendOnly?: boolean;
      status?: string;
      artifact?: boolean;
      missingTables?: readonly string[];
      confirmed?: boolean;
      mutate?: (request: ProcessRequest, body: unknown) => unknown;
      fail?: (request: ProcessRequest) => ProcessResult | undefined;
    } = {},
  ) {
    const target = options.backendOnly ? names.backend : names.app;
    const status = options.status ?? "CREATE_FAILED";
    const tableName = (kind: string) => `${names.backend}-${kind}ABC123-synthetic`;
    const resources = Object.fromEntries(
      kinds.map((kind) => [
        `${kind}ABC123`,
        {
          Type: "AWS::DynamoDB::Table",
          DeletionPolicy: "Retain",
          UpdateReplacePolicy: "Retain",
        },
      ]),
    );
    const backendTemplate = {
      Resources: resources,
      Outputs: Object.fromEntries(
        kinds.map((kind) => [`${kind}TableName`, { Value: { Ref: `${kind}ABC123` } }]),
      ),
    };
    const appTemplate = {
      Resources: {
        ExecutionArtifactsABC123: {
          Type: "AWS::S3::Bucket",
          DeletionPolicy: "Retain",
          UpdateReplacePolicy: "Retain",
        },
        CloudApiABC123: { Type: "AWS::Lambda::Function" },
      },
      Outputs: {
        CloudInstallationControlVersion: { Value: "2" },
        CloudRunnerEnabled: { Value: "true" },
        CloudExecutionArtifactBucket: { Value: { Ref: "ExecutionArtifactsABC123" } },
        CloudExecutionCatalogKey: { Value: `catalogs/${"a".repeat(64)}.json` },
      },
    };
    function inspectPlatform(request: ProcessRequest): ProcessResult {
      const name = request.args[request.args.indexOf("--stack-name") + 1] ?? "";
      if (options.backendOnly && name === names.app)
        return {
          code: 1,
          stdout: "",
          stderr: `(ValidationError) Stack with id ${name} does not exist`,
        };
      return response(request, {
        ...ownedStack(name),
        ...(name === target ? { StackStatus: status, Outputs: undefined } : {}),
      });
    }
    function inventory(request: ProcessRequest): unknown {
      if (request.args.includes(ownedStack(names.backend).StackId))
        return {
          StackResourceSummaries: kinds
            .filter((kind) => !options.missingTables?.includes(kind))
            .map((kind) => ({
              LogicalResourceId: `${kind}ABC123`,
              PhysicalResourceId: tableName(kind),
              ResourceType: "AWS::DynamoDB::Table",
              ResourceStatus: "CREATE_COMPLETE",
            })),
        };
      return {
        StackResourceSummaries: [
          {
            LogicalResourceId: "CloudApiABC123",
            PhysicalResourceId: "created-runner",
            ResourceType: "AWS::Lambda::Function",
            ResourceStatus: "CREATE_COMPLETE",
          },
          ...(options.artifact === false
            ? []
            : [
                {
                  LogicalResourceId: "ExecutionArtifactsABC123",
                  PhysicalResourceId: "owned-native-artifacts",
                  ResourceType: "AWS::S3::Bucket",
                  ResourceStatus: "CREATE_COMPLETE",
                },
              ]),
        ],
      };
    }
    const readers: Record<string, (request: ProcessRequest) => unknown> = {
      "describe-stack-events": () => ({
        StackEvents: ["CREATE_IN_PROGRESS", "CREATE_FAILED"].map((ResourceStatus) => ({
          PhysicalResourceId: ownedStack(target).StackId,
          ResourceType: "AWS::CloudFormation::Stack",
          ResourceStatus,
        })),
      }),
      "get-template": (request) => ({
        TemplateBody: request.args.includes(ownedStack(names.backend).StackId)
          ? backendTemplate
          : appTemplate,
      }),
      "list-stack-resources": inventory,
      "describe-table": (request) => {
        const TableName = request.args[request.args.indexOf("--table-name") + 1] ?? "";
        return {
          Table: {
            TableName,
            TableArn: `arn:aws:dynamodb:ap-northeast-1:123456789012:table/${TableName}`,
            TableStatus: "ACTIVE",
          },
        };
      },
      "list-tags-of-resource": () => ({
        Tags: Object.entries(cloudStackTags("staging")).map(([Key, Value]) => ({ Key, Value })),
      }),
      scan: () => ({ Items: [] }),
    };
    function response(request: ProcessRequest, body: unknown): ProcessResult {
      return result(options.mutate ? options.mutate(request, body) : body);
    }
    const f = fixture({
      confirmed: options.confirmed ?? true,
      fail: (request) => {
        const failure = options.fail?.(request);
        if (failure) return failure;
        if (platformInspection(request)) return inspectPlatform(request);
        const read = readers[request.args[1] ?? ""];
        return read ? response(request, read(request)) : undefined;
      },
    });
    return { ...f, target, tableName };
  }
  const rewrite = (body: unknown): Record<string, unknown> =>
    JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  const noDeletes = (f: ReturnType<typeof recoveryFixture>) =>
    expect(f.calls.some((call) => call.args.includes("delete-stack"))).toBe(false);

  it.each(["CREATE_FAILED", "ROLLBACK_COMPLETE", "ROLLBACK_FAILED", "DELETE_FAILED"])(
    "recovers absent Outputs after runner creation in %s using physical ownership and durable drain",
    async (status) => {
      const f = recoveryFixture({ status });
      expect(await f.run(["down", "--yes"])).toBe(0);
      expect(f.storageCalls).toEqual(["stop", "list", "list", "drained", "close"]);
      expect(f.locations[0]?.native?.artifactBucket).toBe("owned-native-artifacts");
      expect(f.calls.filter((call) => call.args.includes("delete-stack"))).toHaveLength(2);
      const proof = f.calls.filter((call) =>
        ["get-template", "describe-stack-events", "list-stack-resources"].some((action) =>
          call.args.includes(action),
        ),
      );
      expect(
        proof.every((call) => call.args.some((arg) => arg.startsWith("arn:aws:cloudformation:"))),
      ).toBe(true);
      expect(
        f.calls.some(
          (call) => call.args.includes("--role-arn") || call.args.includes("CDKToolkit"),
        ),
      ).toBe(false);
    },
  );
  it.each([
    { missingTables: [] },
    { missingTables: ["Events"] },
    { missingTables: ["Events", "Teams", "Deployments"] },
  ])(
    "removes only failed backend hosting with empty or not-yet-created tables: %j",
    async ({ missingTables }) => {
      const f = recoveryFixture({ backendOnly: true, missingTables });
      expect(await f.run(["down", "--yes"])).toBe(0);
      expect(f.locations).toEqual([]);
      expect(f.calls.filter((call) => call.args.includes("delete-stack"))).toHaveLength(1);
      const scans = f.calls.filter((call) => call.args.includes("scan"));
      expect(scans).toHaveLength((3 - missingTables.length) * 2);
      expect(scans.every((call) => call.args.includes("--consistent-read"))).toBe(true);
      expect(f.messages.join("")).toContain("Retained tables and assets were not purged");
    },
  );
  it("fences a created runner and proves all table pages empty when native assets were never created", async () => {
    let pages = 0;
    const f = recoveryFixture({
      artifact: false,
      mutate: (request, body) => {
        if (!request.args.includes("scan")) return body;
        expect(f.storageCalls).toContain("stop");
        pages++;
        return pages === 1
          ? {
              Items: [{ PK: { S: "INSTALLATION" }, SK: { S: "CONTROL" } }],
              LastEvaluatedKey: { PK: { S: "INSTALLATION" }, SK: { S: "CONTROL" } },
            }
          : { Items: [], LastEvaluatedKey: {} };
      },
    });
    expect(await f.run(["down", "--yes"])).toBe(0);
    expect(pages).toBe(4);
    expect(f.storageCalls).toEqual(["stop", "drained", "close"]);
    expect(f.calls.some((call) => call.args.includes("--exclusive-start-key"))).toBe(true);
    expect(f.locations[0]?.native).toBeUndefined();
  });
  it.each([true, false])(
    "preserves retained data and live work with partial native resources, backendOnly=%s",
    async (backendOnly) => {
      const f = recoveryFixture({
        backendOnly,
        artifact: false,
        mutate: (request, body) =>
          request.args.includes("scan")
            ? { Items: [{ PK: { S: "EVENT#live" }, SK: { S: "META" } }] }
            : body,
      });
      expect(await f.run(["down", "--yes"])).toBe(1);
      expect(f.errors.join("")).toContain("stored data or event work");
      noDeletes(f);
      expect(f.storageCalls).not.toContain("drained");
    },
  );
  it("repeats a failed backend deletion and then accepts both stacks absent", async () => {
    let attempt = 0;
    const f = recoveryFixture({
      backendOnly: true,
      fail: (request) => {
        if (attempt === 0 && request.args.includes("delete-stack"))
          return { code: 1, stdout: "", stderr: "Synthetic retry" };
        if (attempt === 2 && platformInspection(request)) {
          const name = request.args[request.args.indexOf("--stack-name") + 1];
          return {
            code: 1,
            stdout: "",
            stderr: `(ValidationError) Stack with id ${name} does not exist`,
          };
        }
        return undefined;
      },
    });
    expect(await f.run(["down", "--yes"])).toBe(1);
    attempt++;
    expect(await f.run(["down", "--yes"])).toBe(0);
    attempt++;
    const before = f.calls.length;
    expect(await f.run(["down", "--yes"])).toBe(0);
    expect(f.calls.slice(before).some((call) => call.args.includes("delete-stack"))).toBe(false);
  });
  it.each([true, false])("cancels recovery before writes, backendOnly=%s", async (backendOnly) => {
    const f = recoveryFixture({ backendOnly, confirmed: false });
    expect(await f.run(["down"])).toBe(0);
    noDeletes(f);
    expect(f.storageCalls).not.toContain("stop");
    expect(f.confirmations).toHaveLength(1);
  });
  it.each(["CREATE_IN_PROGRESS", "ROLLBACK_IN_PROGRESS"])(
    "reports %s without parsing missing outputs or mutating",
    async (status) => {
      const f = recoveryFixture({ status });
      expect(await f.run(["down", "--yes"])).toBe(1);
      noDeletes(f);
      expect(f.errors.join("")).toContain("wait");
      expect(f.errors.join("")).not.toContain("Expected array");
    },
  );
  it("reports failed creation on up without rebuilding or implicitly replacing it", async () => {
    const f = recoveryFixture();
    expect(await f.run(["up"])).toBe(1);
    expect(f.errors.join("")).toContain("make destroy");
    expect(f.calls.some((call) => call.inherit)).toBe(false);
  });
  it.each([
    "get-template",
    "describe-stack-events",
    "list-stack-resources",
    "describe-table",
    "list-tags-of-resource",
  ])("fails closed when %s evidence is denied", async (action) => {
    const f = recoveryFixture({
      fail: (request) =>
        request.args.includes(action)
          ? { code: 1, stdout: "", stderr: "AccessDeniedException" }
          : undefined,
    });
    expect(await f.run(["down", "--yes"])).toBe(1);
    noDeletes(f);
  });
  function mutateEvidence(action: string, change: string, value: Record<string, unknown>): void {
    const mutations: Record<string, () => void> = {
      "describe-stack-events": () => mutateHistory(change, value),
      "list-stack-resources": () => mutateInventory(change, value),
      "describe-table": () => mutateTable(change, value),
      "list-tags-of-resource": () => {
        if (change === "missing") value.Tags = [];
        if (change === "conflict")
          (value.Tags as unknown[]).push({
            Key: "aws:cloudformation:stack-id",
            Value: "other-stack",
          });
      },
      "get-template": () => {
        const template = value.TemplateBody as {
          Resources: Record<string, Record<string, unknown>>;
          Outputs: Record<string, { Value: unknown }>;
        };
        if (change === "retention" && template.Resources.EventsABC123)
          template.Resources.EventsABC123.DeletionPolicy = "Delete";
        if (change === "contract" && template.Outputs.CloudInstallationControlVersion)
          template.Outputs.CloudInstallationControlVersion.Value = "unknown";
      },
    };
    mutations[action]?.();
  }
  function mutateHistory(change: string, value: Record<string, unknown>): void {
    if (change === "missing") value.StackEvents = [];
    if (change === "successful" || change === "updated")
      value.StackEvents = [
        {
          PhysicalResourceId: ownedStack(names.app).StackId,
          ResourceType: "AWS::CloudFormation::Stack",
          ResourceStatus: change === "successful" ? "CREATE_COMPLETE" : "UPDATE_COMPLETE",
        },
      ];
  }
  function mutateInventory(change: string, value: Record<string, unknown>): void {
    const items = value.StackResourceSummaries as Record<string, unknown>[];
    const first = items[0];
    if (!first) throw new Error("Missing test inventory");
    if (change === "duplicate") items.push({ ...first });
    if (change === "type") first.ResourceType = "AWS::S3::Bucket";
    if (change === "progress") first.ResourceStatus = "DELETE_IN_PROGRESS";
    if (change === "unowned") first.PhysicalResourceId = "some-other-table";
    if (change === "missing-physical") delete first.PhysicalResourceId;
  }
  function mutateTable(change: string, value: Record<string, unknown>): void {
    const table = value.Table as Record<string, unknown>;
    if (change === "account")
      table.TableArn = "arn:aws:dynamodb:ap-northeast-1:210987654321:table/other";
    if (change === "name") table.TableName = "other";
    if (change === "status") table.TableStatus = "DELETING";
  }
  it.each([
    ["describe-stack-events", "truncated"],
    ["describe-stack-events", "successful"],
    ["describe-stack-events", "updated"],
    ["describe-stack-events", "missing"],
    ["list-stack-resources", "truncated"],
    ["list-stack-resources", "duplicate"],
    ["list-stack-resources", "type"],
    ["list-stack-resources", "progress"],
    ["list-stack-resources", "unowned"],
    ["list-stack-resources", "missing-physical"],
    ["describe-table", "account"],
    ["describe-table", "name"],
    ["describe-table", "status"],
    ["list-tags-of-resource", "missing"],
    ["list-tags-of-resource", "conflict"],
    ["get-template", "retention"],
    ["get-template", "contract"],
  ])("rejects %s %s without deleting or fencing", async (action, change) => {
    const f = recoveryFixture({
      mutate: (request, body) => {
        if (!request.args.includes(action)) return body;
        const value = rewrite(body);
        if (change === "truncated") value.NextToken = "not-complete";
        mutateEvidence(action, change, value);
        return value;
      },
    });
    expect(await f.run(["down", "--yes"])).toBe(1);
    noDeletes(f);
    expect(f.storageCalls).not.toContain("stop");
  });
  it("rejects a missing backend even if the app claims failed initial creation", async () => {
    const f = recoveryFixture({
      fail: (request) =>
        platformInspection(request) && request.args.includes(names.backend)
          ? {
              code: 1,
              stdout: "",
              stderr: `(ValidationError) Stack with id ${names.backend} does not exist`,
            }
          : undefined,
    });
    expect(await f.run(["down", "--yes"])).toBe(1);
    noDeletes(f);
  });
  it("rejects incomplete installation tables when a runner may have been created", async () => {
    const f = recoveryFixture({ missingTables: ["Teams"] });
    expect(await f.run(["down", "--yes"])).toBe(1);
    noDeletes(f);
  });
  it("rejects repeating scan cursors rather than accepting incomplete empty proof", async () => {
    const f = recoveryFixture({
      backendOnly: true,
      mutate: (request, body) =>
        request.args.includes("scan")
          ? { Items: [], LastEvaluatedKey: { PK: { S: "stuck" } } }
          : body,
    });
    expect(await f.run(["down", "--yes"])).toBe(1);
    noDeletes(f);
  });
  it("accepts JSON-string templates and the previous version-1 durable drain contract", async () => {
    const f = recoveryFixture({
      mutate: (request, body) => {
        if (!request.args.includes("get-template")) return body;
        const value = rewrite(body);
        const template = value.TemplateBody as { Outputs: Record<string, { Value: unknown }> };
        if (template.Outputs.CloudInstallationControlVersion)
          template.Outputs.CloudInstallationControlVersion.Value = "1";
        value.TemplateBody = JSON.stringify(template);
        return value;
      },
    });
    expect(await f.run(["down", "--yes"])).toBe(0);
    expect(f.locations[0]?.native).toBeUndefined();
    expect(f.storageCalls).toContain("drained");
  });
  it("does not treat missing outputs on a successful stack as initial failure", async () => {
    const f = recoveryFixture({ status: "CREATE_COMPLETE" });
    expect(await f.run(["down", "--yes"])).toBe(1);
    expect(f.errors.join("")).toContain("completed platform stack");
    noDeletes(f);
  });
  it("rejects an app paired with a partial backend", async () => {
    const f = recoveryFixture({
      mutate: (request, body) =>
        platformInspection(request) && request.args.includes(names.backend)
          ? { ...rewrite(body), StackStatus: "CREATE_FAILED" }
          : body,
    });
    expect(await f.run(["down", "--yes"])).toBe(1);
    noDeletes(f);
  });
  it("does not recover a healthy app from the failed backend's history", async () => {
    const f = recoveryFixture({
      mutate: (request, body) => {
        if (!platformInspection(request)) return body;
        return request.args.includes(names.app)
          ? ownedStack(names.app)
          : { ...rewrite(body), StackStatus: "CREATE_FAILED" };
      },
    });
    expect(await f.run(["down", "--yes"])).toBe(1);
    expect(f.errors.join("")).toContain("not proof");
    noDeletes(f);
  });
  it("allows a table that failed before creation even if CloudFormation assigned a physical name", async () => {
    const f = recoveryFixture({
      backendOnly: true,
      fail: (request) =>
        request.args.includes("describe-table")
          ? {
              code: 1,
              stdout: "",
              stderr: "(ResourceNotFoundException) Requested resource not found",
            }
          : undefined,
      mutate: (request, body) => {
        if (!request.args.includes("list-stack-resources")) return body;
        const value = rewrite(body);
        for (const item of value.StackResourceSummaries as Record<string, unknown>[])
          item.ResourceStatus = "CREATE_FAILED";
        return value;
      },
    });
    expect(await f.run(["down", "--yes"])).toBe(0);
    expect(f.calls.some((call) => call.args.includes("scan"))).toBe(false);
  });
  it("rejects an unexpected fourth data table before inspecting or deleting its data", async () => {
    const f = recoveryFixture({
      backendOnly: true,
      mutate: (request, body) => {
        if (!request.args.includes("get-template")) return body;
        const value = rewrite(body);
        const template = value.TemplateBody as { Resources: Record<string, unknown> };
        template.Resources.UnknownData = { Type: "AWS::DynamoDB::Table" };
        return value;
      },
    });
    expect(await f.run(["down", "--yes"])).toBe(1);
    noDeletes(f);
  });
  it.each(["table", "application"])(
    "rejects partial %s outputs conflicting with physical evidence",
    async (kind) => {
      const f = recoveryFixture({
        mutate: (request, body) => {
          if (!platformInspection(request)) return body;
          if (kind === "table" && request.args.includes(names.backend)) {
            const value = rewrite(body);
            value.Outputs = [{ OutputKey: "EventsTableName", OutputValue: "other-table" }];
            return value;
          }
          return kind === "application" && request.args.includes(names.app)
            ? {
                ...rewrite(body),
                Outputs: [{ OutputKey: "CloudRunnerEnabled", OutputValue: "false" }],
              }
            : body;
        },
      });
      expect(await f.run(["down", "--yes"])).toBe(1);
      noDeletes(f);
    },
  );
  it("never ignores a control-shaped unknown row in Teams or Deployments", async () => {
    const f = recoveryFixture({
      artifact: false,
      mutate: (request, body) =>
        request.args.includes("scan") && request.args.some((arg) => arg.includes("-Teams"))
          ? { Items: [{ PK: { S: "INSTALLATION" }, SK: { S: "CONTROL" } }] }
          : body,
    });
    expect(await f.run(["down", "--yes"])).toBe(1);
    noDeletes(f);
    expect(f.storageCalls).toContain("stop");
  });
  it("recovers deletion retries with only some Outputs present", async () => {
    const f = recoveryFixture({
      status: "DELETE_FAILED",
      mutate: (request, body) =>
        platformInspection(request) && request.args.includes(names.app)
          ? {
              ...rewrite(body),
              Outputs: [{ OutputKey: "CloudRunnerEnabled", OutputValue: "true" }],
            }
          : body,
    });
    expect(await f.run(["down", "--yes"])).toBe(0);
    expect(f.storageCalls).toContain("drained");
  });
  it("resumes the durable backend drain proof after a failed app was already removed", async () => {
    let resumed = false;
    const f = recoveryFixture({
      fail: (request) => {
        if (resumed && platformInspection(request) && request.args.includes(names.app))
          return {
            code: 1,
            stdout: "",
            stderr: `(ValidationError) Stack with id ${names.app} does not exist`,
          };
        if (
          !resumed &&
          request.args.includes("delete-stack") &&
          request.args.includes(ownedStack(names.backend).StackId)
        )
          return { code: 1, stdout: "", stderr: "Synthetic delete failure" };
        return undefined;
      },
    });
    expect(await f.run(["down", "--yes"])).toBe(1);
    expect((await f.installation.repository.installationControl())?.status).toBe("DRAINED");
    resumed = true;
    expect(await f.run(["down", "--yes"])).toBe(0);
  });
});
