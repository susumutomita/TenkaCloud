import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  cloudStackNames,
  cloudStackTags,
} from "../../infrastructure/lib/cloud-hosting/stack-names";
import { assertStandardBootstrap } from "./bootstrap-check";
import { runCloudCli } from "./cli";
import type { DestroyAssemblyTarget } from "./destroy-assembly";
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
      { OutputKey: "CloudComposition", OutputValue: "lite-baseline-v1" },
      { OutputKey: "CloudControlDataBackend", OutputValue: "dynamodb" },
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
function missingOriginalStack(request: ProcessRequest): ProcessResult | undefined {
  if (request.args.includes("describe-stacks") && request.args.includes("Stacks[0]")) {
    const name = request.args[request.args.indexOf("--stack-name") + 1] ?? "";
    if (name.startsWith("tenkacloud-lite"))
      return {
        code: 1,
        stdout: "",
        stderr: `(ValidationError) Stack with id ${name} does not exist`,
      };
  }
  return undefined;
}
function mockResponse(request: ProcessRequest): ProcessResult {
  const missingOriginal = missingOriginalStack(request);
  if (missingOriginal) return missingOriginal;

  if (request.command === "bash" && request.env.PREPARE_SOURCE_BUNDLE_RESOLVE_ONLY === "1")
    return {
      code: 0,
      stdout:
        "CDK_PARAM_S3_BUCKET_NAME=tenkacloud-source-123456789012-ap-northeast-1-1234abcd\nCDK_SOURCE_NAME=source.zip\n",
      stderr: "",
    };
  if (request.command === "bash")
    return {
      code: 0,
      stderr: "",
      stdout: `SOURCE_UPLOAD_KEY=source.zip.executions/00000000-0000-4000-8000-000000000000.zip\nSOURCE_UPLOAD_ETAG=${"a".repeat(32)}\nSOURCE_UPLOAD_VERSION_ID=version-A\n`,
    };
  if (request.args.includes("head-object"))
    return {
      code: 0,
      stdout: JSON.stringify({ ETag: `"${"a".repeat(32)}"`, VersionId: "version-A" }),
      stderr: "",
    };
  if (request.args.includes("get-template"))
    return {
      code: 0,
      stdout: JSON.stringify({
        TemplateBody: {
          Resources: {},
          Metadata: { TenkaCloudCloudComposition: "lite-baseline-v1" },
        },
      }),
      stderr: "",
    };
  if (request.args.includes("list-stack-resources"))
    return { code: 0, stdout: JSON.stringify({ StackResourceSummaries: [] }), stderr: "" };
  if (request.args.includes("get-parameter"))
    return {
      code: 0,
      stdout: JSON.stringify({ Type: "SecureString", Value: "synthetic-token" }),
      stderr: "",
    };
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
    else if (query.includes("ParticipantPortalUrl")) stdout = "https://portal.example.test\n";
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
  if (phase === "prepare") return request.command === "bash";
  if (phase === "toolkit") return request.args.includes("CDKToolkit");
  return request.args.includes(phase);
}
function fixture(
  options: {
    confirmed?: boolean;
    toolkitMissing?: boolean;
    fail?: (request: ProcessRequest) => ProcessResult | undefined;
  } = {},
) {
  const calls: ProcessRequest[] = [];
  const assemblies: (DestroyAssemblyTarget & { disposed: boolean })[] = [];
  const messages: string[] = [];
  const errors: string[] = [];
  const confirmations: string[] = [];
  const storageCalls: string[] = [];
  const locations: unknown[] = [];
  const probes: { url: string; token: string }[] = [];
  let toolkitInstalled = !options.toolkitMissing;
  const io: CloudCliIo = {
    createDestroyAssembly: (target) => {
      const assembly = { ...target, disposed: false };
      assemblies.push(assembly);
      return {
        directory: `/fixture/destroy-${target.name}`,
        dispose: () => {
          assembly.disposed = true;
        },
      };
    },
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
    probeTurso: async (url, token) => {
      probes.push({ url, token });
    },
    now: () => Date.parse("2026-10-01T14:00:00.000Z"),
    wait: async () => {
      throw new Error("Unexpected wait in CLI fixture");
    },
  };
  const env = {
    TENKACLOUD_STACK_LAYOUT: "cloud",
    TENKACLOUD_ADMIN_EMAIL: "organizer@example.test",
    CDK_PARAM_ENVIRONMENT: "staging",
    AWS_REGION: "ap-northeast-1",
    ACCOUNT_ID: "123456789012",
  };
  return {
    io,
    calls,
    assemblies,
    messages,
    errors,
    confirmations,
    storageCalls,
    locations,
    probes,
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
    const deploy = f.calls.find((call) => call.args.includes("deploy"));
    expect(deploy?.args.slice(2, 8)).toEqual([
      "--toolkit-stack-name",
      "CDKToolkit",
      "--profile",
      "",
      "--region",
      "ap-northeast-1",
    ]);
    expect(deploy?.args.slice(8)).toEqual([
      "deploy",
      "tenkacloud-cloud-problem-deploy-staging",
      "tenkacloud-cloud-staging",
      "--require-approval",
      "never",
    ]);
    expect(deploy?.env.CDK_PARAM_S3_BUCKET_NAME).toBe(
      "tenkacloud-source-123456789012-ap-northeast-1-1234abcd",
    );
    expect(deploy?.env.CDK_SOURCE_NAME).toBe(
      "source.zip.executions/00000000-0000-4000-8000-000000000000.zip",
    );
    expect(deploy?.env.CDK_SOURCE_VERSION_ID).toBe("version-A");
    expect(deploy?.env.CDK_PARAM_COMMIT_ID).toBe("a".repeat(32));
    expect(f.calls.filter((call) => call.command === "bash")).toHaveLength(2);
    expect(f.calls.findIndex((call) => call.args.includes("head-object"))).toBeLessThan(
      f.calls.findIndex((call) => call.args.includes("deploy")),
    );
    expect(
      f.calls.some(
        (call) =>
          call.args.includes("bootstrap") ||
          call.args.includes("create-stack") ||
          call.args.includes("update-stack"),
      ),
    ).toBe(false);
    expect(f.calls.slice(1).every((call) => call.env.AWS_DEFAULT_REGION === "ap-northeast-1")).toBe(
      true,
    );
    const create = f.calls.find((call) => call.args.includes("admin-create-user"));
    expect(create?.args).toContain("Name=custom:userRole,Value=TenantAdmin");
    expect(f.messages.join("")).toContain("https://console.example.test");
    expect(f.messages.join("")).toContain("https://portal.example.test");
    expect(f.messages.join("")).toContain(
      "competition backend with event, account, deployment and scoring services",
    );
    expect(f.messages.join("")).toContain("backed by DynamoDB");
    expect(f.messages.join("")).toContain("AWS usage and retained storage can incur charges");
    expect(f.messages.join("")).not.toContain("full competition lifecycle remains incomplete");
    expect(f.env).toEqual({
      TENKACLOUD_STACK_LAYOUT: "cloud",
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
    expect(f.calls).toHaveLength(8);
    expect(f.calls.slice(2, 4).every(platformInspection)).toBe(true);
    expect(f.calls.slice(4).map((call) => call.args[1])).toEqual([
      "get-template",
      "list-stack-resources",
      "get-template",
      "list-stack-resources",
    ]);
    expect(f.calls.some((call) => call.inherit)).toBe(false);
    expect(f.storageCalls).toEqual([]);
    expect(f.confirmations[0]).toContain("123456789012");
    expect(f.confirmations[0]).toContain("ap-northeast-1");
    expect(f.confirmations[0]).toContain(ownedStack("tenkacloud-cloud-staging").StackId);
    expect(f.confirmations[0]).toContain(
      ownedStack("tenkacloud-cloud-problem-deploy-staging").StackId,
    );
    expect(f.confirmations[0]).toContain("separately deployed exercise resources");
  });
  it.each([{ args: [] }, { args: ["--yes"] }])(
    "deletes verified app and backend ARNs without database access: %s",
    async ({ args }) => {
      const f = fixture({ confirmed: true });
      expect(await f.run(["down", ...args])).toBe(0);
      expect(f.calls).toHaveLength(10);
      expect(f.storageCalls).toEqual([]);
      const deletes = f.calls.filter((call) => call.args.includes("destroy"));
      expect(f.assemblies.map((assembly) => assembly.arn)).toEqual([
        ownedStack("tenkacloud-cloud-staging").StackId,
        ownedStack("tenkacloud-cloud-problem-deploy-staging").StackId,
      ]);
      expect(f.assemblies.every((assembly) => assembly.disposed)).toBe(true);
      expect(deletes.every((call) => !call.args.includes("--role-arn"))).toBe(true);
      expect(f.calls.filter((call) => call.args.includes("stack-delete-complete"))).toHaveLength(0);
      expect(deletes.every((call) => call.inherit)).toBe(true);
      expect(f.calls.some((call) => call.command === "bash")).toBe(false);
      expect(f.messages.join("")).toContain("Cloud platform stacks destroyed");
    },
  );
  it("stops teardown when the dependent app stack could not be destroyed", async () => {
    const f = fixture({
      confirmed: true,
      fail: (request) =>
        request.args.includes("destroy")
          ? { code: 3, stdout: "", stderr: "destroy failure" }
          : undefined,
    });
    expect(await f.run(["down"])).toBe(1);
    expect(f.calls).toHaveLength(9);
    expect(f.storageCalls).toEqual([]);
    expect(f.assemblies).toHaveLength(1);
    expect(f.assemblies[0]?.disposed).toBe(true);
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
      for (const name of Object.values(cloudStackNames("staging", "cloud"))) {
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
  it("rejects published cloud-v1 runner configuration before reads", async () => {
    const f = fixture();
    expect(
      await runCloudCli(["up"], f.io, {
        root: ROOT,
        env: { ...f.env, TENKACLOUD_RUNNER_BINDINGS: "[]" },
      }),
    ).toBe(1);
    expect(f.errors.join("")).toContain("incompatible cloud-v1 runner");
    expect(f.calls).toEqual([]);
  });
  it("rejects unsupported cloud-v1 event drain before reads or mutations", async () => {
    const f = fixture({ confirmed: true });
    expect(await f.run(["down", "--drain-events", "--yes"])).toBe(1);
    expect(f.errors.join("")).toContain("matching published release");
    expect(f.calls).toEqual([]);
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
      expect(deploy?.args.at(-1)).toBe("never");
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
      "--bootstrap-kms-key-id",
      "AWS_MANAGED_KEY",
    ]);
    expect(f.calls[0]?.inherit).toBeUndefined();
    expect(f.messages.join("")).toContain("AWS CDK: Default Resources");
    expect(f.messages.join("")).toContain("AdministratorAccess");
    expect(f.messages.join("")).toContain("not a TenkaCloud-scoped permission");
  });
  it("clears implicit CDK settings while preserving matching AWS profile aliases for all subprocesses", async () => {
    const f = fixture({ toolkitMissing: true, confirmed: true });
    const env = {
      ...f.env,
      AWS_PROFILE: "reviewed-profile",
      AWS_DEFAULT_PROFILE: "reviewed-profile",
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
    expect(f.calls.every((call) => call.env.AWS_DEFAULT_PROFILE === "reviewed-profile")).toBe(true);
    expect(f.messages.join("")).toContain("--profile ''");
    expect(f.messages.join("")).toContain("--bootstrap-kms-key-id AWS_MANAGED_KEY");
    expect(f.messages.join("")).not.toContain("--bootstrap-bucket-name");
    expect(f.messages.join("")).toContain(
      "S3 asset bucket cdk-hnb659fds-assets-123456789012-ap-northeast-1",
    );
    expect(env.AWS_PROFILE).toBe("reviewed-profile");
  });
  it("passes bootstrap preview arguments through the installed CDK parser without unknown options", async () => {
    const f = fixture();
    expect(await f.run(["up", "--show-setup"])).toBe(0);
    const preview = f.calls[0];
    expect(preview?.args).toContain("--show-template");
    const cdk = join(import.meta.dirname, "../../node_modules/aws-cdk/bin/cdk");
    const result = spawnSync(cdk, [...(preview?.args ?? []), "--notices", "false"], {
      cwd: join(import.meta.dirname, "../.."),
      env: {
        PATH: process.env.PATH,
        AWS_EC2_METADATA_DISABLED: "true",
        CDK_DISABLE_VERSION_CHECK: "1",
        CDK_DISABLE_CLI_TELEMETRY: "1",
      },
      encoding: "utf8",
      timeout: 10000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("Unknown option(s)");
    expect(result.stdout).toContain(
      `Fn::Sub: cdk-\${Qualifier}-assets-\${AWS::AccountId}-\${AWS::Region}`,
    );
    expect(f.calls).toHaveLength(1);
    expect(f.calls.every((call) => call.command !== "aws")).toBe(true);
  }, 15000);
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
  it.each([{ args: [] }, { args: ["--yes"] }, { args: ["-y"] }])(
    "restores automatic first deployment without invoking a declining confirmation stub: %s",
    async ({ args }) => {
      const f = fixture({ toolkitMissing: true, confirmed: false });
      expect(await f.run(["up", ...args])).toBe(0);
      expect(f.confirmations).toEqual([]);
      expect(f.calls.filter((call) => call.args.includes("bootstrap"))).toHaveLength(1);
      const deploy = f.calls.find((call) => call.args.includes("deploy"));
      expect(deploy?.args.slice(-2)).toEqual(["--require-approval", "never"]);
    },
  );
  it.each([
    { args: [], ci: undefined, prompts: 0 },
    { args: ["--yes"], ci: undefined, prompts: 0 },
    { args: ["--setup-if-needed", "--yes"], ci: "true", prompts: 0 },
  ])(
    "pins the standard bootstrap stack and qualifier before completing the same deploy: %s",
    async ({ args, ci, prompts }) => {
      const f = fixture({ toolkitMissing: true, confirmed: true });
      expect(
        await runCloudCli(["up", ...args], f.io, { root: ROOT, env: { ...f.env, CI: ci } }),
      ).toBe(0);
      expect(f.confirmations).toHaveLength(prompts);
      const notice = [...f.messages, ...f.confirmations].join("");
      expect(notice.match(/Creating standard CDKToolkit/gu)).toHaveLength(1);
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
      const build = f.calls.findIndex((call) => call.command === "bash");
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
    "restores plain CI deployment without an interactive approval gate: %s",
    async ({ args }) => {
      const f = fixture({ toolkitMissing: true, confirmed: false });
      expect(
        await runCloudCli(["up", ...args], f.io, { root: ROOT, env: { ...f.env, CI: "true" } }),
      ).toBe(0);
      expect(f.confirmations).toEqual([]);
      expect(f.errors).toEqual([]);
      expect(f.calls.some((call) => call.args.includes("bootstrap"))).toBe(true);
      expect(f.calls.find((call) => call.args.includes("deploy"))?.args.slice(-2)).toEqual([
        "--require-approval",
        "never",
      ]);
    },
  );
  it("deploys a fresh account after automatic toolkit bootstrap", async () => {
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
    expect(f.confirmations).toHaveLength(0);
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
    expect(f.calls.some((call) => call.args.includes("destroy"))).toBe(false);
    failDeploy = false;
    expect(await f.run(["up"])).toBe(0);
    expect(f.confirmations).toHaveLength(0);
    expect(f.calls.filter((call) => call.args.includes("bootstrap"))).toHaveLength(1);
  });
  it("rechecks before creation and reuses a toolkit installed by another caller", async () => {
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
    expect(f.confirmations).toHaveLength(0);
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
    expect(f.calls.some((call) => call.command === "bash" || call.args.includes("deploy"))).toBe(
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
      expect(f.calls.some((call) => call.command === "bash")).toBe(false);
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
    expect(f.calls.some((call) => call.command === "bash" || call.args.includes("deploy"))).toBe(
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
    expect(f.calls.some((call) => call.inherit || call.command === "bash")).toBe(false);
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
    expect(f.calls.some((call) => call.inherit || call.command === "bash")).toBe(false);
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
      expect(f.calls.some((call) => call.inherit || call.command === "bash")).toBe(false);
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

describe("cloud CLI platform teardown recovery", () => {
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
        if (!resumed && request.args.includes("destroy") && request.args.includes(backend))
          return { code: 3, stdout: "", stderr: "Synthetic backend failure" };
        return undefined;
      },
    });
    expect(await f.run(["down", "--yes"])).toBe(1);
    resumed = true;
    const before = f.calls.length;
    expect(await f.run(["down", "--yes"])).toBe(0);
    expect(
      f.calls
        .slice(before)
        .filter((call) => call.args.includes("destroy"))
        .map((call) => call.args[call.args.indexOf("destroy") + 1]),
    ).toEqual([backend]);
  });
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
    expect(f.calls.filter((call) => call.args.includes("destroy"))).toHaveLength(1);
    expect(f.calls.find((call) => call.args.includes("destroy"))?.args).toContain(backend);
    expect(f.calls.filter((call) => call.args.includes("stack-delete-complete"))).toHaveLength(1);
    expect(f.assemblies.map((assembly) => assembly.arn)).toEqual([ownedStack(backend).StackId]);
  });
  it("waits for an update to complete before removing platform stacks", async () => {
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
    expect(f.calls.some((call) => call.args.includes("destroy"))).toBe(false);
  });
});

describe("owned failed-stack bucket cleanup through make destroy", () => {
  function buckets(
    options: { confirmed?: boolean; fault?: "tags" | "delete"; retain?: boolean } = {},
  ) {
    const name = "tenkacloud-cloud-staging-owned-console";
    const stack = ownedStack("tenkacloud-cloud-staging");
    let empty = false;
    const json = (value: unknown): ProcessResult => ({
      code: 0,
      stderr: "",
      stdout: JSON.stringify(value),
    });
    const metadata = (ours: boolean) =>
      json({
        TemplateBody: {
          Resources: ours
            ? {
                OrganizerBucket: {
                  Type: "AWS::S3::Bucket",
                  DeletionPolicy: options.retain ? "Retain" : "Delete",
                },
              }
            : {},
          Outputs: { CloudControlDataBackend: { Value: "dynamodb" } },
        },
      });
    const inventory = (ours: boolean) =>
      json({
        StackResourceSummaries: ours
          ? [
              {
                LogicalResourceId: "OrganizerBucket",
                PhysicalResourceId: name,
                ResourceType: "AWS::S3::Bucket",
                ResourceStatus: "DELETE_FAILED",
              },
            ]
          : [],
      });
    const tags = () =>
      json({
        TagSet: Object.entries({
          ...cloudStackTags("staging"),
          "aws:cloudformation:stack-id": options.fault === "tags" ? "another-stack" : stack.StackId,
          "aws:cloudformation:logical-id": "OrganizerBucket",
        }).map(([Key, Value]) => ({ Key, Value })),
      });
    const versions = () =>
      json(
        empty
          ? { IsTruncated: false }
          : {
              IsTruncated: false,
              Versions: [{ Key: "index.html", VersionId: "old-version" }],
              DeleteMarkers: [{ Key: "index.html", VersionId: "delete-marker" }],
            },
      );
    const s3 = (request: ProcessRequest): ProcessResult => {
      expect(request.args[request.args.indexOf("--expected-bucket-owner") + 1]).toBe(
        "123456789012",
      );
      expect(request.args[request.args.indexOf("--bucket") + 1]).toBe(name);
      switch (request.args[1]) {
        case "get-bucket-tagging":
          return tags();
        case "list-object-versions":
          return versions();
        case "delete-objects":
          if (options.fault === "delete") return { code: 1, stdout: "", stderr: "AccessDenied" };
          empty = true;
          return { code: 0, stdout: "", stderr: "" };
        default:
          throw new Error("Unexpected S3 operation");
      }
    };
    const f = fixture({
      confirmed: options.confirmed ?? true,
      fail: (request) => {
        if (platformInspection(request) && request.args.includes(stack.StackName))
          return json({ ...stack, StackStatus: "ROLLBACK_FAILED", Outputs: undefined });
        if (request.args.includes("get-template"))
          return metadata(request.args.includes(stack.StackId));
        if (request.args.includes("list-stack-resources"))
          return inventory(request.args.includes(stack.StackId));
        return request.args[0] === "s3api" ? s3(request) : undefined;
      },
    });
    return { ...f, name };
  }
  it("confirms exact ownership, empties versions/markers and verifies empty before CDK destroys failed stacks", async () => {
    const f = buckets();
    expect(await f.run(["down"])).toBe(0);
    expect(f.confirmations).toHaveLength(1);
    const deletion = f.calls.findIndex((call) => call.args.includes("delete-objects"));
    expect(deletion).toBeGreaterThan(0);
    const payload = f.calls[deletion]?.args;
    expect(JSON.parse(payload?.[payload.indexOf("--delete") + 1] ?? "null")).toEqual({
      Objects: [
        { Key: "index.html", VersionId: "old-version" },
        { Key: "index.html", VersionId: "delete-marker" },
      ],
      Quiet: true,
    });
    const verified = f.calls.findIndex(
      (call, index) => index > deletion && call.args.includes("list-object-versions"),
    );
    expect(verified).toBeGreaterThan(deletion);
    expect(f.calls.findIndex((call) => call.args.includes("destroy"))).toBeGreaterThan(verified);
    expect(f.storageCalls).toEqual([]);
    expect(f.calls.some((call) => call.args[0] === "dynamodb")).toBe(false);
    expect(f.messages.join("")).toContain(f.name);
  });
  it("does no object listing/deletion when the user declines, and a plan never mutates", async () => {
    for (const args of [["down"], ["down", "--plan"]]) {
      const f = buckets({ confirmed: false });
      expect(await f.run(args)).toBe(0);
      expect(
        f.calls.some((call) =>
          ["list-object-versions", "delete-objects", "destroy"].some((arg) =>
            call.args.includes(arg),
          ),
        ),
      ).toBe(false);
    }
  });
  it.each(["tags", "delete"] as const)(
    "stops before stack deletion for %s failure",
    async (fault) => {
      const f = buckets({ fault });
      expect(await f.run(["down"])).toBe(1);
      expect(f.calls.some((call) => call.args.includes("destroy"))).toBe(false);
      expect(f.messages.join("")).not.toContain("Cloud platform stacks destroyed");
    },
  );
  it("keeps retained objects for ordinary destroy and names them in explicit-purge consent", async () => {
    const ordinary = buckets({ retain: true });
    expect(await ordinary.run(["down"])).toBe(0);
    expect(ordinary.calls.some((call) => call.args[0] === "s3api")).toBe(false);
    const purge = buckets({ retain: true });
    expect(await purge.run(["down", "--purge-retained-data"])).toBe(0);
    expect(purge.confirmations[0]).toContain("S3 object versions/delete markers");
    expect(purge.confirmations[0]).toContain("bucket containers remain");
    expect(purge.calls.some((call) => call.args.includes("delete-objects"))).toBe(true);
    expect(purge.calls.some((call) => call.args.includes("delete-bucket"))).toBe(false);
  });
});

describe("original platform destroy contract", () => {
  const names = cloudStackNames("staging", "cloud");
  it.each([
    "CREATE_COMPLETE",
    "CREATE_FAILED",
    "ROLLBACK_COMPLETE",
    "ROLLBACK_FAILED",
    "DELETE_FAILED",
  ])("removes %s stacks without outputs, table scans or database access", async (StackStatus) => {
    const f = fixture({
      confirmed: true,
      fail: (request) => {
        if (!platformInspection(request)) return undefined;
        const name = request.args[request.args.indexOf("--stack-name") + 1] ?? "";
        const stack = { ...ownedStack(name), Outputs: undefined };
        return { code: 0, stderr: "", stdout: JSON.stringify({ ...stack, StackStatus }) };
      },
    });
    expect(await f.run(["down"])).toBe(0);
    expect(f.locations).toEqual([]);
    expect(f.storageCalls).toEqual([]);
    expect(f.assemblies.map((assembly) => assembly.arn)).toEqual([
      ownedStack(names.app).StackId,
      ownedStack(names.backend).StackId,
    ]);
    expect(
      f.calls.some((request) =>
        ["scan", "describe-table", "update-table", "delete-table"].some((value) =>
          request.args.includes(value),
        ),
      ),
    ).toBe(false);
  });
  it.each([names.app, names.backend])(
    "removes the remaining stack when %s is absent",
    async (absent) => {
      const f = fixture({
        confirmed: true,
        fail: (request) =>
          platformInspection(request) && request.args.includes(absent)
            ? {
                code: 1,
                stdout: "",
                stderr: `(ValidationError) Stack with id ${absent} does not exist`,
              }
            : undefined,
      });
      expect(await f.run(["down", "--yes"])).toBe(0);
      expect(f.locations).toEqual([]);
      expect(f.calls.filter((request) => request.args.includes("destroy"))).toHaveLength(1);
    },
  );
  it("does not treat a purge option as consent", async () => {
    const f = fixture({
      fail: (request) => {
        if (request.args.includes("get-template"))
          return {
            code: 0,
            stdout: JSON.stringify({
              TemplateBody: {
                Resources: {},
                Metadata: { TenkaCloudCloudComposition: "lite-baseline-v1" },
              },
            }),
            stderr: "",
          };
        if (request.args.includes("list-stack-resources"))
          return { code: 0, stdout: JSON.stringify({ StackResourceSummaries: [] }), stderr: "" };
        return undefined;
      },
    });
    expect(await f.run(["down", "--purge-retained-data"])).toBe(0);
    expect(f.confirmations).toHaveLength(1);
    expect(f.confirmations[0]).toContain("permanently purge");
    expect(f.calls.some((request) => request.args.includes("destroy"))).toBe(false);
  });
  it("prints failed up status before checking outputs", async () => {
    const f = fixture({
      fail: (request) => {
        if (!platformInspection(request)) return undefined;
        const name = request.args[request.args.indexOf("--stack-name") + 1] ?? "";
        const stack = { ...ownedStack(name), Outputs: undefined };
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({ ...stack, StackStatus: "ROLLBACK_COMPLETE" }),
        };
      },
    });
    expect(await f.run(["up"])).toBe(1);
    expect(f.errors.join("")).toContain("ROLLBACK_COMPLETE");
    expect(f.errors.join("")).toContain("make destroy ENV=staging");
    expect(f.errors.join("")).not.toContain("Zod");
    expect(f.calls.some((request) => request.inherit)).toBe(false);
  });
});

describe("explicit Turso destruction sequence", () => {
  function deployedTursoStack(request: ProcessRequest): ProcessResult {
    const name = request.args[request.args.indexOf("--stack-name") + 1] ?? "";
    const stack = ownedStack(name);
    if (name === cloudStackNames("staging", "cloud").backend)
      stack.Outputs = [
        { OutputKey: "CloudControlDataBackend", OutputValue: "turso" },
        { OutputKey: "TursoDatabaseUrl", OutputValue: "https://deployed.turso.io" },
        { OutputKey: "TursoAuthTokenParameterName", OutputValue: "/deployed/turso/token" },
      ];
    return { code: 0, stdout: JSON.stringify(stack), stderr: "" };
  }
  function removeFixtureLog(
    request: ProcessRequest,
    liveLogs: Set<string>,
    denied: boolean | undefined,
    stacksRemoved: boolean,
  ): ProcessResult {
    if (denied && stacksRemoved) return { code: 1, stdout: "", stderr: "AccessDeniedException" };
    const name = request.args[request.args.indexOf("--log-group-name") + 1] ?? "";
    return liveLogs.delete(name)
      ? { code: 0, stdout: "", stderr: "" }
      : { code: 1, stdout: "", stderr: "(ResourceNotFoundException) Log group is absent" };
  }
  function tursoFixture(options: { resetFails?: boolean; finalLogFailure?: boolean } = {}) {
    const order: string[] = [];
    const liveLogs = new Set(["/owned/logs", "/unrelated/logs"]);
    const f = fixture({
      confirmed: true,
      fail: (request) => {
        if (platformInspection(request)) return deployedTursoStack(request);
        if (request.args.includes("get-template"))
          return {
            code: 0,
            stdout: JSON.stringify({
              TemplateBody: { Resources: { Logs: { Type: "AWS::Logs::LogGroup" } } },
            }),
            stderr: "",
          };
        if (request.args.includes("list-stack-resources"))
          return {
            code: 0,
            stdout: JSON.stringify({
              StackResourceSummaries: [
                {
                  LogicalResourceId: "Logs",
                  ResourceType: "AWS::Logs::LogGroup",
                  PhysicalResourceId: "/owned/logs",
                  ResourceStatus: "CREATE_COMPLETE",
                },
              ],
            }),
            stderr: "",
          };
        if (request.args.includes("delete-log-group")) {
          order.push("purge-logs");
          return removeFixtureLog(
            request,
            liveLogs,
            options.finalLogFailure,
            order.includes("destroy"),
          );
        }
        if (request.args.includes("destroy")) {
          order.push("destroy");
          liveLogs.add("/owned/logs");
        }
        return undefined;
      },
    });
    const targets: unknown[] = [];
    f.io.purgeTursoControlData = async (target) => {
      order.push("turso-reset");
      targets.push(target);
      if (options.resetFails) throw new Error("database unavailable");
    };
    return { ...f, order, targets, liveLogs };
  }
  it("purges exact AWS logs then deployed Turso rows before removing AWS stacks", async () => {
    const f = tursoFixture();
    expect(
      await runCloudCli(["down", "--purge-retained-data"], f.io, {
        root: ROOT,
        env: {
          ...f.env,
          CDK_PARAM_CONTROL_DATA_BACKEND: "dynamodb",
          CDK_PARAM_TURSO_DATABASE_URL: "https://different.turso.io",
        },
      }),
    ).toBe(0);
    expect(f.order).toEqual(["purge-logs", "turso-reset", "destroy", "destroy", "purge-logs"]);
    expect(f.targets).toEqual([
      {
        databaseUrl: "https://deployed.turso.io",
        parameterName: "/deployed/turso/token",
        region: "ap-northeast-1",
        schema: "cloud-v1",
      },
    ]);
    expect(f.confirmations[0]).toContain("permanently deleted");
    expect(f.confirmations[0]).toContain("https://deployed.turso.io");
    expect(f.locations).toEqual([]);
  });
  it("removes only captured logs recreated during successful platform deletion", async () => {
    const f = tursoFixture();
    expect(await f.run(["down", "--purge-retained-data", "--yes"])).toBe(0);
    expect([...f.liveLogs]).toEqual(["/unrelated/logs"]);
    const cleanup = f.calls.filter((request) => request.args.includes("delete-log-group"));
    expect(
      cleanup.map((request) => request.args[request.args.indexOf("--log-group-name") + 1]),
    ).toEqual(["/owned/logs", "/owned/logs"]);
    const lastDestroy = f.calls.findLastIndex((request) => request.args.includes("destroy"));
    expect(
      f.calls.slice(lastDestroy + 1).every((request) => request.args.includes("delete-log-group")),
    ).toBe(true);
    expect(f.calls.filter((request) => request.args.includes("get-template"))).toHaveLength(2);
    expect(f.calls.filter((request) => request.args.includes("list-stack-resources"))).toHaveLength(
      2,
    );
  });
  it("does not run final log cleanup after a failed platform deletion", async () => {
    const f = tursoFixture();
    const run = f.io.run;
    f.io.run = async (request) => {
      const result = await run(request);
      return request.args.includes("destroy")
        ? { code: 1, stdout: "", stderr: "Fixture stack deletion failed" }
        : result;
    };
    expect(await f.run(["down", "--purge-retained-data", "--yes"])).toBe(1);
    expect(f.order).toEqual(["purge-logs", "turso-reset", "destroy"]);
    expect([...f.liveLogs]).toContain("/owned/logs");
    expect(f.errors.join("")).not.toContain("Platform stacks were already removed");
  });
  it("reports that stacks are already removed when captured-log final cleanup fails", async () => {
    const f = tursoFixture({ finalLogFailure: true });
    expect(await f.run(["down", "--purge-retained-data", "--yes"])).toBe(1);
    expect(f.order).toEqual(["purge-logs", "turso-reset", "destroy", "destroy", "purge-logs"]);
    expect(f.errors.join("")).toContain("Platform stacks were already removed");
    expect(f.errors.join("")).toContain("saved physical-resource inventory");
    expect(f.errors.join("")).toContain("removed stacks cannot provide a new ownership plan");
    expect(f.errors.join("")).toContain("AccessDeniedException");
    expect(f.messages.join("")).not.toContain("Cloud platform stacks destroyed.");
    expect([...f.liveLogs]).toContain("/owned/logs");
  });
  it("preserves AWS stacks and SSM access when Turso reset fails", async () => {
    const f = tursoFixture({ resetFails: true });
    expect(await f.run(["down", "--purge-retained-data", "--yes"])).toBe(1);
    expect(f.order).toEqual(["purge-logs", "turso-reset"]);
    expect(f.errors.join("")).toContain("preserve SSM access");
  });
  it("ordinary destroy warns and never invokes Turso reset", async () => {
    const f = tursoFixture();
    expect(await f.run(["down", "--yes"])).toBe(0);
    expect(f.order).toEqual(["destroy", "destroy"]);
    expect(f.messages.join("")).toContain("Turso control-data rows remain");
    expect(f.targets).toEqual([]);
  });
  it("read-only plan neither confirms nor mutates", async () => {
    const f = tursoFixture();
    expect(await f.run(["down", "--plan"])).toBe(0);
    expect(f.confirmations).toEqual([]);
    expect(f.order).toEqual([]);
    expect(f.locations).toEqual([]);
  });
});

const tursoEnvironment = {
  CDK_PARAM_CONTROL_DATA_BACKEND: " TURSO ",
  CDK_PARAM_TURSO_DATABASE_URL: "libsql://owned.turso.io",
  CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME: "/TenkaCloud/staging/turso/auth-token",
};
function tursoStackResponse(request: ProcessRequest): ProcessResult | undefined {
  if (!platformInspection(request)) return undefined;
  const name = request.args[request.args.indexOf("--stack-name") + 1] ?? "";
  const stack = ownedStack(name);
  stack.Outputs = [
    { OutputKey: "CloudComposition", OutputValue: "lite-baseline-v1" },
    { OutputKey: "CloudControlDataBackend", OutputValue: "turso" },
    { OutputKey: "TursoDatabaseUrl", OutputValue: "https://owned.turso.io" },
    {
      OutputKey: "TursoAuthTokenParameterName",
      OutputValue: "/TenkaCloud/staging/turso/auth-token",
    },
  ];
  return { code: 0, stdout: JSON.stringify(stack), stderr: "" };
}
describe("standalone selected Turso reset routing", () => {
  it.each([[], ["--plan"], ["--yes"], ["-y"]].map((args) => ({ args })))(
    "resolves the selected database without requiring CloudFormation stacks: %j",
    async ({ args }) => {
      const f = fixture();
      let resets = 0;
      f.io.resetSelectedTursoData = async (target, options) => {
        resets++;
        expect(target).toEqual({
          environment: "staging",
          account: "123456789012",
          region: "ap-northeast-1",
          databaseUrl: "https://owned.turso.io",
          parameterName: "/TenkaCloud/staging/turso/auth-token",
        });
        expect(options.plan).toBe(args.includes("--plan"));
        expect(options.yes).toBe(args.includes("--yes") || args.includes("-y"));
        expect(options.confirm).toBe(f.io.confirm);
      };
      expect(
        await runCloudCli(["turso-reset", ...args], f.io, {
          root: ROOT,
          env: { ...f.env, ...tursoEnvironment },
        }),
      ).toBe(0);
      expect(resets).toBe(1);
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]?.args).toContain("get-caller-identity");
      expect(f.confirmations).toEqual([]);
    },
  );
  it("loads only the selected environment file and applies credential-source guards", async () => {
    const root = mkdtempSync(join(tmpdir(), "standalone-turso-env-"));
    try {
      mkdirSync(join(root, "infrastructure/environments/staging"), { recursive: true });
      writeFileSync(
        join(root, "infrastructure/environments/staging/.env"),
        Object.entries({ ...tursoEnvironment, AWS_PROFILE: "synthetic-profile" })
          .map(([key, value]) => `${key}=${value}`)
          .join("\n"),
      );
      const f = fixture();
      let selected: string | undefined;
      f.io.configureEnvironment = (env) => {
        selected = env.AWS_PROFILE;
      };
      f.io.resetSelectedTursoData = async (target) => {
        expect(selected).toBe("synthetic-profile");
        expect(target.databaseUrl).toBe("https://owned.turso.io");
      };
      expect(await runCloudCli(["turso-reset", "--plan"], f.io, { root, env: f.env })).toBe(0);
      f.calls.length = 0;
      expect(
        await runCloudCli(["turso-reset", "--yes"], f.io, {
          root,
          env: { ...f.env, AWS_ACCESS_KEY_ID: "synthetic-access-id" },
        }),
      ).toBe(1);
      expect(f.calls).toEqual([]);
      expect(f.errors.join("")).not.toContain("synthetic-access-id");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it.each([
    {},
    {
      ...tursoEnvironment,
      CDK_PARAM_TURSO_DATABASE_URL: "https://user:synthetic-secret@owned.turso.io",
    },
    { ...tursoEnvironment, CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME: "/turso/*" },
  ])(
    "rejects incomplete or unsafe targets before account/credential/database reads: %j",
    async (configuration) => {
      const f = fixture();
      expect(
        await runCloudCli(["turso-reset", "--yes"], f.io, {
          root: ROOT,
          env: { ...f.env, ...configuration },
        }),
      ).toBe(1);
      expect(f.calls).toEqual([]);
      expect(f.errors.join("")).not.toContain("synthetic-secret");
    },
  );
  it("keeps reset help offline and rejects retired/unknown arguments", async () => {
    for (const args of [["--help"], ["--purge-retained-data"], ["--rotate-token"]]) {
      const f = fixture();
      expect(await f.run(["turso-reset", ...args])).toBe(args[0] === "--help" ? 0 : 1);
      expect(f.calls).toEqual([]);
    }
  });
});

describe("selected cloud data deployment and teardown", () => {
  it("configures SDK environment before resolving or mutating the deployment", async () => {
    let configured: string | undefined;
    const f = fixture({
      fail: () => {
        expect(configured).toBe("selected-profile");
        return undefined;
      },
    });
    f.io.configureEnvironment = (env) => {
      configured = env.AWS_PROFILE;
    };
    expect(
      await runCloudCli(["up"], f.io, {
        root: ROOT,
        env: { ...f.env, AWS_PROFILE: "selected-profile" },
      }),
    ).toBe(0);
  });
  it("validates Turso configuration before AWS or storage access", async () => {
    const f = fixture();
    expect(
      await runCloudCli(["up"], f.io, {
        root: ROOT,
        env: { ...f.env, CDK_PARAM_CONTROL_DATA_BACKEND: "turso" },
      }),
    ).toBe(1);
    expect(f.errors.join("")).toContain("CDK_PARAM_TURSO_DATABASE_URL");
    expect(f.calls).toEqual([]);
    expect(f.locations).toEqual([]);
  });
  it("passes selected Turso settings to CDK on a fresh deployment without Dynamo table requirements", async () => {
    const f = fixture({
      fail: (request) => {
        if (!platformInspection(request)) return undefined;
        const name = request.args[request.args.indexOf("--stack-name") + 1] ?? "";
        return {
          code: 1,
          stdout: "",
          stderr: `(ValidationError) Stack with id ${name} does not exist`,
        };
      },
    });
    expect(
      await runCloudCli(["up"], f.io, { root: ROOT, env: { ...f.env, ...tursoEnvironment } }),
    ).toBe(0);
    expect(f.locations).toEqual([]);
    expect(f.calls.find((request) => request.args.includes("deploy"))?.env).toMatchObject(
      tursoEnvironment,
    );
    expect(f.messages.join("")).toContain("backed by Turso");
    expect(f.messages.join("")).toContain("read-only preflight passed");
    expect(f.probes).toEqual([{ url: "https://owned.turso.io", token: "synthetic-token" }]);
    const preflight = f.calls.findIndex((request) => request.args.includes("get-parameter"));
    expect(preflight).toBeGreaterThan(-1);
    expect(preflight).toBeLessThan(f.calls.findIndex((request) => request.command === "bash"));
  });
  it("stops fresh Turso deployment before bootstrap/build when the saved token is rejected", async () => {
    const f = fixture({
      toolkitMissing: true,
      fail: (request) =>
        platformInspection(request)
          ? {
              code: 1,
              stdout: "",
              stderr: `(ValidationError) Stack with id ${request.args[request.args.indexOf("--stack-name") + 1]} does not exist`,
            }
          : undefined,
    });
    f.io.probeTurso = async () => {
      throw new Error("UNAUTHORIZED synthetic-token");
    };
    expect(
      await runCloudCli(["up"], f.io, {
        root: ROOT,
        env: { ...f.env, ...tursoEnvironment, AWS_PROFILE: "selected-profile" },
      }),
    ).toBe(1);
    expect(f.errors.join("")).toContain("authenticated SELECT 1 failed");
    expect(f.errors.join("")).not.toContain("synthetic-token");
    expect(f.calls.find((request) => request.args.includes("get-parameter"))?.env.AWS_PROFILE).toBe(
      "selected-profile",
    );
    expect(
      f.calls.some(
        (request) =>
          request.command === "bash" ||
          request.args.includes("bootstrap") ||
          request.args.includes("deploy"),
      ),
    ).toBe(false);
    expect(f.locations).toEqual([]);
  });
  it("checks an existing restored Turso database without opening or changing repositories", async () => {
    const f = fixture({ fail: tursoStackResponse });
    expect(
      await runCloudCli(["up"], f.io, { root: ROOT, env: { ...f.env, ...tursoEnvironment } }),
    ).toBe(0);
    expect(f.probes).toEqual([{ url: "https://owned.turso.io", token: "synthetic-token" }]);
  });
  it("blocks Dynamo to Turso changes before opening a repository, bootstrap, build or mutation", async () => {
    const f = fixture();
    expect(
      await runCloudCli(["up"], f.io, { root: ROOT, env: { ...f.env, ...tursoEnvironment } }),
    ).toBe(1);
    expect(f.errors.join("")).toContain("No automatic data migration");
    expect(f.locations).toEqual([]);
    expect(
      f.calls.every(
        (request) =>
          request.args.includes("get-caller-identity") ||
          platformInspection(request) ||
          request.args.includes("get-template"),
      ),
    ).toBe(true);
  });
  it.each([{}, { ...tursoEnvironment, CDK_PARAM_TURSO_DATABASE_URL: "https://other.turso.io" }])(
    "blocks Turso provider/database replacement before any mutation",
    async (desired) => {
      const f = fixture({ fail: tursoStackResponse });
      expect(await runCloudCli(["up"], f.io, { root: ROOT, env: { ...f.env, ...desired } })).toBe(
        1,
      );
      expect(f.errors.join("")).toContain("No automatic data migration");
      expect(f.locations).toEqual([]);
      expect(
        f.calls.every(
          (request) =>
            request.args.includes("get-caller-identity") ||
            platformInspection(request) ||
            request.args.includes("get-template"),
        ),
      ).toBe(true);
    },
  );
  it("ordinary Turso destroy works despite invalid local database configuration and unavailable storage", async () => {
    const f = fixture({ fail: tursoStackResponse });
    expect(
      await runCloudCli(["down", "--yes"], f.io, {
        root: ROOT,
        env: { ...f.env, CDK_PARAM_CONTROL_DATA_BACKEND: "invalid" },
      }),
    ).toBe(0);
    expect(f.storageCalls).toEqual([]);
    expect(f.calls.filter((request) => request.args.includes("destroy"))).toHaveLength(2);
  });
});

describe("restored backend compatibility boundary", () => {
  it.each([
    "CloudRunnerEnabled",
    "CloudInstallationControlVersion",
    "CloudRunnerMode",
    "CloudLegacyBindingsDigest",
  ])("rejects published %s before bootstrap or source preparation", async (marker) => {
    const f = fixture({
      toolkitMissing: true,
      fail: (request) => {
        if (!platformInspection(request)) return undefined;
        const name = request.args[request.args.indexOf("--stack-name") + 1] ?? "";
        const stack = ownedStack(name);
        stack.Outputs.push({ OutputKey: marker, OutputValue: "published" });
        return { code: 0, stdout: JSON.stringify(stack), stderr: "" };
      },
    });
    expect(await f.run(["up"])).toBe(1);
    expect(f.errors.join("")).toContain("published cloud-v1 resource layout");
    expect(f.errors.join("")).toContain("different ENV");
    expect(f.calls.every((call) => call.command === "aws" && !call.inherit)).toBe(true);
    expect(f.calls.some((call) => call.args.includes("CDKToolkit"))).toBe(false);
  });
  it.each([
    ["OrganizerUserPool1234ABCD", "AWS::Cognito::UserPool"],
    ["EventsABC12345", "AWS::DynamoDB::Table"],
    ["TeamsABC12345", "AWS::DynamoDB::Table"],
    ["DeploymentsABC12345", "AWS::DynamoDB::Table"],
    ["CloudApiABC12345", "AWS::Lambda::Function"],
  ])(
    "rejects the published logical ID %s even if output metadata claims compatibility",
    async (id, type) => {
      const f = fixture({
        fail: (request) =>
          request.args.includes("get-template")
            ? {
                code: 0,
                stderr: "",
                stdout: JSON.stringify({
                  TemplateBody: {
                    Metadata: { TenkaCloudCloudComposition: "lite-baseline-v1" },
                    Resources: { [id]: { Type: type } },
                  },
                }),
              }
            : undefined,
      });
      expect(await f.run(["up"])).toBe(1);
      expect(f.errors.join("")).toContain("incompatible");
      expect(f.calls.every((call) => call.command === "aws" && !call.inherit)).toBe(true);
    },
  );
  it("rejects unknown resource contracts and ambiguous composition outputs", async () => {
    for (const entries of [[], ["other"], ["lite-baseline-v1", "lite-baseline-v1"]]) {
      const f = fixture({
        fail: (request) => {
          if (!platformInspection(request)) return undefined;
          const name = request.args[request.args.indexOf("--stack-name") + 1] ?? "";
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              ...ownedStack(name),
              Outputs: entries.map((OutputValue) => ({
                OutputKey: "CloudComposition",
                OutputValue,
              })),
            }),
          };
        },
      });
      expect(await f.run(["up"])).toBe(1);
      expect(f.calls.some((call) => call.inherit || call.command === "bash")).toBe(false);
    }
  });
  it("retains ordinary destroy recovery for a published cloud-v1 stack", async () => {
    const f = fixture({
      confirmed: true,
      fail: (request) => {
        if (!platformInspection(request)) return undefined;
        const name = request.args[request.args.indexOf("--stack-name") + 1] ?? "";
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            ...ownedStack(name),
            Outputs: [{ OutputKey: "CloudRunnerEnabled", OutputValue: "true" }],
          }),
        };
      },
    });
    expect(await f.run(["down"])).toBe(0);
    expect(f.calls.filter((call) => call.args.includes("destroy"))).toHaveLength(2);
  });
});

describe("partial restored installation storage identity", () => {
  it("rejects an app-only provider change before bootstrap or source upload", async () => {
    const f = fixture({
      fail: (request) => {
        if (
          !platformInspection(request) ||
          !request.args.includes(cloudStackNames("staging", "cloud").backend)
        )
          return undefined;
        return {
          code: 1,
          stdout: "",
          stderr: `(ValidationError) Stack with id ${cloudStackNames("staging", "cloud").backend} does not exist`,
        };
      },
    });
    expect(
      await runCloudCli(["up"], f.io, { root: ROOT, env: { ...f.env, ...tursoEnvironment } }),
    ).toBe(1);
    expect(f.errors.join("")).toContain("No automatic data migration");
    expect(f.calls.some((call) => call.command === "bash" || call.inherit)).toBe(false);
  });
  it("can explicitly purge a remaining restored app's verified Turso database", async () => {
    const targets: unknown[] = [];
    const f = fixture({
      confirmed: true,
      fail: (request) => {
        if (
          platformInspection(request) &&
          request.args.includes(cloudStackNames("staging", "cloud").backend)
        )
          return {
            code: 1,
            stdout: "",
            stderr: `(ValidationError) Stack with id ${cloudStackNames("staging", "cloud").backend} does not exist`,
          };
        return tursoStackResponse(request);
      },
    });
    f.io.purgeTursoControlData = async (target) => {
      targets.push(target);
    };
    expect(await f.run(["down", "--purge-retained-data"])).toBe(0);
    expect(targets).toEqual([
      {
        databaseUrl: "https://owned.turso.io",
        parameterName: "/TenkaCloud/staging/turso/auth-token",
        schema: "lite-baseline-v1",
        region: "ap-northeast-1",
      },
    ]);
    expect(f.calls.filter((call) => call.args.includes("destroy"))).toHaveLength(1);
  });
});

describe("cloud naming with automatic installation discovery", () => {
  const lite = cloudStackNames("staging", "lite");
  const cloud = cloudStackNames("staging", "cloud");
  function discoveredResponse(
    request: ProcessRequest,
    names: readonly string[],
    overrides: Record<string, unknown> = {},
  ): ProcessResult | undefined {
    if (!request.args.includes("describe-stacks") || !request.args.includes("Stacks[0]"))
      return undefined;
    const name = request.args[request.args.indexOf("--stack-name") + 1] ?? "";
    if (name === "CDKToolkit") return undefined;
    return names.includes(name)
      ? { code: 0, stderr: "", stdout: JSON.stringify({ ...ownedStack(name), ...overrides }) }
      : {
          code: 1,
          stdout: "",
          stderr: `(ValidationError) Stack with id ${name} does not exist`,
        };
  }
  it.each([
    { present: [], expected: cloud, layout: "cloud" },
    { present: Object.values(lite), expected: lite, layout: "lite" },
    { present: Object.values(cloud), expected: cloud, layout: "cloud" },
  ])(
    "deploys only the selected restored installation: %j",
    async ({ present, expected, layout }) => {
      const f = fixture({ fail: (request) => discoveredResponse(request, present) });
      expect(
        await runCloudCli(["up"], f.io, {
          root: ROOT,
          env: { ...f.env, TENKACLOUD_STACK_LAYOUT: undefined },
        }),
      ).toBe(0);
      expect(f.errors).toEqual([]);
      expect(f.confirmations).toEqual([]);
      const deploy = f.calls.find((call) => call.args.includes("deploy"));
      expect(deploy?.args.slice(-5)).toEqual([
        "deploy",
        expected.backend,
        expected.app,
        "--require-approval",
        "never",
      ]);
      expect(deploy?.env.TENKACLOUD_STACK_LAYOUT).toBe(layout);
      expect(f.calls.some((call) => call.args.includes("destroy"))).toBe(false);
    },
  );
  it("refuses the existing narrowed cloud-v1 contract despite matching the new default names", async () => {
    const f = fixture({
      fail: (request) => {
        if (request.args.includes("get-template"))
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              TemplateBody: {
                Resources: { CloudApiABC12345: { Type: "AWS::Lambda::Function" } },
                Outputs: { CloudRunnerEnabled: { Value: "true" } },
              },
            }),
          };
        return discoveredResponse(request, Object.values(cloud), { Outputs: [] });
      },
    });
    expect(
      await runCloudCli(["up"], f.io, {
        root: ROOT,
        env: { ...f.env, TENKACLOUD_STACK_LAYOUT: undefined },
      }),
    ).toBe(1);
    expect(f.errors.join(" ")).toContain("published cloud-v1 resource layout");
    expect(f.calls.some((call) => call.inherit || call.command === "bash")).toBe(false);
    expect(f.calls.some((call) => call.args.includes("CDKToolkit"))).toBe(false);
  });
  it.each(["lite", "cloud"] as const)(
    "keeps failed %s stacks with no Outputs selected for explicit recovery, never fresh deployment",
    async (layout) => {
      const names = cloudStackNames("staging", layout);
      const fail = (request: ProcessRequest) =>
        discoveredResponse(request, Object.values(names), {
          StackStatus: "ROLLBACK_COMPLETE",
          Outputs: undefined,
        });
      const deployment = fixture({ fail });
      expect(
        await runCloudCli(["up"], deployment.io, {
          root: ROOT,
          env: { ...deployment.env, TENKACLOUD_STACK_LAYOUT: undefined },
        }),
      ).toBe(1);
      expect(deployment.calls.some((call) => call.inherit || call.command === "bash")).toBe(false);
      const recovery = fixture({ fail });
      expect(
        await runCloudCli(["down", "--yes"], recovery.io, {
          root: ROOT,
          env: { ...recovery.env, TENKACLOUD_STACK_LAYOUT: undefined },
        }),
      ).toBe(0);
      expect(recovery.errors).toEqual([]);
      expect(recovery.assemblies.map((target) => target.name)).toEqual([names.app, names.backend]);
      expect(recovery.storageCalls).toEqual([]);
    },
  );
  it("does not adopt completed cloud-named stacks with missing Outputs", async () => {
    const f = fixture({
      fail: (request) => discoveredResponse(request, Object.values(cloud), { Outputs: undefined }),
    });
    expect(
      await runCloudCli(["up"], f.io, {
        root: ROOT,
        env: { ...f.env, TENKACLOUD_STACK_LAYOUT: undefined },
      }),
    ).toBe(1);
    expect(f.errors.join(" ")).toContain("Required outputs are absent");
    expect(f.calls.some((call) => call.inherit || call.command === "bash")).toBe(false);
  });
});

describe("original physical installation continuity", () => {
  const baseline = z
    .object({ templates: z.record(z.record(z.unknown())) })
    .parse(
      JSON.parse(
        readFileSync(
          new URL(
            "../../infrastructure/test/cloud-hosting/fixtures/historical-lite-signatures.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ),
    );
  const names = cloudStackNames("staging", "lite");
  function historicalResponse(
    request: ProcessRequest,
    provider: "dynamodb" | "turso",
  ): ProcessResult | undefined {
    const target = request.args[request.args.indexOf("--stack-name") + 1] ?? "";
    if (target === "CDKToolkit") return undefined;
    if (request.args.includes("get-template"))
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          TemplateBody:
            baseline.templates[provider]?.[target.includes("problem-deploy") ? "backend" : "app"],
        }),
      };
    if (!request.args.includes("describe-stacks") || !request.args.includes("Stacks[0]"))
      return undefined;
    if (!Object.values(names).includes(target))
      return {
        code: 1,
        stdout: "",
        stderr: `(ValidationError) Stack with id ${target} does not exist`,
      };
    return {
      code: 0,
      stderr: "",
      stdout: JSON.stringify({
        ...ownedStack(target),
        Outputs: [{ OutputKey: "ExistingOutput", OutputValue: "preserved" }],
        Tags: [
          { Key: "Project", Value: "TenkaCloud" },
          { Key: "Environment", Value: "staging" },
        ],
      }),
    };
  }
  it("updates the characterized original names and existing Cognito/data contract, without creating cloud-named replacements", async () => {
    const f = fixture({
      confirmed: true,
      fail: (request) => historicalResponse(request, "dynamodb"),
    });
    const result = await runCloudCli(["up"], f.io, {
      root: ROOT,
      env: { ...f.env, TENKACLOUD_STACK_LAYOUT: undefined },
    });
    expect(f.errors).toEqual([]);
    expect(result).toBe(0);
    const deploy = f.calls.find((call) => call.args.includes("deploy"));
    expect(deploy?.args).toContain(names.app);
    expect(deploy?.args).toContain(names.backend);
    expect(deploy?.args).not.toContain("tenkacloud-cloud-staging");
    expect(deploy?.env.TENKACLOUD_STACK_LAYOUT).toBe("lite");
  });
  it.each([{ args: ["up"] }, { args: ["up", "--yes"] }])(
    "holds an original installation before AWS changes without specific no-active-event confirmation: %j",
    async ({ args }) => {
      const f = fixture({ fail: (request) => historicalResponse(request, "dynamodb") });
      expect(
        await runCloudCli(args, f.io, {
          root: ROOT,
          env: { ...f.env, TENKACLOUD_STACK_LAYOUT: undefined },
        }),
      ).toBe(1);
      expect(f.confirmations).toHaveLength(1);
      expect(f.messages.join(" ")).toContain(
        "Updating during an active competition can stop scoring",
      );
      expect(f.errors.join(" ")).toContain("--confirm-no-active-events");
      expect(f.calls.some((call) => call.inherit || call.command === "bash")).toBe(false);
      expect(f.calls.some((call) => call.args.includes("CDKToolkit"))).toBe(false);
    },
  );
  it("accepts only the explicit completed-event acknowledgment for an original unattended upgrade", async () => {
    const f = fixture({ fail: (request) => historicalResponse(request, "dynamodb") });
    expect(
      await runCloudCli(["up", "--confirm-no-active-events"], f.io, {
        root: ROOT,
        env: { ...f.env, TENKACLOUD_STACK_LAYOUT: undefined, CI: "true" },
      }),
    ).toBe(0);
    expect(f.confirmations).toHaveLength(0);
    expect(f.messages.join(" ")).toContain("no active competitions remain");
    expect(f.calls.some((call) => call.args.includes("deploy"))).toBe(true);
  });
  it("rejects changing an original Turso database even without modern provider outputs", async () => {
    const f = fixture({ fail: (request) => historicalResponse(request, "turso") });
    expect(
      await runCloudCli(["up"], f.io, {
        root: ROOT,
        env: { ...f.env, TENKACLOUD_STACK_LAYOUT: undefined },
      }),
    ).toBe(1);
    expect(f.errors.join(" ")).toContain("explicit data migration");
    expect(f.calls.some((call) => call.inherit)).toBe(false);
  });
  it("recovers original Turso identity from its exact template for explicit app-only purge", async () => {
    const f = fixture({
      confirmed: true,
      fail: (request) => {
        const target = request.args[request.args.indexOf("--stack-name") + 1] ?? "";
        if (
          request.args.includes("describe-stacks") &&
          request.args.includes("Stacks[0]") &&
          target === names.backend
        )
          return {
            code: 1,
            stdout: "",
            stderr: `(ValidationError) Stack with id ${target} does not exist`,
          };
        return historicalResponse(request, "turso");
      },
    });
    const targets: unknown[] = [];
    f.io.purgeTursoControlData = async (target) => {
      targets.push(target);
    };
    expect(
      await runCloudCli(["down", "--purge-retained-data"], f.io, {
        root: ROOT,
        env: { ...f.env, TENKACLOUD_STACK_LAYOUT: undefined },
      }),
    ).toBe(0);
    expect(targets).toEqual([
      {
        databaseUrl: "https://synthetic.turso.io",
        parameterName: "/test/turso/token",
        schema: "lite-baseline-v1",
        region: "ap-northeast-1",
      },
    ]);
    expect(f.assemblies.map((a) => a.name)).toEqual([names.app]);
  });
  it.each(["up", "down"])(
    "makes no mutation on %s when both physical installations exist",
    async (command) => {
      const f = fixture({
        fail: (request) => {
          const target = request.args[request.args.indexOf("--stack-name") + 1] ?? "";
          if (
            request.args.includes("describe-stacks") &&
            request.args.includes("Stacks[0]") &&
            target.startsWith("tenkacloud-lite")
          )
            return { code: 0, stderr: "", stdout: JSON.stringify(ownedStack(target)) };
          return undefined;
        },
      });
      expect(
        await runCloudCli([command], f.io, {
          root: ROOT,
          env: { ...f.env, TENKACLOUD_STACK_LAYOUT: undefined },
        }),
      ).toBe(1);
      expect(f.errors.join(" ")).toContain("Both tenkacloud-lite and tenkacloud-cloud");
      expect(
        f.calls.every(
          (call) =>
            call.command === "aws" &&
            (call.args.includes("get-caller-identity") || call.args.includes("describe-stacks")),
        ),
      ).toBe(true);
    },
  );
});
