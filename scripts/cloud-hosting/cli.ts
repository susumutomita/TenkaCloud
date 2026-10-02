import { join } from "node:path";
import { z } from "zod";
import {
  projectBootstrap,
  requireExecutionPolicy,
} from "../../infrastructure/lib/cloud-hosting/bootstrap";
import { assertCommercialRegion } from "../../infrastructure/lib/cloud-hosting/regions";
import { cloudStackNames } from "../../infrastructure/lib/cloud-hosting/stack-names";
import { contentDigest } from "../../infrastructure/lib/problem-deploy/control-data/domain/deployment-work";
import type { CloudTableNames } from "../../infrastructure/lib/problem-deploy/control-data/dynamodb-cloud-repository";
import type { InstallationScope } from "../../infrastructure/lib/problem-deploy/control-data/installation-control";
import { parseRunnerBindings } from "../../infrastructure/lib/problem-deploy/handlers/cloud-api/execution-config";
import { assertOwnedBootstrap } from "./bootstrap-check";
import { cloudEnvironmentInstructions, loadCloudEnvironment } from "./environment";
import {
  type CloudInstallation,
  drainInstallation,
  type InstallationLocation,
} from "./installation";
import type { CloudCliIo, ProcessResult } from "./process";
import { setupArtifacts, setupCloudToolkit } from "./setup";
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
/** Resolve only deployment identity; CDK already owns application/catalog asset publishing. */
async function resolveCloudContext(context: Context): Promise<Context> {
  let region = context.env.REGION ?? context.env.AWS_REGION ?? context.env.AWS_DEFAULT_REGION;
  if (!region?.trim()) {
    const configured = await run(context, "aws", ["configure", "get", "region"]);
    assertSuccess(
      configured,
      "Read configured AWS region; set AWS_REGION if no profile region exists",
    );
    region = configured.stdout;
  }
  region = region.trim();
  assertCommercialRegion(region);
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
  assertSuccess(caller, "Resolve deployment account");
  const account = caller.stdout.trim();
  if (!/^\d{12}$/u.test(account)) throw new Error("AWS returned an invalid deployment account.");
  const expected = context.env.ACCOUNT_ID?.trim() || context.env.CDK_DEFAULT_ACCOUNT?.trim();
  if (expected && expected !== account)
    throw new Error("Current AWS credentials do not match the configured deployment account.");
  return {
    ...context,
    env: {
      ...context.env,
      REGION: region,
      ACCOUNT_ID: account,
      AWS_REGION: region,
      AWS_DEFAULT_REGION: region,
      CDK_DEFAULT_REGION: region,
      CDK_DEFAULT_ACCOUNT: account,
    },
  };
}
async function buildApplications(context: Context): Promise<void> {
  for (const application of ["application-admin-console", "participant-portal"])
    assertSuccess(
      await run(
        context,
        "bun",
        ["run", "--cwd", join(context.root, "apps", application), "build"],
        true,
      ),
      `Build ${application}`,
    );
}
interface OwnedPlatformStack {
  readonly name: string;
  readonly arn: string;
  readonly outputs: Readonly<Record<string, string>>;
  readonly status: string;
}
const outputsSchema = z.array(z.object({ OutputKey: z.string(), OutputValue: z.string() }));
function stackOutputs(text: string): Readonly<Record<string, string>> {
  const raw = z.object({ Outputs: outputsSchema }).parse(JSON.parse(text) as unknown);
  if (new Set(raw.Outputs.map((entry) => entry.OutputKey)).size !== raw.Outputs.length)
    throw new Error("Ambiguous stack outputs");
  return Object.fromEntries(raw.Outputs.map((entry) => [entry.OutputKey, entry.OutputValue]));
}
async function platformPreflight(
  context: Context,
  mode: "up" | "down",
): Promise<OwnedPlatformStack[]> {
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
  const stacks: OwnedPlatformStack[] = [];
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
      continue;
    }
    assertSuccess(result, `Inspect platform stack ${name}`);
    stacks.push({
      name,
      arn: assertOwnedStack(result.stdout, {
        account,
        region,
        name,
        environment: context.env.CDK_PARAM_ENVIRONMENT ?? "development",
      }),
      outputs: stackOutputs(result.stdout),
      status: z.object({ StackStatus: z.string() }).parse(JSON.parse(result.stdout) as unknown)
        .StackStatus,
    });
    if (mode === "up") validateRunnerTransition(context, name, result.stdout);
  }
  return stacks;
}
function validateRunnerTransition(context: Context, name: string, output: string): void {
  if (name !== context.stacks.app) return;
  assertRunnerChange(
    output,
    contentDigest(
      JSON.stringify(
        context.env.TENKACLOUD_RUNNER_BINDINGS === undefined
          ? []
          : parseRunnerBindings(context.env.TENKACLOUD_RUNNER_BINDINGS),
      ),
    ),
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
async function bootstrapPreflight(
  context: Context,
  policyArn: string,
  setupApproved: boolean,
): Promise<void> {
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
  if (result.code !== 0 && isMissingStack(result.stderr, toolkit.stackName)) {
    if (setupArtifacts(context.env).policies.identities.executionPolicyArns.join(",") !== policyArn)
      throw new Error(
        "Initial setup requires the source-reviewed execution-policy list. Leave TENKACLOUD_CFN_EXECUTION_POLICY_ARN unset for a fresh installation; no toolkit was created.",
      );
    context.io.stdout(
      `[cloud] Project toolkit ${toolkit.stackName} is missing; review initial setup below.\n`,
    );
    await setupCloudToolkit(
      { cwd: context.root, env: context.env },
      context.io,
      setupApproved,
      "deploy",
    );
    return;
  }
  assertSuccess(result, "Inspect project toolkit");
  assertOwnedBootstrap(result.stdout, environment, policyArn);
}
async function up(context: Context, setupApproved: boolean): Promise<number> {
  const email = context.env.TENKACLOUD_ADMIN_EMAIL?.trim() ?? "";
  const parts = email.split("@");
  if (
    email.length > 254 ||
    parts.length !== 2 ||
    !parts[0] ||
    !parts[1]?.includes(".") ||
    /[\s,]/u.test(email)
  )
    throw new Error(
      `Set TENKACLOUD_ADMIN_EMAIL before cloud deployment. ${cloudEnvironmentInstructions(context.env.ENV ?? "development")}`,
    );
  if (context.env.TENKACLOUD_RUNNER_BINDINGS !== undefined)
    parseRunnerBindings(context.env.TENKACLOUD_RUNNER_BINDINGS);
  const explicitPolicy = context.env.TENKACLOUD_CFN_EXECUTION_POLICY_ARN
    ? requireExecutionPolicy(context.env.TENKACLOUD_CFN_EXECUTION_POLICY_ARN)
    : undefined;
  context.io.stdout(
    "[cloud] Supported cloud exercises: hello-world with scoped participant AWS CLI access, and native Cryptography Battle backed by DynamoDB. AWS usage and retained storage can incur charges; see infrastructure/README.md for feature and capacity limits.\n",
  );

  const resolved = await resolveCloudContext(context);
  const executionPolicy =
    explicitPolicy ??
    requireExecutionPolicy(
      setupArtifacts(resolved.env).policies.identities.executionPolicyArns.join(","),
    );
  if (resolved.env.ACCOUNT_ID !== executionPolicy.account)
    throw new Error("Execution policy must belong to the deployment account.");
  // The operator policy name is independent of optional legacy runner bindings.
  const operatorPolicy = setupArtifacts({ ...resolved.env, TENKACLOUD_RUNNER_BINDINGS: undefined })
    .policies.identities.operatorPolicyArn;
  const operatorInstructions = `Ordinary deployment requires ${operatorPolicy} or equivalent reviewed permissions. If this profile has initial-setup permissions only, ask your IAM administrator to authorize the intended deployment operator, switch to that profile and rerun make deploy ENV=${resolved.env.CDK_PARAM_ENVIRONMENT}. No policy is automatically attached to your current user or role.`;
  let deployed: OwnedPlatformStack[];
  try {
    deployed = await platformPreflight(resolved, "up");
  } catch (error) {
    if (
      error instanceof Error &&
      /access.?denied|not authorized|unauthorized/iu.test(error.message)
    )
      throw new Error(`${error.message}\n${operatorInstructions}`);
    throw error;
  }
  const backend = deployed.find((stack) => stack.name === context.stacks.backend);
  if (backend) {
    const installation = resolved.io.openInstallation({
      region: resolved.env.REGION ?? "",
      tables: installationTables(backend),
    });
    try {
      await installation.repository.assertAcceptingInstallation();
    } finally {
      installation.close();
    }
  }
  await bootstrapPreflight(resolved, executionPolicy.arn, setupApproved);
  context.io.stdout("[cloud] [1/3] Building both web applications for CDK asset publishing\n");
  await buildApplications(resolved);
  context.io.stdout("[cloud] [2/3] Deploying cloud application and backend stacks\n");
  assertSuccess(
    await cdk(resolved, [
      "deploy",
      context.stacks.backend,
      context.stacks.app,
      "--require-approval",
      "never",
    ]),
    `CDK deploy. ${operatorInstructions}`,
  );
  context.io.stdout("[cloud] [3/3] Preparing organizer sign-in and access URLs\n");
  await ensureOrganizer(resolved, email);
  const consoleUrl = await output(resolved, context.stacks.app, "ApplicationAdminConsoleUrl");
  const portalUrl = await output(resolved, context.stacks.backend, "ParticipantPortalApiUrl");
  context.io.stdout(
    `Cloud hosting deployed for hello-world (scoped participant AWS CLI) and native Cryptography Battle.\nOrganizer console: ${consoleUrl}\nParticipant portal: ${portalUrl}\n`,
  );
  return 0;
}
function installationTables(backend: OwnedPlatformStack): CloudTableNames {
  const result = {
    events: backend.outputs.EventsTableName ?? "",
    teams: backend.outputs.TeamsTableName ?? "",
    deployments: backend.outputs.DeploymentsTableName ?? "",
  };
  for (const [kind, value] of Object.entries(result)) {
    const resource = kind[0]?.toUpperCase() + kind.slice(1);
    // CDK-generated physical names are stack-scoped. Never adopt an arbitrary table output.
    if (!value.startsWith(`${backend.name}-${resource}`) || !/^[A-Za-z0-9_.-]{3,255}$/u.test(value))
      throw new Error(
        `Missing or unowned ${resource} table output; no platform stacks were destroyed.`,
      );
  }
  if (new Set(Object.values(result)).size !== 3)
    throw new Error("Cloud table outputs must be distinct.");
  return result;
}
function nativeInstallationArtifacts(
  context: Context,
  stacks: readonly OwnedPlatformStack[],
): InstallationLocation["native"] {
  const app = stacks.find((stack) => stack.name === context.stacks.app);
  if (app?.outputs.CloudInstallationControlVersion !== "2") return undefined;
  const artifactBucket = app.outputs.CloudExecutionArtifactBucket;
  const catalogKey = app.outputs.CloudExecutionCatalogKey;
  if (
    !artifactBucket ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(artifactBucket) ||
    artifactBucket.includes("..") ||
    !catalogKey ||
    !/^catalogs\/[a-f0-9]{64}\.json$/u.test(catalogKey)
  )
    throw new Error(
      "Native coordination artifact outputs are missing or invalid; no resources were removed.",
    );
  return { artifactBucket, catalogKey, expectedBucketOwner: context.env.ACCOUNT_ID ?? "" };
}

async function teardownScope(
  context: Context,
  stacks: readonly OwnedPlatformStack[],
  installation: CloudInstallation,
): Promise<InstallationScope> {
  const backend = stacks.find((stack) => stack.name === context.stacks.backend);
  const app = stacks.find((stack) => stack.name === context.stacks.app);
  if (!backend)
    throw new Error(
      "Backend is missing; unable to prove event cleanup. No hosting resources were removed.",
    );
  if (
    app &&
    (!["1", "2"].includes(app.outputs.CloudInstallationControlVersion ?? "") ||
      !["true", "false"].includes(app.outputs.CloudRunnerEnabled ?? ""))
  )
    throw new Error(
      "Deployed application does not advertise the durable intake-fence version. Update the matching installation before coordinated destroy; no resources were removed.",
    );
  if (app)
    return {
      account: context.env.ACCOUNT_ID ?? "",
      region: context.env.REGION ?? "",
      environment: context.env.CDK_PARAM_ENVIRONMENT ?? "development",
      applicationStackId: app.arn,
      backendStackId: backend.arn,
    };
  const control = await installation.repository.installationControl();
  if (
    control?.status !== "DRAINED" ||
    control.scope.backendStackId !== backend.arn ||
    control.scope.account !== context.env.ACCOUNT_ID ||
    control.scope.region !== context.env.REGION ||
    control.scope.environment !== context.env.CDK_PARAM_ENVIRONMENT
  )
    throw new Error(
      "Application stack is absent without a matching completed drain; refusing to infer cleanup.",
    );
  return control.scope;
}
async function down(context: Context, yes: boolean): Promise<void> {
  const resolved = await resolveCloudContext(context);
  const stacks = await platformPreflight(resolved, "down");
  if (stacks.length === 0) {
    context.io.stdout(
      "[cloud] Both platform stacks are already absent. Retained data, assets and competitor bootstrap resources were not changed.\n",
    );
    return;
  }
  const backend = stacks.find((stack) => stack.name === context.stacks.backend);
  if (!backend)
    throw new Error(
      "Backend is missing; event cleanup cannot be verified. No resources were removed.",
    );
  if (
    stacks.some(
      (stack) => stack.status.endsWith("_IN_PROGRESS") && stack.status !== "DELETE_IN_PROGRESS",
    )
  )
    throw new Error(
      "A platform stack update is still running; wait for it to finish before destroy.",
    );
  const installation = resolved.io.openInstallation({
    region: resolved.env.REGION ?? "",
    tables: installationTables(backend),
    native: nativeInstallationArtifacts(resolved, stacks),
  });
  try {
    const scope = await teardownScope(resolved, stacks, installation);
    const consequences = `Stop new competition work, remove recorded event exercise resources, then destroy platform hosting in account ${scope.account}, region ${scope.region}, environment ${scope.environment}?\n${stacks.map((stack) => stack.arn).join("\n")}\nEvent data, scores and receipts, organizer sign-in accounts, shared ExternalId, competitor-owned bootstrap stacks/IAM roles, CDK asset and execution-artifact S3 storage, and the project CDK toolkit are retained and may continue to incur charges. Unrelated or separately deployed exercise resources are untouched.`;
    context.io.stdout(`${consequences}\n`);
    if (!yes && !(await context.io.confirm(`${consequences} [y/N] `))) {
      context.io.stdout("Cloud teardown cancelled\n");
      return;
    }
    await drainInstallation(installation, scope, context.io);
    // Delete the verified physical ARN, never a reusable stack name. CloudFormation still
    // runs custom-resource cleanup and honors each template's retention policies.
    for (const name of [context.stacks.app, context.stacks.backend]) {
      const stack = stacks.find((candidate) => candidate.name === name);
      if (!stack) continue;
      const args = ["--stack-name", stack.arn, "--region", scope.region];
      if (stack.status !== "DELETE_IN_PROGRESS")
        assertSuccess(
          await run(resolved, "aws", [
            "cloudformation",
            "delete-stack",
            ...args,
            "--role-arn",
            setupArtifacts(resolved.env).policies.identities.executionRoleArn,
          ]),
          `Delete ${name}`,
        );
      assertSuccess(
        await run(resolved, "aws", ["cloudformation", "wait", "stack-delete-complete", ...args]),
        `Wait for ${name} deletion`,
      );
    }
    context.io.stdout(
      "Cloud hosting and recorded event exercise resources destroyed. Retained data, accounts, shared ExternalId, bootstrap resources and asset storage are not purged.\n",
    );
  } finally {
    installation.close();
  }
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
  'TenkaCloud cloud hosting\nUsage: make deploy ENV=development | make destroy ENV=development [CLOUD_ARGS="--yes"]\nHelp: make deploy CLOUD_ARGS="--help" | make destroy CLOUD_ARGS="--help"\nSource CLI: bun run --no-env-file scripts/cloud-hosting/main.ts <up|down|status|console-url|portal-url>\nSelect ENV or matching CDK_PARAM_ENVIRONMENT (default development). Samples exist for development, staging and production; custom lowercase environment names remain supported. Copy infrastructure/environments/<environment>/.env.example to .env in the same directory only if absent, then configure TENKACLOUD_ADMIN_EMAIL, ACCOUNT_ID and AWS_REGION. Exported variables override file values; AWS credentials come from your intended profile/role. make deploy checks the project toolkit; if missing, it displays initial IAM setup for separate confirmation, installs it and continues deployment with the same credentials. Existing toolkits are validated and never updated by ordinary deploy. Optional --show-setup prints the complete setup template offline; --setup installs or updates the toolkit only. Unattended first deployment requires CLOUD_ARGS="--setup-if-needed --yes" after reviewing --show-setup. --yes alone never approves initial IAM setup. down accepts --yes.\n';
function assertCommandArguments(command: string, args: readonly string[]): void {
  let permitted: readonly string[] = [];
  if (command === "up") permitted = ["--setup", "--show-setup", "--setup-if-needed", "--yes", "-y"];
  if (command === "down") permitted = ["--yes", "-y"];
  if (
    args.some((arg) => !permitted.includes(arg)) ||
    (command === "up" &&
      ((args.includes("--show-setup") && args.length !== 1) ||
        (args.includes("--setup") && args.includes("--setup-if-needed"))))
  )
    throw new Error("Unknown or conflicting cloud command argument.");
}
export async function runCloudCli(
  argv: readonly string[],
  io: CloudCliIo,
  options: CloudCliOptions,
): Promise<number> {
  try {
    const [command, ...args] = argv;
    if (
      command === undefined ||
      ["--help", "-h", "help"].includes(command) ||
      (["up", "down"].includes(command) &&
        args.length === 1 &&
        ["--help", "-h"].includes(args[0] ?? ""))
    ) {
      io.stdout(HELP);
      return 0;
    }
    assertCommandArguments(command, args);
    const env = loadCloudEnvironment(options.root, options.env);
    const context: Context = {
      ...options,
      env,
      io,
      stacks: cloudStackNames(env.ENV),
    };
    switch (command) {
      case "up":
        if (args.includes("--show-setup")) {
          io.stdout(`${JSON.stringify(setupArtifacts(context.env).template, null, 2)}\n`);
          return 0;
        }
        if (args.includes("--setup")) {
          const resolved = await resolveCloudContext(context);
          await setupCloudToolkit(
            { cwd: resolved.root, env: resolved.env },
            io,
            args.some((arg) => ["--yes", "-y"].includes(arg)),
          );
          return 0;
        }
        return await up(
          context,
          args.includes("--setup-if-needed") && args.some((arg) => ["--yes", "-y"].includes(arg)),
        );
      case "down":
        await down(context, args.length > 0);
        return 0;
      case "status":
        return await status(await resolveCloudContext(context));
      case "console-url":
        io.stdout(
          `${await output(await resolveCloudContext(context), context.stacks.app, "ApplicationAdminConsoleUrl")}\n`,
        );
        return 0;
      case "portal-url":
        io.stdout(
          `${await output(await resolveCloudContext(context), context.stacks.backend, "ParticipantPortalApiUrl")}\n`,
        );
        return 0;
      default:
        throw new Error(`Unknown cloud command: ${command}`);
    }
  } catch (error) {
    io.stderr(`[cloud] ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
