import { join } from "node:path";
import {
  projectBootstrap,
  requireExecutionPolicy,
} from "../../infrastructure/lib/cloud-hosting/bootstrap";
import { assertCommercialRegion } from "../../infrastructure/lib/cloud-hosting/regions";
import { cloudStackNames } from "../../infrastructure/lib/cloud-hosting/stack-names";
import { parseRunnerBindings } from "../../infrastructure/lib/problem-deploy/handlers/cloud-api/execution-config";
import { assertOwnedBootstrap } from "./bootstrap-check";
import type { CloudCliIo, ProcessResult } from "./process";
import { assertOwnedStack, assertRunnerChange, isMissingStack } from "./stack-check";

export interface CloudCliOptions {
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
}
interface Context extends CloudCliOptions {
  readonly io: CloudCliIo;
  readonly stacks: ReturnType<typeof cloudStackNames>;
}
function run(
  context: Context,
  command: string,
  args: readonly string[],
  inherit = false,
): Promise<ProcessResult> {
  return context.io.run({ command, args, cwd: context.root, env: context.env, inherit });
}
function cdk(context: Context, args: readonly string[]): Promise<ProcessResult> {
  const app = `${JSON.stringify(join(context.root, "node_modules/.bin/tsx"))} ${JSON.stringify(join(context.root, "infrastructure/bin/cloud-hosting.ts"))}`;
  return run(
    context,
    join(context.root, "node_modules/aws-cdk/bin/cdk"),
    ["--app", app, ...args],
    true,
  );
}
function assertSuccess(result: ProcessResult, phase: string): void {
  if (result.code !== 0)
    throw new Error(`${phase} failed (exit ${result.code}). ${result.stderr.trim()}`);
}
export function parseBundleEnvironment(output: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const names = new Set(["REGION", "ACCOUNT_ID", "CDK_PARAM_S3_BUCKET_NAME", "CDK_SOURCE_NAME"]);
  for (const line of output.split("\n")) {
    const index = line.indexOf("=");
    if (index < 0) continue;
    const key = line.slice(0, index);
    if (names.has(key)) env[key] = line.slice(index + 1).trim();
  }
  if (
    !/^\d{12}$/u.test(env.ACCOUNT_ID ?? "") ||
    !/^[a-z]{2}(?:-[a-z]+)+-\d+$/u.test(env.REGION ?? "") ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(env.CDK_PARAM_S3_BUCKET_NAME ?? "") ||
    !env.CDK_SOURCE_NAME
  ) {
    throw new Error(
      "Source-bundle identity could not be resolved; refusing to bootstrap or deploy.",
    );
  }
  assertCommercialRegion(env.REGION ?? "");
  return env;
}
async function resolveBundle(context: Context): Promise<Context> {
  const result = await context.io.run({
    command: "bash",
    args: [join(context.root, "scripts/cloud-hosting/prepare-source-bundle.sh")],
    cwd: context.root,
    env: { ...context.env, PREPARE_SOURCE_BUNDLE_RESOLVE_ONLY: "1" },
  });
  assertSuccess(result, "Source-bundle resolution");
  const resolved = parseBundleEnvironment(result.stdout);
  return {
    ...context,
    env: {
      ...context.env,
      ...resolved,
      AWS_REGION: resolved.REGION,
      AWS_DEFAULT_REGION: resolved.REGION,
      CDK_DEFAULT_REGION: resolved.REGION,
      CDK_DEFAULT_ACCOUNT: resolved.ACCOUNT_ID,
    },
  };
}
async function platformPreflight(context: Context, allowMissing: boolean): Promise<string[]> {
  const account = context.env.ACCOUNT_ID ?? "";
  const region = context.env.REGION ?? "";
  const caller = await run(context, "aws", [
    "sts",
    "get-caller-identity",
    "--query",
    "Account",
    "--output",
    "text",
    "--region",
    region,
  ]);
  assertSuccess(caller, "Verify deployment account");
  if (caller.stdout.trim() !== account)
    throw new Error("Current AWS credentials do not match the resolved deployment account.");
  const stackArns: string[] = [];
  for (const name of [context.stacks.app, context.stacks.backend]) {
    const result = await run(context, "aws", [
      "cloudformation",
      "describe-stacks",
      "--stack-name",
      name,
      "--region",
      region,
      "--query",
      "Stacks[0]",
      "--output",
      "json",
    ]);
    if (result.code !== 0 && isMissingStack(result.stderr, name)) {
      if (!allowMissing)
        throw new Error(`Stack ${name} is not deployed; no platform stacks were destroyed.`);
      continue;
    }
    assertSuccess(result, `Inspect platform stack ${name}`);
    stackArns.push(
      assertOwnedStack(result.stdout, {
        account,
        region,
        name,
        environment: context.env.CDK_PARAM_ENVIRONMENT ?? "development",
      }),
    );
    validateRunnerTransition(context, name, result.stdout, allowMissing);
  }
  return stackArns;
}
function validateRunnerTransition(
  context: Context,
  name: string,
  output: string,
  allowMissing: boolean,
): void {
  if (name !== context.stacks.app) return;
  assertRunnerChange(
    output,
    allowMissing ? "up" : "down",
    Boolean(context.env.TENKACLOUD_RUNNER_BINDINGS?.trim()),
  );
}
async function output(context: Context, stack: string, name: string): Promise<string> {
  const result = await run(context, "aws", [
    "cloudformation",
    "describe-stacks",
    "--stack-name",
    stack,
    "--query",
    `Stacks[0].Outputs[?OutputKey=='${name}'].OutputValue | [0]`,
    "--output",
    "text",
  ]);
  assertSuccess(result, `Read ${name}`);
  const value = result.stdout.trim();
  if (!value || value === "None" || value === "null")
    throw new Error(`Missing ${name} output on ${stack}.`);
  return value;
}
async function ensureOrganizer(context: Context, email: string): Promise<void> {
  const userPoolId = await output(context, context.stacks.app, "OrganizerUserPoolId");
  const args = ["--user-pool-id", userPoolId, "--username", email];
  const existing = await run(context, "aws", ["cognito-idp", "admin-get-user", ...args]);
  if (existing.code === 0) return;
  if (!existing.stderr.includes("UserNotFoundException")) {
    assertSuccess(existing, "Read organizer account");
  }
  const created = await run(context, "aws", [
    "cognito-idp",
    "admin-create-user",
    ...args,
    "--user-attributes",
    `Name=email,Value=${email}`,
    "Name=email_verified,Value=True",
    "Name=custom:userRole,Value=Admin",
    "--desired-delivery-mediums",
    "EMAIL",
  ]);
  assertSuccess(created, "Create organizer account");
}
async function bootstrapPreflight(context: Context, policyArn: string): Promise<string[]> {
  const environment = context.env.CDK_PARAM_ENVIRONMENT ?? "development";
  const toolkit = projectBootstrap(environment);
  const result = await run(context, "aws", [
    "cloudformation",
    "describe-stacks",
    "--stack-name",
    toolkit.stackName,
    "--query",
    "Stacks[0]",
    "--output",
    "json",
  ]);
  if (result.code === 0) assertOwnedBootstrap(result.stdout, environment, policyArn);
  else if (!isMissingStack(result.stderr, toolkit.stackName))
    assertSuccess(result, "Inspect project toolkit");
  return [
    "bootstrap",
    "--toolkit-stack-name",
    toolkit.stackName,
    "--qualifier",
    toolkit.qualifier,
    "--cloudformation-execution-policies",
    policyArn,
    "--tags",
    "TenkaCloudProject=cloud-hosting",
    "--tags",
    `Environment=${environment}`,
    "--termination-protection",
  ];
}
async function up(context: Context): Promise<number> {
  const email = context.env.TENKACLOUD_ADMIN_EMAIL?.trim() ?? "";
  const parts = email.split("@");
  if (
    email.length > 254 ||
    parts.length !== 2 ||
    !parts[0] ||
    !parts[1]?.includes(".") ||
    /[\s,]/u.test(email)
  )
    throw new Error("Set TENKACLOUD_ADMIN_EMAIL before cloud deployment.");
  if (context.env.TENKACLOUD_RUNNER_BINDINGS !== undefined)
    parseRunnerBindings(context.env.TENKACLOUD_RUNNER_BINDINGS);
  const executionPolicy = requireExecutionPolicy(context.env.TENKACLOUD_CFN_EXECUTION_POLICY_ARN);
  context.io.stdout(
    "[cloud] AWS resources and retained storage can incur charges. Only the explicitly configured, reviewed AWS flag slice can execute; the full competition lifecycle remains incomplete.\n",
  );
  context.io.stdout("[cloud] [1/4] Preparing the source bundle and both web applications\n");
  const resolved = await resolveBundle(context);
  if (resolved.env.ACCOUNT_ID !== executionPolicy.account)
    throw new Error("Execution policy must belong to the deployment account.");
  await platformPreflight(resolved, true);
  const bootstrapArgs = await bootstrapPreflight(resolved, executionPolicy.arn);
  assertSuccess(
    await run(
      resolved,
      "bash",
      [join(context.root, "scripts/cloud-hosting/prepare-source-bundle.sh")],
      true,
    ),
    "Source-bundle preparation",
  );
  context.io.stdout("[cloud] [2/4] Bootstrapping CDK (safe to repeat)\n");
  assertSuccess(await cdk(resolved, bootstrapArgs), "CDK bootstrap");
  context.io.stdout("[cloud] [3/4] Deploying cloud application and backend stacks\n");
  assertSuccess(
    await cdk(resolved, [
      "deploy",
      context.stacks.backend,
      context.stacks.app,
      "--require-approval",
      "never",
    ]),
    "CDK deploy",
  );
  context.io.stdout("[cloud] [4/4] Preparing organizer sign-in and access URLs\n");
  await ensureOrganizer(resolved, email);
  const consoleUrl = await output(resolved, context.stacks.app, "ApplicationAdminConsoleUrl");
  const portalUrl = await output(resolved, context.stacks.backend, "ParticipantPortalApiUrl");
  context.io.stdout(
    `Cloud control API and hosting deployed; the full competition lifecycle remains incomplete\nOrganizer console: ${consoleUrl}\nParticipant portal: ${portalUrl}\n`,
  );
  return 0;
}
async function down(context: Context, yes: boolean): Promise<void> {
  const resolved = await resolveBundle(context);
  const stackArns = await platformPreflight(resolved, false);
  const consequences = `Destroy platform hosting in account ${resolved.env.ACCOUNT_ID}, region ${resolved.env.REGION}, environment ${resolved.env.CDK_PARAM_ENVIRONMENT}?\n${stackArns.join("\n")}\nEvent data, organizer sign-in accounts, source-bundle and execution-artifact S3 storage, the project CDK toolkit, and separately deployed exercise resources are retained and may continue to incur charges.`;
  context.io.stdout(`${consequences}\n`);
  if (!yes && !(await context.io.confirm(`${consequences} [y/N] `))) {
    context.io.stdout("Cloud teardown cancelled\n");
    return;
  }
  // Destroy also synthesizes assets. Empty directories are sufficient; no builds/uploads happen.
  for (const app of ["application-admin-console", "participant-portal"])
    await context.io.ensureDir(join(context.root, "apps", app, "dist"));
  assertSuccess(
    await cdk(resolved, ["destroy", context.stacks.app, "--force"]),
    "Application stack destroy",
  );
  assertSuccess(
    await cdk(resolved, ["destroy", context.stacks.backend, "--force"]),
    "Backend stack destroy",
  );
  context.io.stdout(
    "Cloud stacks destroyed. Retained data and organizer accounts, source-bundle and execution-artifact S3 storage, the project CDK bootstrap stack, and separately deployed exercise resources are not purged by this command.\n",
  );
}
async function status(context: Context): Promise<number> {
  for (const stack of [context.stacks.app, context.stacks.backend]) {
    const result = await run(context, "aws", [
      "cloudformation",
      "describe-stacks",
      "--stack-name",
      stack,
      "--query",
      "Stacks[0].StackStatus",
      "--output",
      "text",
    ]);
    assertSuccess(result, `Read ${stack}`);
    context.io.stdout(`${stack}: ${result.stdout.trim()}\n`);
  }
  return 0;
}
const HELP =
  "TenkaCloud cloud hosting\nUsage: bun scripts/cloud-hosting/main.ts <up|down|status|console-url|portal-url>\nSet TENKACLOUD_ADMIN_EMAIL, TENKACLOUD_CFN_EXECUTION_POLICY_ARN, AWS_REGION, and AWS credentials for up. down accepts --yes.\n";
export async function runCloudCli(
  argv: readonly string[],
  io: CloudCliIo,
  options: CloudCliOptions,
): Promise<number> {
  try {
    const [command, ...args] = argv;
    if (command === undefined || ["--help", "-h", "help"].includes(command)) {
      io.stdout(HELP);
      return 0;
    }
    if (args.some((arg) => command !== "down" || !["--yes", "-y"].includes(arg)))
      throw new Error("Unknown cloud command argument.");
    const environment = options.env.CDK_PARAM_ENVIRONMENT ?? "development";
    const context: Context = {
      ...options,
      env: { ...options.env, CDK_PARAM_ENVIRONMENT: environment, ENV: environment },
      io,
      stacks: cloudStackNames(environment),
    };
    switch (command) {
      case "up":
        return await up(context);
      case "down":
        await down(context, args.length > 0);
        return 0;
      case "status":
        return await status(context);
      case "console-url":
        io.stdout(`${await output(context, context.stacks.app, "ApplicationAdminConsoleUrl")}\n`);
        return 0;
      case "portal-url":
        io.stdout(`${await output(context, context.stacks.backend, "ParticipantPortalApiUrl")}\n`);
        return 0;
      default:
        throw new Error(`Unknown cloud command: ${command}`);
    }
  } catch (error) {
    io.stderr(`[cloud] ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
