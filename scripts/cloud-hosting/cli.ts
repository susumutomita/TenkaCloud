import { join } from "node:path";
import { z } from "zod";
import {
  type CloudControlDataConfiguration,
  cloudControlDataConfiguration,
} from "../../infrastructure/lib/cloud-hosting/config";
import { assertCommercialRegion } from "../../infrastructure/lib/cloud-hosting/regions";
import { cloudStackNames } from "../../infrastructure/lib/cloud-hosting/stack-names";
import { STANDARD_TOOLKIT_STACK } from "./bootstrap-check";
import {
  assertPurgeAllowed,
  discoverTeardownPlan,
  emptyStackOwnedBuckets,
  purgeStackOwnedLogGroups,
  purgeStackOwnedResources,
  showTeardownPlan,
  type TeardownPlan,
} from "./complete-teardown";
import { cloudEnvironmentInstructions, loadCloudEnvironment } from "./environment";
import { canRecoverCreation, type PlatformStack } from "./failed-creation";
import { selectCloudInstallation } from "./installation-selection";
import type { CloudCliIo, ProcessResult } from "./process";
import { setupCloudToolkit, showCloudToolkit } from "./setup";
import { prepareCloudSourceBundle } from "./source-bundle";
import { assertOwnedStack, isMissingStack } from "./stack-check";
import { assertCompatibleStack } from "./stack-compatibility";
import { verifyTursoBeforeDeployment } from "./turso-preflight";
import type { TursoResetTarget } from "./turso-reset";
import { planDeployedTursoTeardown, type TursoTeardownPlan } from "./turso-teardown";

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
function cdk(
  context: Context,
  args: readonly string[],
  app = "node --import tsx ./infrastructure/bin/cloud-hosting.ts",
): Promise<ProcessResult> {
  // CDK strips enclosing quotes from --app. Resolve the loader and app from our root cwd.
  return run(
    context,
    join(context.root, "node_modules/aws-cdk/bin/cdk"),
    [
      "--app",
      app,
      "--toolkit-stack-name",
      STANDARD_TOOLKIT_STACK,
      "--profile",
      "",
      "--region",
      context.env.REGION ?? "",
      ...args,
    ],
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
type OwnedPlatformStack = PlatformStack;
const outputsSchema = z.array(z.object({ OutputKey: z.string(), OutputValue: z.string() }));
function stackOutputs(text: string, allowMissing: boolean): Readonly<Record<string, string>> {
  const parsed: unknown = JSON.parse(text);
  const raw = z.object({ Outputs: outputsSchema.optional() }).parse(parsed);
  if (!raw.Outputs && !allowMissing)
    throw new Error(
      "Required outputs are absent from a completed platform stack; no resources were removed. Review its deployment state.",
    );
  // Platform removal is owned by CloudFormation and does not require application outputs.
  if (!raw.Outputs) return {};
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
    const arn = assertOwnedStack(result.stdout, {
      account,
      region,
      name,
      environment: context.env.CDK_PARAM_ENVIRONMENT ?? "development",
    });
    const status = validatePlatformStatus(
      result.stdout,
      mode,
      name,
      context.env.CDK_PARAM_ENVIRONMENT ?? "development",
    );
    stacks.push({
      name,
      arn,
      status,
      outputs: stackOutputs(result.stdout, mode === "down"),
    });
  }
  return stacks;
}
function validatePlatformStatus(
  text: string,
  mode: "up" | "down",
  name: string,
  environment: string,
): string {
  const { StackStatus: status } = z
    .object({ StackStatus: z.string() })
    .parse(JSON.parse(text) as unknown);
  if (status.endsWith("_IN_PROGRESS") && status !== "DELETE_IN_PROGRESS")
    throw new Error(
      `Stack ${name} is ${status}; wait for CloudFormation to finish before retrying.`,
    );
  if (mode === "up" && canRecoverCreation(status))
    throw new Error(
      `Stack ${name} is ${status}. Review the stack state, then run make destroy ENV=${environment} before deploying again. Review the deployed retention/protection with CLOUD_ARGS="--plan" if cleanup fails.`,
    );
  return status;
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
    "Name=custom:userRole,Value=TenantAdmin",
    "--desired-delivery-mediums",
    "EMAIL",
  ]);
  assertSuccess(created, "Create organizer account");
}
async function validateDeploymentData(
  context: Context,
  desiredData: CloudControlDataConfiguration,
  deployed: readonly OwnedPlatformStack[],
): Promise<void> {
  for (const stack of deployed) assertDataTransition(desiredData, stack.outputs);
  if (desiredData.kind === "turso") {
    if (!context.io.probeTurso)
      throw new Error("Turso preflight is unavailable; deployment stopped.");
    await verifyTursoBeforeDeployment({
      configuration: desiredData,
      region: context.env.REGION ?? "",
      run: (args) => run(context, "aws", args),
      probe: context.io.probeTurso,
      now: context.io.now(),
      output: context.io.stdout,
    });
  }
}

async function selectInstallation(context: Context): Promise<Context> {
  const layout = await selectCloudInstallation({
    environment: context.env.CDK_PARAM_ENVIRONMENT ?? "development",
    account: context.env.ACCOUNT_ID ?? "",
    region: context.env.REGION ?? "",
    explicitLayout: context.env.TENKACLOUD_STACK_LAYOUT,
    run: (args) => run(context, "aws", args),
  });
  return {
    ...context,
    stacks: cloudStackNames(context.env.CDK_PARAM_ENVIRONMENT ?? "development", layout),
    env: { ...context.env, TENKACLOUD_STACK_LAYOUT: layout },
  };
}
async function resolvedInstallation(context: Context): Promise<Context> {
  return selectInstallation(await resolveCloudContext(context));
}
async function verifyDeploymentCompatibility(
  context: Context,
  deployed: readonly OwnedPlatformStack[],
): Promise<{ readonly stacks: OwnedPlatformStack[]; readonly original: readonly string[] }> {
  const verified: OwnedPlatformStack[] = [];
  const original: string[] = [];
  for (const stack of deployed) {
    const template = await run(context, "aws", [
      "cloudformation",
      "get-template",
      "--stack-name",
      stack.arn,
      "--region",
      context.env.REGION ?? "",
      "--output",
      "json",
    ]);
    assertSuccess(template, `Inspect resource compatibility for ${stack.name}`);
    const historical = assertCompatibleStack(stack, template.stdout);
    if (historical) original.push(stack.arn);
    verified.push(
      historical
        ? {
            ...stack,
            outputs: {
              ...stack.outputs,
              CloudControlDataBackend: historical.kind,
              ...(historical.kind === "turso"
                ? {
                    TursoDatabaseUrl: historical.databaseUrl,
                    TursoAuthTokenParameterName: historical.authTokenParameterName,
                  }
                : {}),
            },
          }
        : stack,
    );
  }
  return { stacks: verified, original };
}

async function confirmOriginalUpgrade(
  context: Context,
  original: readonly string[],
  noActiveEventsConfirmed: boolean,
): Promise<void> {
  if (original.length === 0) return;
  const warning = `Original installation detected:\n${original.join("\n")}\nResource IDs match, but original event records do not prove their execution catalog. Updating during an active competition can stop scoring and problem access. Complete all competitions with the installed version before this initial upgrade. Historical data is not automatically migrated, and a configured legacy catalog key alone is not proof of a safe running-event upgrade.`;
  context.io.stdout(`[cloud] ${warning}\n`);
  if (noActiveEventsConfirmed) {
    context.io.stdout(
      "[cloud] Operator explicitly confirmed that no active competitions remain.\n",
    );
    return;
  }
  if (
    await context.io.confirm(
      "Have you verified that all competitions are complete and no active event needs this installation before upgrading? [y/N] ",
    )
  )
    return;
  throw new Error(
    'Original installation upgrade paused before bootstrap, source upload or deployment. Keep active competitions on the installed version. After verifying that none remain, rerun make deploy and confirm; noninteractive execution requires CLOUD_ARGS="--confirm-no-active-events". No resources were changed.',
  );
}
async function up(context: Context, noActiveEventsConfirmed: boolean): Promise<number> {
  const desiredData = cloudControlDataConfiguration(context.env);
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
    throw new Error(
      "TENKACLOUD_RUNNER_BINDINGS belongs to the incompatible cloud-v1 runner. Use a separate environment with the restored competition backend, and register competitor accounts in its organizer console. No resources were changed.",
    );
  context.io.stdout(
    `[cloud] Deploying the competition backend with event, account, deployment and scoring services backed by ${desiredData.kind === "turso" ? "Turso" : "DynamoDB"}. AWS usage and retained storage can incur charges.\n`,
  );

  const resolved = await resolvedInstallation(context);
  context.io.stdout(
    `[cloud] Deployment target: account ${resolved.env.ACCOUNT_ID}, region ${resolved.env.REGION}, environment ${resolved.env.CDK_PARAM_ENVIRONMENT}. make deploy uses automatic CDK approval and creates standard CDKToolkit only when missing.\n`,
  );
  const operatorInstructions = `Use your intended AWS profile with permission to deploy through the existing standard CDKToolkit and administer the TenkaCloud application. Existing toolkit policies, trust and permissions boundaries are not changed. Review CDK's deployment output for required permissions, then rerun make deploy ENV=${resolved.env.CDK_PARAM_ENVIRONMENT}.`;
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
  const verified = await verifyDeploymentCompatibility(resolved, deployed);
  await validateDeploymentData(resolved, desiredData, verified.stacks);
  await confirmOriginalUpgrade(resolved, verified.original, noActiveEventsConfirmed);
  await setupCloudToolkit({ cwd: resolved.root, env: resolved.env }, context.io, true, "deploy");
  context.io.stdout(
    "[cloud] [1/3] Building applications and preparing the CodeBuild source bundle\n",
  );
  const prepared = { ...resolved, env: await prepareCloudSourceBundle(resolved, context.io) };
  context.io.stdout("[cloud] [2/3] Deploying cloud application and backend stacks\n");
  assertSuccess(
    await cdk(prepared, [
      "deploy",
      resolved.stacks.backend,
      resolved.stacks.app,
      "--require-approval",
      "never",
    ]),
    `CDK deploy. ${operatorInstructions}`,
  );
  context.io.stdout("[cloud] [3/3] Preparing organizer sign-in and access URLs\n");
  await ensureOrganizer(resolved, email);
  const consoleUrl = await output(resolved, resolved.stacks.app, "ApplicationAdminConsoleUrl");
  const portalUrl = await output(resolved, resolved.stacks.backend, "ParticipantPortalUrl");
  context.io.stdout(
    `Cloud competition hosting deployed.\nOrganizer console: ${consoleUrl}\nParticipant portal: ${portalUrl}\n`,
  );
  return 0;
}
/** Existing provider identity is never replaced by a changed local environment. */
function assertDataTransition(
  desired: CloudControlDataConfiguration,
  outputs: Readonly<Record<string, string>>,
): void {
  const kind = outputs.CloudControlDataBackend;
  if (kind !== "dynamodb" && kind !== "turso")
    throw new Error(
      "Existing backend provider is missing or unknown; deployment stopped before mutation.",
    );
  if (
    desired.kind !== kind ||
    (desired.kind === "turso" && desired.databaseUrl !== outputs.TursoDatabaseUrl)
  )
    throw new Error(
      "Changing the deployed cloud data backend or Turso database URL requires an explicit data migration or separate installation. No automatic data migration is performed; deployment stopped before mutation.",
    );
}
interface DownOptions {
  readonly yes: boolean;
  readonly purge: boolean;
  readonly plan: boolean;
}
async function down(context: Context, options: DownOptions): Promise<void> {
  const resolved = await resolvedInstallation(context);
  const stacks = await platformPreflight(resolved, "down");
  if (stacks.length === 0) {
    if (options.purge || options.plan)
      throw new Error(
        `Both platform stacks are absent; retained resource ownership cannot be proven. Use a previously saved physical-resource inventory for operator-reviewed recovery. For standalone Turso row cleanup, verify the selected database and existing SSM parameter, then use make turso-reset ENV=${context.env.ENV}.`,
      );
    context.io.stdout(
      "[cloud] Both platform stacks are already absent. No resources were changed.\n",
    );
    return;
  }
  const cleanup = await readCleanupPlan(resolved, stacks, options);
  if (options.plan) return;
  const storageStack =
    stacks.find((stack) => stack.name === resolved.stacks.backend) ??
    stacks.find((stack) => stack.name === resolved.stacks.app);
  const turso = planDeployedTursoTeardown(
    (storageStack && cleanup.storageOutputs[storageStack.arn]) ?? storageStack?.outputs ?? {},
    options.purge,
  );
  validateTursoPlan(turso, options.purge, context.io);
  const confirmation = teardownConfirmation(resolved, stacks, options, turso);
  context.io.stdout(`${confirmation}\n`);
  if (!options.yes && !(await context.io.confirm(`${confirmation} [y/N] `))) {
    context.io.stdout("Cloud teardown cancelled\n");
    return;
  }
  await emptyStackOwnedBuckets(cleanup, (args) => run(resolved, "aws", args), options.purge);
  if (options.purge) await purgeStackOwnedResources(cleanup, (args) => run(resolved, "aws", args));
  if (turso.kind === "purge") await resetTursoBeforeStackRemoval(resolved, turso.target);
  await deletePlatformStacks(resolved, stacks);
  if (options.purge) await finishTeardownLogs(resolved, cleanup);
  context.io.stdout(
    "Cloud platform stacks destroyed. Existing deployed Retain policies may leave chargeable resources; review the saved plan. This teardown removes external Turso rows only for explicit destroy-all when the deployed provider identity is verified.\n",
  );
}
async function finishTeardownLogs(context: Context, plan: TeardownPlan | undefined): Promise<void> {
  if (!plan) return;
  try {
    await purgeStackOwnedLogGroups(plan, (args) => run(context, "aws", args));
  } catch (error) {
    throw new Error(
      `Platform stacks were already removed, but final cleanup of their captured log groups failed. Use the saved physical-resource inventory for operator-reviewed recovery; removed stacks cannot provide a new ownership plan. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
async function readCleanupPlan(
  context: Context,
  stacks: readonly OwnedPlatformStack[],
  options: DownOptions,
): Promise<TeardownPlan> {
  const plan = await discoverTeardownPlan({
    account: context.env.ACCOUNT_ID ?? "",
    region: context.env.REGION ?? "",
    environment: context.env.CDK_PARAM_ENVIRONMENT ?? "development",
    stacks,
    run: (args) => run(context, "aws", args),
    bucketsOnly: !options.purge && !options.plan,
    purgeRetainedBuckets: options.purge,
  });
  showTeardownPlan(plan, context.io.stdout);
  if (options.purge && !options.plan) assertPurgeAllowed(plan);
  return plan;
}
function validateTursoPlan(plan: TursoTeardownPlan, purge: boolean, io: CloudCliIo): void {
  if (plan.kind === "unverified" && purge) throw new Error(plan.message);
  if (plan.kind === "warn" || plan.kind === "unverified") io.stdout(`${plan.message}\n`);
  if (plan.kind === "purge" && !io.purgeTursoControlData)
    throw new Error(
      "Turso reset is unavailable; purge stopped before mutation or losing SSM access.",
    );
}
async function resetTursoBeforeStackRemoval(
  context: Context,
  target: Omit<TursoResetTarget, "region">,
): Promise<void> {
  if (!context.io.purgeTursoControlData)
    throw new Error("Turso reset is unavailable; platform removal stopped.");
  try {
    await context.io.purgeTursoControlData({ ...target, region: context.env.REGION ?? "" });
  } catch (error) {
    throw new Error(
      `Turso control-data reset failed; AWS stack removal stopped to preserve SSM access. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
function teardownConfirmation(
  resolved: Context,
  stacks: readonly OwnedPlatformStack[],
  options: DownOptions,
  turso: TursoTeardownPlan,
): string {
  const consequences = `Destroy platform stacks in account ${resolved.env.ACCOUNT_ID}, region ${resolved.env.REGION}, environment ${resolved.env.CDK_PARAM_ENVIRONMENT}?\n${stacks.map((stack) => stack.arn).join("\n")}\nStack-owned DynamoDB tables and all rows, Cognito accounts, S3 objects, CloudFront distributions and managed logs are deleted under the default policy. Existing deployed Retain policies are honored; retained storage may continue to incur charges. ${options.purge ? "Additionally permanently purge the exact stack-owned tables, CloudWatch logs and S3 object versions/delete markers listed above, including retained data. Retain-policy bucket containers remain; only their contents are emptied. This cannot be undone. No deletion protection is changed. " : ""}Competition exercise resources are not cleaned up by this command; use the organizer console's deployment cleanup before removing its platform if needed. CDKToolkit, its shared assets, competitor bootstrap stacks/IAM roles and unrelated or separately deployed exercise resources are untouched.`;
  return (
    consequences +
    (turso.kind === "purge"
      ? ` Turso control-data rows in ${turso.target.databaseUrl} will also be permanently deleted before removing the AWS stacks; schema and migration state remain. Authentication uses the deployed SSM parameter ${turso.target.parameterName}.`
      : "")
  );
}
async function deletePlatformStacks(
  context: Context,
  stacks: readonly OwnedPlatformStack[],
): Promise<void> {
  // CDK assumes the standard deployment role, as the original Lite destroy did.
  // Its assembly pins the verified physical ARN and needs no application synth/assets.
  for (const name of [context.stacks.app, context.stacks.backend]) {
    const stack = stacks.find((candidate) => candidate.name === name);
    if (!stack) continue;
    const args = ["--stack-name", stack.arn, "--region", context.env.REGION ?? ""];
    if (stack.status === "DELETE_IN_PROGRESS") {
      // DescribeStacks was already authorized by preflight; do not issue another delete.
      assertSuccess(
        await run(context, "aws", ["cloudformation", "wait", "stack-delete-complete", ...args]),
        `Wait for ${name} deletion. Inspect CloudFormation failure events; no protection was modified`,
      );
      continue;
    }
    const assembly = context.io.createDestroyAssembly({
      name,
      arn: stack.arn,
      account: context.env.ACCOUNT_ID ?? "",
      region: context.env.REGION ?? "",
    });
    try {
      assertSuccess(
        await cdk(context, ["destroy", name, "--force"], assembly.directory),
        `Destroy ${name}. Inspect CloudFormation failure events. For retained or deletion-protected resources run make destroy ENV=${context.env.CDK_PARAM_ENVIRONMENT} CLOUD_ARGS="--plan"; changing source defaults does not change a deployed table. No protection was modified`,
      );
    } finally {
      assembly.dispose();
    }
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
async function resetSelectedDatabase(context: Context, args: readonly string[]): Promise<void> {
  const configuration = cloudControlDataConfiguration(context.env);
  if (configuration.kind !== "turso")
    throw new Error(
      "make turso-reset requires CDK_PARAM_CONTROL_DATA_BACKEND=turso in the selected environment.",
    );
  if (!context.io.resetSelectedTursoData)
    throw new Error("Standalone Turso reset is unavailable; no rows were deleted.");
  const resolved = await resolveCloudContext(context);
  await context.io.resetSelectedTursoData(
    {
      databaseUrl: configuration.databaseUrl,
      parameterName: configuration.authTokenParameterName,
      region: resolved.env.REGION ?? "",
      account: resolved.env.ACCOUNT_ID ?? "",
      environment: resolved.env.ENV ?? "development",
    },
    {
      plan: args.includes("--plan"),
      yes: args.some((arg) => ["--yes", "-y"].includes(arg)),
      confirm: context.io.confirm,
      output: context.io.stdout,
    },
  );
}
const HELP =
  'TenkaCloud cloud hosting\nUsage: make deploy ENV=development | make destroy ENV=development [CLOUD_ARGS="--yes"]\nHelp: make deploy CLOUD_ARGS="--help" | make destroy CLOUD_ARGS="--help"\nSource CLI: bun run --no-env-file scripts/cloud-hosting/main.ts <up|down|turso-reset|status|console-url|portal-url>\nSelect ENV or matching CDK_PARAM_ENVIRONMENT (default development). Samples exist for development, staging and production; custom lowercase environment names remain supported. Copy infrastructure/environments/<environment>/.env.example to .env in the same directory only if absent, then configure TENKACLOUD_ADMIN_EMAIL, ACCOUNT_ID and AWS_REGION. CDK_PARAM_CONTROL_DATA_BACKEND selects dynamodb (default) or turso; Turso also requires CDK_PARAM_TURSO_DATABASE_URL and CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME, naming an existing SSM SecureString. Existing deployments cannot switch data backends or database URLs without an explicit migration or separate installation. Published cloud-v1 resource/database layouts cannot be upgraded in place: use their matching release and a separate ENV/database for the restored competition backend. Source preparation builds both applications and uploads an environment-scoped source archive; the source bucket is outside CloudFormation ownership and remains after destroy. Exported variables override file values; AWS credentials come from your intended profile/role. make deploy reuses standard CDKToolkit unchanged; if missing, it explains the standard bootstrap IAM/resources, runs the pinned official cdk bootstrap aws://account/region and continues deployment. Standard bootstrap uses an AdministratorAccess CloudFormation execution role by default. Optional --show-setup prints the bootstrap plan and official template offline; --setup creates only a missing toolkit and never updates an existing one. As in the original deployment command, ordinary up uses automatic bootstrap and --require-approval never, including CI/noninteractive runs; no extra approval flag is required for new or already-restored installations. An original installation without catalog pins requires a one-time confirmation that all competitions are complete before any bootstrap or deployment; noninteractive upgrades require --confirm-no-active-events after verifying that condition. Generic --yes does not acknowledge it. Review the target and permissions before running it. Existing --yes/--setup-if-needed options remain accepted for compatibility; setup-only automation can use --setup --yes. down accepts --yes, --purge-retained-data (make destroy-all), --plan (read-only exact-resource/retention/protection inventory). --drain-events is unavailable because it belongs to the incompatible cloud-v1 intake model; use the matching old release for a cloud-v1 event drain before platform removal. Ordinary destroy does not require database access or application Outputs. Purge never disables deletion protection. Standalone make turso-reset ENV=development [CLOUD_ARGS="--plan|--yes"] uses the selected database URL and exact SSM SecureString even after AWS stacks are gone. It shows known tables and remaining deployment records, then confirms permanent row deletion; schema, migrations and unrelated tables remain. --plan only reads; unattended reset requires --yes. Stop application writers and complete exercise Teardown first. Compatibility alias: tenkacloud turso-live reset.\n';
function assertCommandArguments(command: string, args: readonly string[]): void {
  let permitted: readonly string[] = [];
  if (command === "up")
    permitted = [
      "--setup",
      "--show-setup",
      "--setup-if-needed",
      "--yes",
      "-y",
      "--confirm-no-active-events",
    ];
  if (command === "down")
    permitted = ["--yes", "-y", "--purge-retained-data", "--plan", "--drain-events"];
  if (command === "turso-reset") permitted = ["--yes", "-y", "--plan"];
  if (
    args.some((arg) => !permitted.includes(arg)) ||
    (command === "up" &&
      ((args.includes("--show-setup") && args.length !== 1) ||
        (args.includes("--setup") &&
          (args.includes("--setup-if-needed") || args.includes("--confirm-no-active-events")))))
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
      (["up", "down", "turso-reset"].includes(command) &&
        args.length === 1 &&
        ["--help", "-h"].includes(args[0] ?? ""))
    ) {
      io.stdout(HELP);
      return 0;
    }
    assertCommandArguments(command, args);
    const env = loadCloudEnvironment(options.root, options.env);
    io.configureEnvironment?.(env);
    const context: Context = {
      ...options,
      env,
      io,
      stacks: cloudStackNames(env.ENV),
    };
    switch (command) {
      case "up":
        if (context.env.TENKACLOUD_CFN_EXECUTION_POLICY_ARN !== undefined)
          throw new Error(
            "TENKACLOUD_CFN_EXECUTION_POLICY_ARN is obsolete and cannot be applied to standard CDKToolkit. Remove it from your exported variables and selected environment .env; manage any intentional bootstrap customization with the official CDK CLI separately. Existing toolkit configuration is preserved.",
          );
        if (args.includes("--show-setup")) {
          await showCloudToolkit({ cwd: context.root, env: context.env }, io);
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
        return await up(context, args.includes("--confirm-no-active-events"));
      case "down":
        if (args.includes("--drain-events"))
          throw new Error(
            "--drain-events requires the published cloud-v1 intake model and is unavailable in the restored backend. Use the matching published release to drain cloud-v1 events, or finish exercise cleanup in the organizer console before ordinary make destroy. No resources were changed.",
          );
        await down(context, {
          yes: args.some((arg) => ["--yes", "-y"].includes(arg)),
          purge: args.includes("--purge-retained-data"),
          plan: args.includes("--plan"),
        });
        return 0;
      case "turso-reset":
        await resetSelectedDatabase(context, args);
        return 0;
      case "status":
        return await status(await resolvedInstallation(context));
      case "console-url": {
        const resolved = await resolvedInstallation(context);
        io.stdout(`${await output(resolved, resolved.stacks.app, "ApplicationAdminConsoleUrl")}\n`);
        return 0;
      }
      case "portal-url": {
        const resolved = await resolvedInstallation(context);
        io.stdout(`${await output(resolved, resolved.stacks.backend, "ParticipantPortalUrl")}\n`);
        return 0;
      }
      default:
        throw new Error(`Unknown cloud command: ${command}`);
    }
  } catch (error) {
    io.stderr(`[cloud] ${cloudErrorMessage(error)}\n`);
    return 1;
  }
}

function cloudErrorMessage(error: unknown): string {
  if (error instanceof z.ZodError)
    return "AWS returned incomplete or malformed platform metadata. Inspect the selected stack state and retry; no success was assumed.";
  return error instanceof Error ? error.message : String(error);
}
