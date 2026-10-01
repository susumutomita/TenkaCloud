import { describe, expect, it } from "bun:test";
import { projectBootstrap } from "../../infrastructure/lib/cloud-hosting/bootstrap";
import {
  cloudStackNames,
  cloudStackTags,
} from "../../infrastructure/lib/cloud-hosting/stack-names";
import { assertOwnedBootstrap } from "./bootstrap-check";
import { parseBundleEnvironment, runCloudCli } from "./cli";
import type { CloudCliIo, ProcessRequest, ProcessResult } from "./process";
import "./main";

const POLICY = "arn:aws:iam::123456789012:policy/tenkacloud/cloud-hosting/execution";
const ROOT = "/fixture/TenkaCloud";
const BUNDLE =
  "REGION=ap-northeast-1\nACCOUNT_ID=123456789012\nCDK_PARAM_S3_BUCKET_NAME=tenkacloud-source-123456789012-ap-northeast-1-1234abcd\nCDK_SOURCE_NAME=source.zip\n";
function ownedStack(name: string) {
  return {
    StackId: `arn:aws:cloudformation:ap-northeast-1:123456789012:stack/${name}/synthetic-stack-id`,
    StackName: name,
    Outputs: [{ OutputKey: "CloudRunnerEnabled", OutputValue: "false" }],
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
  if (request.command === "aws" && request.args.some((arg) => arg.startsWith("TenkaCloudToolkit-")))
    return {
      code: 1,
      stdout: "",
      stderr: `An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id ${request.args[request.args.indexOf("--stack-name") + 1]} does not exist`,
    };
  if (request.env.PREPARE_SOURCE_BUNDLE_RESOLVE_ONLY === "1")
    return { code: 0, stdout: BUNDLE, stderr: "" };
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
  if (phase === "resolve") return request.env.PREPARE_SOURCE_BUNDLE_RESOLVE_ONLY === "1";
  if (phase === "prepare")
    return (
      request.command === "bash" && request.env.PREPARE_SOURCE_BUNDLE_RESOLVE_ONLY === undefined
    );
  return request.args.includes(phase);
}
function fixture(
  options: {
    confirmed?: boolean;
    fail?: (request: ProcessRequest) => ProcessResult | undefined;
  } = {},
) {
  const calls: ProcessRequest[] = [];
  const messages: string[] = [];
  const errors: string[] = [];
  const confirmations: string[] = [];
  const directories: string[] = [];
  const io: CloudCliIo = {
    run: async (request) => {
      calls.push(structuredClone(request));
      const failure = options.fail?.(request);
      if (failure) return failure;
      return mockResponse(request);
    },
    stdout: (value) => messages.push(value),
    stderr: (value) => errors.push(value),
    confirm: async (question) => {
      confirmations.push(question);
      return options.confirmed ?? false;
    },
    ensureDir: async (path) => {
      directories.push(path);
    },
  };
  const env = {
    TENKACLOUD_ADMIN_EMAIL: "organizer@example.test",
    TENKACLOUD_CFN_EXECUTION_POLICY_ARN: POLICY,
    CDK_PARAM_ENVIRONMENT: "staging",
  };
  return {
    io,
    calls,
    messages,
    errors,
    confirmations,
    directories,
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
  it("preserves prepare -> bootstrap -> deploy -> organizer setup ordering", async () => {
    const f = fixture();
    expect(await f.run(["up"])).toBe(0);
    expect(f.calls[0]?.env.PREPARE_SOURCE_BUNDLE_RESOLVE_ONLY).toBe("1");
    expect(f.calls[1]?.args).toContain("get-caller-identity");
    expect(f.calls.slice(2, 4).every(platformInspection)).toBe(true);
    expect(f.calls[4]?.command).toBe("aws");
    expect(f.calls[5]?.command).toBe("bash");
    expect(f.calls[5]?.env.PREPARE_SOURCE_BUNDLE_RESOLVE_ONLY).toBeUndefined();
    expect(f.calls[6]?.args).toEqual([
      "--app",
      `"${ROOT}/node_modules/.bin/tsx" "${ROOT}/infrastructure/bin/cloud-hosting.ts"`,
      "bootstrap",
      "--toolkit-stack-name",
      "TenkaCloudToolkit-staging",
      "--qualifier",
      projectBootstrap("staging").qualifier,
      "--cloudformation-execution-policies",
      POLICY,
      "--tags",
      "TenkaCloudProject=cloud-hosting",
      "--tags",
      "Environment=staging",
      "--termination-protection",
    ]);
    expect(f.calls[7]?.args.slice(2)).toEqual([
      "deploy",
      "tenkacloud-cloud-problem-deploy-staging",
      "tenkacloud-cloud-staging",
      "--require-approval",
      "never",
    ]);
    expect(
      f.calls.slice(1).every((call) => call.env.CDK_PARAM_S3_BUCKET_NAME?.endsWith("1234abcd")),
    ).toBe(true);
    expect(f.calls.slice(1).every((call) => call.env.AWS_DEFAULT_REGION === "ap-northeast-1")).toBe(
      true,
    );
    const create = f.calls.find((call) => call.args.includes("admin-create-user"));
    expect(create?.args).toContain("Name=custom:userRole,Value=Admin");
    expect(create?.args.join(" ")).not.toContain("tenant");
    expect(f.messages.join("")).toContain("https://console.example.test");
    expect(f.messages.join("")).toContain("https://portal.example.test");
    expect(f.env).toEqual({
      TENKACLOUD_ADMIN_EMAIL: "organizer@example.test",
      TENKACLOUD_CFN_EXECUTION_POLICY_ARN: POLICY,
      CDK_PARAM_ENVIRONMENT: "staging",
    });
  });
  it("requires the organizer identity before any remote setup", async () => {
    const f = fixture();
    expect(await runCloudCli(["up"], f.io, { root: ROOT, env: {} })).toBe(1);
    expect(f.calls).toEqual([]);
    expect(f.errors.join("")).toContain("TENKACLOUD_ADMIN_EMAIL");
  });
  it.each(["resolve", "prepare", "bootstrap", "deploy"])("halts after %s fails", async (phase) => {
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
    expect(f.directories).toEqual([]);
    expect(f.confirmations[0]).toContain("123456789012");
    expect(f.confirmations[0]).toContain("ap-northeast-1");
    expect(f.confirmations[0]).toContain(ownedStack("tenkacloud-cloud-staging").StackId);
    expect(f.confirmations[0]).toContain(
      ownedStack("tenkacloud-cloud-problem-deploy-staging").StackId,
    );
    expect(f.confirmations[0]).toContain("separately deployed exercise resources");
  });
  it.each([{ args: [] }, { args: ["--yes"] }])(
    "destroys application before backend and does not rebuild or upload: %s",
    async ({ args }) => {
      const f = fixture({ confirmed: true });
      expect(await f.run(["down", ...args])).toBe(0);
      expect(f.calls).toHaveLength(6);
      expect(f.calls[0]?.env.PREPARE_SOURCE_BUNDLE_RESOLVE_ONLY).toBe("1");
      expect(f.calls[4]?.args.slice(2)).toEqual(["destroy", "tenkacloud-cloud-staging", "--force"]);
      expect(f.calls[5]?.args.slice(2)).toEqual([
        "destroy",
        "tenkacloud-cloud-problem-deploy-staging",
        "--force",
      ]);
      expect(f.directories).toEqual([
        `${ROOT}/apps/application-admin-console/dist`,
        `${ROOT}/apps/participant-portal/dist`,
      ]);
      expect(f.messages.join("")).toContain("not purged");
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
    expect(f.calls).toHaveLength(5);
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
      expect(f.calls).toHaveLength(2);
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
          expect(f.directories).toEqual([]);
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
      expect(await f.run([command])).toBe(command === "up" ? 0 : 1);
      if (command === "down") {
        expect(f.errors.join("")).toContain("not deployed; no platform stacks were destroyed");
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
  it("refuses to remove an enabled runner on update or destroy, even with --yes", async () => {
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
    expect(f.errors.join("")).toContain("without TENKACLOUD_RUNNER_BINDINGS");
    expect(await f.run(["down", "--yes"])).toBe(1);
    expect(f.errors.join("")).toContain("drain pending and active executions");
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
      expect(
        f.calls.every((call) => call.command === "aws" && call.args.includes("describe-stacks")),
      ).toBe(true);
      expect(f.calls.every((call) => call.args.some((arg) => arg.endsWith("-staging")))).toBe(true);
    },
  );
  it.each([
    { args: ["unknown"] },
    { args: ["up", "--force"] },
    { args: ["down", "--purge-retained-data"] },
    { args: ["status", "--yes"] },
  ])("rejects unsupported commands without effects: %s", async ({ args }) => {
    const f = fixture();
    expect(await f.run(args)).toBe(1);
    expect(f.calls).toEqual([]);
  });
  it("requires a reviewed execution policy before setup and never defaults to AdministratorAccess", async () => {
    const f = fixture();
    expect(
      await runCloudCli(["up"], f.io, {
        root: ROOT,
        env: { TENKACLOUD_ADMIN_EMAIL: "organizer@example.test" },
      }),
    ).toBe(1);
    expect(f.calls).toEqual([]);
    expect(f.errors.join("")).toContain("TENKACLOUD_CFN_EXECUTION_POLICY_ARN");
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
          TENKACLOUD_CFN_EXECUTION_POLICY_ARN: POLICY.replace("123456789012", "210987654321"),
        },
      }),
    ).toBe(1);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.env.PREPARE_SOURCE_BUNDLE_RESOLVE_ONLY).toBe("1");
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
          ],
        }),
        "staging",
        POLICY,
      ),
    ).not.toThrow();
  });
  it("rejects unsafe environments and source-bucket identity", () => {
    expect(cloudStackNames("development")).toEqual({
      app: "tenkacloud-cloud",
      backend: "tenkacloud-cloud-problem-deploy",
    });
    expect(() => cloudStackNames("development;bad")).toThrow();
    expect(() => parseBundleEnvironment("")).toThrow();
    expect(() =>
      parseBundleEnvironment(BUNDLE.replace("ACCOUNT_ID=123456789012", "ACCOUNT_ID=invalid")),
    ).toThrow();
    expect(
      parseBundleEnvironment(`${BUNDLE}AWS_SECRET_ACCESS_KEY=not-copied\n`).AWS_SECRET_ACCESS_KEY,
    ).toBeUndefined();
  });
});
