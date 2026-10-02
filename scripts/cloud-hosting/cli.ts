import { join } from "node:path";
import { z } from "zod";
import {
  type CloudControlDataConfiguration,
  cloudControlDataConfiguration,
} from "../../infrastructure/lib/cloud-hosting/config";
import { assertCommercialRegion } from "../../infrastructure/lib/cloud-hosting/regions";
import { cloudStackNames } from "../../infrastructure/lib/cloud-hosting/stack-names";
import { contentDigest } from "../../infrastructure/lib/problem-deploy/control-data/domain/deployment-work";
import type { CloudTableNames } from "../../infrastructure/lib/problem-deploy/control-data/dynamodb-cloud-repository";
import type { InstallationScope } from "../../infrastructure/lib/problem-deploy/control-data/installation-control";
import { parseRunnerBindings } from "../../infrastructure/lib/problem-deploy/handlers/cloud-api/execution-config";
import { STANDARD_TOOLKIT_STACK } from "./bootstrap-check";
import {
  assertPurgeAllowed,
  discoverTeardownPlan,
  purgeStackOwnedLogGroups,
  purgeStackOwnedResources,
  showTeardownPlan,
  type TeardownPlan,
} from "./complete-teardown";
import { cloudEnvironmentInstructions, loadCloudEnvironment } from "./environment";
import { canRecoverCreation, type PlatformStack } from "./failed-creation";
import {
  type CloudInstallation,
  drainInstallation,
  type InstallationLocation,
} from "./installation";
import type { CloudCliIo, ProcessResult } from "./process";
import { setupCloudToolkit, showCloudToolkit } from "./setup";
import { assertOwnedStack, assertRunnerChange, isMissingStack } from "./stack-check";
import { verifyTursoBeforeDeployment } from "./turso-preflight";
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
    if (mode === "up") validateRunnerTransition(context, name, result.stdout);
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
async function validateDeploymentData(
  context: Context,
  desiredData: CloudControlDataConfiguration,
  backend: OwnedPlatformStack | undefined,
): Promise<void> {
  const location = backend
    ? deployedInstallationLocation(backend, context.env.REGION ?? "")
    : undefined;
  if (location) assertDataTransition(desiredData, location);
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
  if (location) {
    const installation = await context.io.openInstallation(location);
    try {
      await installation.repository.assertAcceptingInstallation();
    } finally {
      installation.close();
    }
  }
}
async function up(
  context: Context,
  setupApproved: boolean,
  deploymentApproved: boolean,
): Promise<number> {
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
    parseRunnerBindings(context.env.TENKACLOUD_RUNNER_BINDINGS);
  context.io.stdout(
    `[cloud] Supported cloud exercises: hello-world with scoped participant AWS CLI access, and native Cryptography Battle backed by ${desiredData.kind === "turso" ? "Turso" : "DynamoDB"}. AWS usage and retained storage can incur charges; see infrastructure/README.md for feature and capacity limits.\n`,
  );

  const resolved = await resolveCloudContext(context);
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
  await validateDeploymentData(
    resolved,
    desiredData,
    deployed.find((stack) => stack.name === context.stacks.backend),
  );
  await setupCloudToolkit(
    { cwd: resolved.root, env: resolved.env },
    context.io,
    setupApproved,
    "deploy",
  );
  context.io.stdout("[cloud] [1/3] Building both web applications for CDK asset publishing\n");
  await buildApplications(resolved);
  context.io.stdout("[cloud] [2/3] Deploying cloud application and backend stacks\n");
  assertSuccess(
    await cdk(resolved, [
      "deploy",
      context.stacks.backend,
      context.stacks.app,
      "--require-approval",
      deploymentApproved ? "never" : "broadening",
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
/** Deployed Outputs are authoritative; local edits never select an existing installation's data. */
function deployedInstallationLocation(
  backend: OwnedPlatformStack,
  region: string,
): InstallationLocation {
  const kind = backend.outputs.CloudControlDataBackend;
  if (kind === "turso") {
    const selected = cloudControlDataConfiguration({
      CDK_PARAM_CONTROL_DATA_BACKEND: "turso",
      CDK_PARAM_TURSO_DATABASE_URL: backend.outputs.TursoDatabaseUrl,
      CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME: backend.outputs.TursoAuthTokenParameterName,
    });
    if (selected.kind !== "turso") throw new Error("Invalid deployed Turso provider identity.");
    return {
      region,
      backend: "turso",
      turso: {
        databaseUrl: selected.databaseUrl,
        authTokenParameterName: selected.authTokenParameterName,
      },
    };
  }
  if (kind && kind !== "dynamodb")
    throw new Error("Unknown deployed cloud data backend; no resources were changed.");
  // Older current-cloud stacks emitted only these three owned physical names.
  return { region, backend: "dynamodb", tables: installationTables(backend) };
}
function assertDataTransition(
  desired: CloudControlDataConfiguration,
  deployed: InstallationLocation,
): void {
  if (
    desired.kind !== deployed.backend ||
    (desired.kind === "turso" && desired.databaseUrl !== deployed.turso?.databaseUrl)
  )
    throw new Error(
      "Changing the deployed cloud data backend or Turso database URL requires an explicit data migration or separate installation. No automatic data migration is performed; deployment stopped before mutation.",
    );
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
interface DownOptions {
  readonly yes: boolean;
  readonly purge: boolean;
  readonly plan: boolean;
  readonly drain: boolean;
}
async function down(context: Context, options: DownOptions): Promise<void> {
  const resolved = await resolveCloudContext(context);
  const stacks = await platformPreflight(resolved, "down");
  if (stacks.length === 0) {
    if (options.purge || options.plan)
      throw new Error(
        "Both platform stacks are absent; retained resource ownership cannot be proven. Use a previously saved physical-resource inventory for operator-reviewed recovery.",
      );
    context.io.stdout(
      "[cloud] Both platform stacks are already absent. No resources were changed.\n",
    );
    return;
  }
  const cleanup = await readCleanupPlan(resolved, stacks, options);
  if (options.plan) return;
  const backend = stacks.find((stack) => stack.name === resolved.stacks.backend);
  const turso = planDeployedTursoTeardown(
    (backend && cleanup?.storageOutputs[backend.arn]) ?? backend?.outputs ?? {},
    options.purge,
  );
  validateTursoPlan(turso, options.purge, context.io);
  const confirmation = teardownConfirmation(resolved, stacks, options, turso);
  context.io.stdout(`${confirmation}\n`);
  if (!options.yes && !(await context.io.confirm(`${confirmation} [y/N] `))) {
    context.io.stdout("Cloud teardown cancelled\n");
    return;
  }
  if (options.drain) await drainPlatformInstallation(resolved, stacks);
  if (cleanup) await purgeStackOwnedResources(cleanup, (args) => run(resolved, "aws", args));
  if (turso.kind === "purge") await resetTursoBeforeStackRemoval(resolved, turso.target);
  await deletePlatformStacks(resolved, stacks);
  await finishTeardownLogs(resolved, cleanup);
  context.io.stdout(
    "Cloud platform stacks destroyed. Existing deployed Retain policies may leave chargeable resources; review the saved plan. External Turso rows are removed only by explicit destroy-all when the deployed provider identity is verified.\n",
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
): Promise<TeardownPlan | undefined> {
  if (!options.purge && !options.plan) return undefined;
  const plan = await discoverTeardownPlan({
    account: context.env.ACCOUNT_ID ?? "",
    region: context.env.REGION ?? "",
    environment: context.env.CDK_PARAM_ENVIRONMENT ?? "development",
    stacks,
    run: (args) => run(context, "aws", args),
  });
  showTeardownPlan(plan, context.io.stdout);
  if (!options.plan) assertPurgeAllowed(plan);
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
  target: { readonly databaseUrl: string; readonly parameterName: string },
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
  const consequences = `Destroy platform stacks in account ${resolved.env.ACCOUNT_ID}, region ${resolved.env.REGION}, environment ${resolved.env.CDK_PARAM_ENVIRONMENT}?\n${stacks.map((stack) => stack.arn).join("\n")}\nStack-owned DynamoDB tables and all rows, Cognito accounts, S3 objects, CloudFront distributions and managed logs are deleted under the default policy. Existing deployed Retain policies are honored; retained storage may continue to incur charges. ${options.purge ? "Additionally permanently purge the exact stack-owned tables and CloudWatch logs listed above, including retained data. This cannot be undone. No deletion protection is changed. " : ""}${options.drain ? "First stop new competition work and remove recorded event exercise resources using their stored ownership records. " : "Competition exercise resources are not cleaned up by this command; use each event's Teardown action before removing its platform if needed. "}CDKToolkit, its shared assets, competitor bootstrap stacks/IAM roles and unrelated or separately deployed exercise resources are untouched.`;
  return (
    consequences +
    (turso.kind === "purge"
      ? ` Turso control-data rows in ${turso.target.databaseUrl} will also be permanently deleted before removing the AWS stacks; schema and migration state remain. Authentication uses the deployed SSM parameter ${turso.target.parameterName}.`
      : "")
  );
}
async function drainPlatformInstallation(
  context: Context,
  stacks: readonly OwnedPlatformStack[],
): Promise<void> {
  const backend = stacks.find((stack) => stack.name === context.stacks.backend);
  if (!backend)
    throw new Error(
      "Backend is missing; explicit event drain cannot verify its stored work. Ordinary make destroy does not require event drain.",
    );
  const installation = await context.io.openInstallation({
    ...deployedInstallationLocation(backend, context.env.REGION ?? ""),
    native: nativeInstallationArtifacts(context, stacks),
  });
  try {
    await drainInstallation(
      installation,
      await teardownScope(context, stacks, installation),
      context.io,
    );
  } finally {
    installation.close();
  }
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
const HELP =
  'TenkaCloud cloud hosting\nUsage: make deploy ENV=development | make destroy ENV=development [CLOUD_ARGS="--yes"]\nHelp: make deploy CLOUD_ARGS="--help" | make destroy CLOUD_ARGS="--help"\nSource CLI: bun run --no-env-file scripts/cloud-hosting/main.ts <up|down|status|console-url|portal-url>\nSelect ENV or matching CDK_PARAM_ENVIRONMENT (default development). Samples exist for development, staging and production; custom lowercase environment names remain supported. Copy infrastructure/environments/<environment>/.env.example to .env in the same directory only if absent, then configure TENKACLOUD_ADMIN_EMAIL, ACCOUNT_ID and AWS_REGION. CDK_PARAM_CONTROL_DATA_BACKEND selects dynamodb (default) or turso; Turso also requires CDK_PARAM_TURSO_DATABASE_URL and CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME, naming an existing SSM SecureString. Existing deployments cannot switch data backends or database URLs without an explicit migration or separate installation. Exported variables override file values; AWS credentials come from your intended profile/role. make deploy reuses standard CDKToolkit unchanged; if missing, it explains the standard bootstrap IAM/resources, asks for separate consent, runs the pinned official cdk bootstrap aws://account/region and continues deployment. Standard bootstrap uses an AdministratorAccess CloudFormation execution role by default. Optional --show-setup prints the bootstrap plan and official template offline; --setup creates only a missing toolkit and never updates an existing one. Interactive deployment keeps CDK security-change approval (broadening). --yes explicitly approves security changes for the selected application deployment; it never alone approves initial bootstrap. Unattended first deployment requires CLOUD_ARGS="--setup-if-needed --yes" after reviewing --show-setup. down accepts --yes, --purge-retained-data (make destroy-all), --plan (read-only exact-resource/retention/protection inventory), and --drain-events (explicitly stop intake and remove recorded competition exercise resources before platform removal). Ordinary destroy does not require database access or application Outputs. Purge never disables deletion protection.\n';
function assertCommandArguments(command: string, args: readonly string[]): void {
  let permitted: readonly string[] = [];
  if (command === "up") permitted = ["--setup", "--show-setup", "--setup-if-needed", "--yes", "-y"];
  if (command === "down")
    permitted = ["--yes", "-y", "--purge-retained-data", "--plan", "--drain-events"];
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
        return await up(
          context,
          args.includes("--setup-if-needed") && args.some((arg) => ["--yes", "-y"].includes(arg)),
          args.some((arg) => ["--yes", "-y"].includes(arg)),
        );
      case "down":
        await down(context, {
          yes: args.some((arg) => ["--yes", "-y"].includes(arg)),
          purge: args.includes("--purge-retained-data"),
          plan: args.includes("--plan"),
          drain: args.includes("--drain-events"),
        });
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
    io.stderr(`[cloud] ${cloudErrorMessage(error)}\n`);
    return 1;
  }
}

function cloudErrorMessage(error: unknown): string {
  if (error instanceof z.ZodError)
    return "AWS returned incomplete or malformed platform metadata. Inspect the selected stack state and retry; no success was assumed.";
  return error instanceof Error ? error.message : String(error);
}
